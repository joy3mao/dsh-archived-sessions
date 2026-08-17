/**
 * dsh-archived-sessions — host half.
 *
 * Mounts a dedicated RPC channel `/archived` (Connection `rpc.handle`) with
 * two endpoints:
 *
 *   `restore` — remove a session id from the workspace domain's
 *               `archivedSessionIds` set (durable, idempotent).
 *   `delete`  — permanently delete a session's persisted log, its registry
 *               bookkeeping, its workspace slot, and its archived-set entry.
 *
 * A dedicated channel is required because the shared `/api` channel is owned
 * by `dsh-api-gateway` (its interceptor dispatches every built-in RPC), and
 * Connection exposes only ONE `/api` interceptor. `rpc.handle` mounts a
 * private channel instead, so this plugin never collides with the gateway.
 *
 * Restore goes through the WorkspaceRegistry's own mutation serialization
 * (`enqueueOperation` + `setState`), so the durable domain write and the
 * in-memory registry cache stay consistent with every other registry writer
 * and the change automatically reaches clients through the existing
 * `host/archived-sessions-changed` broadcast.
 *
 * Delete refuses only while an agent is actively running (or in maintenance);
 * an idle-live session (the common "archive then delete" case — archiving
 * never detaches the in-memory session) is flushed, detached from the
 * SessionStore so its persistence controller retires, and its idle agent
 * voided, then the artifact is removed safely. Detaching pokes the
 * SessionStore's internal `store` entry (see README fragility note) because
 * the harness exposes no public session-disposal API.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

/** Plugin identity, matching the cordis entry name. */
export const name = 'dsh-archived-sessions';

/** Services this half needs at activation time. */
export const inject = ['connection', 'workspaceRegistry', 'sessionPersistence', 'sessions'];

/** Dedicated RPC channel prefix mounted by this plugin. */
const CHANNEL = '/archived';
/** Endpoints served on the channel (the channel itself namespaces them). */
const ENDPOINT_RESTORE = 'restore';
const ENDPOINT_DELETE = 'delete';

/** Successful RPC result (harness `{ ok: true, value }` envelope). */
const rpcOk = (value) => ({ ok: true, value });
/** Failed RPC result (harness `{ ok: false, error }` envelope). */
const rpcErr = (code, message, details) => ({ ok: false, error: { code, message, details } });

/**
 * Mount the dedicated `/archived` channel with its two endpoints.
 * @param ctx - plugin context carrying connection / workspaceRegistry / sessionPersistence / sessions.
 */
export function apply(ctx) {
	const registry = ctx.workspaceRegistry;
	if (registry.state === undefined) {
		throw new Error('dsh-archived-sessions: workspace registry is not started yet');
	}
	const remove = ctx.connection.rpc.handle(
		CHANNEL,
		(endpoint, payload, signal) => handleRpc(ctx, registry, endpoint, payload, signal),
		{ authority: 'trusted-host' },
	);
	// The channel registration belongs to the connection service's fiber; own
	// its disposer (return it from the effect body WITHOUT invoking it) so an
	// unload/HMR of THIS plugin also unregisters it.
	ctx.effect(() => remove, 'dsh-archived-sessions: /archived rpc channel');
}

/**
 * Route one validated request to the matching operation.
 * @param ctx - plugin context.
 * @param registry - the workspace registry service instance.
 * @param endpoint - the matched RPC endpoint name.
 * @param payload - the client-request payload (unknown shape until validated).
 * @param signal - optional abort signal from the HTTP request.
 * @returns a harness RpcResult.
 */
async function handleRpc(ctx, registry, endpoint, payload, signal) {
	signal?.throwIfAborted();
	const sessionId = payload?.sessionId;
	if (typeof sessionId !== 'string' || sessionId.length === 0) {
		return rpcErr('bad-request', 'sessionId is required', {
			issues: [{ path: ['sessionId'], message: 'expected a non-empty string' }],
		});
	}
	if (endpoint === ENDPOINT_RESTORE) return restoreArchived(ctx, registry, sessionId, signal);
	if (endpoint === ENDPOINT_DELETE) return deleteArchived(ctx, registry, sessionId, signal);
	return rpcErr('bad-request', `unsupported endpoint: ${endpoint}`, { issues: [] });
}

/**
 * `archived.restore` — un-archive a session (durable, idempotent).
 * @returns `{ restored: boolean, archivedSessionIds: string[] }`.
 */
async function restoreArchived(_ctx, registry, sessionId, signal) {
	signal?.throwIfAborted();
	const outcome = await registry.enqueueOperation(async () => {
		const state = registry.requireState();
		if (!state.archivedSessionIds.includes(sessionId)) {
			return { restored: false, archivedSessionIds: state.archivedSessionIds };
		}
		const next = {
			...state,
			archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
		};
		await registry.setState(next);
		return { restored: true, archivedSessionIds: next.archivedSessionIds };
	});
	return rpcOk(outcome);
}

/**
 * `archived.delete` — permanently delete one archived session: persisted log
 * artifacts, registry in-memory index entries, its workspace slot (durable,
 * broadcasting `host/workspace-changed`), and its archived-set entry (durable,
 * broadcasting `host/archived-sessions-changed`).
 *
 * Archiving never detaches the in-memory session, so a just-archived session
 * can still be live. Three cases are handled:
 *   - running/maintenance agent → refused (`internal`); deleting its artifact
 *     would corrupt the in-flight write path;
 *   - idle-live session → flushed, detached from the SessionStore (retiring
 *     its persistence controller), and its idle agent voided, then deleted;
 *   - cold session → deleted directly.
 * Sessions that were never persisted (no header) are still cleaned from the
 * accounting surfaces.
 *
 * @returns `{ deleted: boolean, removedArtifacts: boolean, archivedSessionIds: string[] }`.
 */
async function deleteArchived(ctx, registry, sessionId, signal) {
	signal?.throwIfAborted();
	// Archiving only mutates the workspace domain set; it never detaches the
	// in-memory session. So an archived session can still be:
	//   - running/maintenance (an agent is actively appending events) → refuse;
	//   - idle-live (loaded but quiet) → flush, detach, then delete safely;
	//   - cold → delete directly.
	const agent = ctx.get('agents')?.get(sessionId);
	if (agent !== undefined && agent.phase?.kind !== 'idle') {
		return rpcErr('internal', '该会话正在运行，无法删除。请先停止对话后再删除。', {});
	}
	const liveSession = ctx.sessions.get(sessionId);
	if (liveSession !== undefined) {
		// Flush first so the durable log is complete, then detach the session
		// from the SessionStore (its `session/disposed` edge retires the
		// persistence write controller), and finally void the idle agent so it
		// can no longer append to the detached session. Only then is removing
		// the artifact safe from a later write-path resurrection.
		try {
			await ctx.sessionPersistence.coordinator?.flush?.(liveSession);
		} catch (error) {
			ctx.logger.warn(`[dsh-archived-sessions] flush before delete failed: ${String(error)}`);
		}
		detachLiveSession(ctx, sessionId);
		agent?.cancel?.({ kind: 'disposed' });
	}

	// 1. Remove the persisted log artifact(s) (jsonl + alternate compression
	//    suffix), pruning the session directory when it empties.
	let removedArtifacts = false;
	let header;
	try {
		const headers = await ctx.sessionPersistence.list();
		header = headers.find((candidate) => candidate.id === sessionId);
	} catch (error) {
		ctx.logger.warn(`[dsh-archived-sessions] sessionPersistence.list failed: ${String(error)}`);
	}
	if (header !== undefined) {
		try {
			const loc = ctx.sessionPersistence.locate(header);
			if (loc?.kind === 'jsonl') removedArtifacts = removeSessionArtifacts(loc.path);
		} catch (error) {
			ctx.logger.warn(`[dsh-archived-sessions] artifact removal for "${sessionId}" failed: ${String(error)}`);
		}
	}

	// 2. Drop the registry's in-memory index entries (sessionKnown /
	//    readSessionHeader must see a definite miss afterwards).
	registry.headers.delete(sessionId);
	registry.sessionPaths.delete(sessionId);
	registry.invalidSessionPaths.delete(sessionId);

	// 3. Remove the session from its owning workspace's slot (durable; emits
	//    domain/changed so the host stream broadcasts host/workspace-changed).
	//    Workspace records live in the domain `workspaces` table; the registry
	//    mirrors them as entities whose `record` is refreshed on each mutation.
	let ownerEntity;
	for (const entity of registry.entities.values()) {
		if (entity.record.sessionIds.includes(sessionId)) {
			ownerEntity = entity;
			break;
		}
	}
	if (ownerEntity !== undefined) await ownerEntity.detachSession(sessionId);

	// 4. Remove the session from the archived set (durable; broadcasts
	//    host/archived-sessions-changed). Runs through the registry's own
	//    serialization so it can never interleave with another mutation.
	const outcome = await registry.enqueueOperation(async () => {
		const state = registry.requireState();
		if (!state.archivedSessionIds.includes(sessionId)) {
			return { deleted: true, removedArtifacts, archivedSessionIds: state.archivedSessionIds };
		}
		const next = {
			...state,
			archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId),
		};
		await registry.setState(next);
		return { deleted: true, removedArtifacts, archivedSessionIds: next.archivedSessionIds };
	});
	return rpcOk(outcome);
}

/**
 * Detach one idle-live session from the host SessionStore, triggering the
 * `session/disposed` edge so the persistence write controller retires (flush
 * + live-state removal). This pokes the store's internal entry — see the
 * README fragility note. A no-op when the session is no longer attached.
 * @param ctx - plugin context carrying the `sessions` service.
 * @param sessionId - the session to detach.
 */
function detachLiveSession(ctx, sessionId) {
	const entry = ctx.sessions.store?.get(sessionId);
	entry?.detach?.();
}

/**
 * Delete a session's JSONL artifact on disk: the exact located path, its
 * twin under the other compression suffix (the session may have been written
 * before/after a compression config change), and the session directory once
 * it no longer holds any file.
 * @param locatedPath - absolute path returned by `sessionPersistence.locate()`.
 * @returns whether any artifact file was actually removed.
 */
function removeSessionArtifacts(locatedPath) {
	const candidates = new Set([locatedPath]);
	if (locatedPath.endsWith('.zstd')) candidates.add(locatedPath.slice(0, -'.zstd'.length));
	else candidates.add(`${locatedPath}.zstd`);
	let removedAny = false;
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			rmSync(candidate, { force: true });
			removedAny = true;
		}
	}
	const sessionDir = dirname(locatedPath);
	if (existsSync(sessionDir)) {
		try {
			if (readdirSync(sessionDir).length === 0) rmSync(sessionDir, { recursive: true, force: true });
		} catch {
			// The directory vanished or is busy meanwhile — nothing else to do.
		}
	}
	return removedAny;
}
