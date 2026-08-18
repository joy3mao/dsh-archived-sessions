# dsh-archived-sessions

<div align="center">

[🇺🇸 **English**](README.md) ・ [🇨🇳 **中文**](README.zh-CN.md)

</div>

---

Archived-session manager plugin (DeepSeek Harness / dsh web shell user plugin).

Adds an "Archived" section to the sidebar's bottom panel below the workspace area, listing all archived sessions grouped by workspace. Each session row behaves like the workspace list: hovering reveals a "…" button that opens an action menu with two actions:

- **Restore** — restores the session to its workspace (keeping its original position), the inverse of the built-in "Archive";
- **Delete** — permanently deletes the session (log file + registry index + workspace slot + archive flag; unrecoverable), shown as a red danger item with a confirmation modal.

> ℹ️ This directory is the plugin source. If you haven't installed it yet, follow the "Installation" steps below; if already installed, re-run `dsh plugin add` (the `file:` dependency refreshes) and restart `dsh web` to upgrade.

## UI design & trade-offs

The DSH client UI slot system exposes only 3 slots on the sidebar shell: `sidebar.workspaces` (fully occupied by the built-in workspace browser), `sidebar.settings`, and `sidebar.footer.action` (a list slot rendered at the bottom of the sidebar, above the settings button). The workspace browser has no injectable regions, and its runtime components are not exported with the package, so no sub-sections can be inserted inside it.

This plugin therefore mounts the "Archived" section onto `sidebar.footer.action`:

![Screenshot](./snap.png)

- **Wide mode**: renders a collapsible "Archived" block below the workspace browsing region and above the settings row, listing archived sessions grouped by workspace (sessions not belonging to any workspace go under "Ungrouped"). Session rows reuse `@deepseek-ai/dsh-client-ui-primitives`'s `Menu`/`Modal`: hovering reveals a "…" (`IconEllipsisOutline16`) button, clicking opens a menu (Restore / Delete, Delete being a red `danger` item with `Modal` confirmation), matching the workspace session rows' interactions;
- **Rail mode** (sidebar collapsed): degrades to a single archive icon button that re-opens the sidebar on click.

## Installation

Installation = two steps: install the plugin into the profile (`dsh plugin add` adds this directory as a `file:` dependency in `~/.dsh/profiles/web/package.json`), then enable it in `cordis.patch.yml`.

**Option 1: Install from Git (recommended)**

```bash
dsh plugin --profile web add github:joy3mao/dsh-archived-sessions
```

**Option 2: Install from a local directory**

```bash
dsh plugin --profile web add /file-path/dsh-archived-sessions
```

Then append the following at the end of `~/.dsh/profiles/web/cordis.patch.yml` (format: see `cordis.patch.example.yml` in the same directory):

```yaml
- insert:
    # Archived-session manager: sidebar footer section with restore/delete.
    - id: archived-sessions
      name: 'dsh-archived-sessions'
```

Restart `dsh web` (or trigger HMR) for it to take effect. To uninstall: remove both of the above and run `dsh plugin --profile web remove dsh-archived-sessions`.

## How it works

### Host (`lib/index.js`)

- Mounts a **dedicated channel** via `ctx.connection.rpc.handle('/archived', ...)` (`authority: 'trusted-host'` — only accepts requests from connected web clients), serving two endpoints:
  - `restore` — removes the session from the workspace domain's `archivedSessionIds`.
  - `delete` — permanently deletes.
- Why not the shared `/api`: the `/api` channel is owned by `dsh-api-gateway` (its interceptor dispatches every built-in RPC), and Connection exposes only ONE `/api` interceptor; `rpc.handle` mounts a private channel that never collides with the gateway.
- **Restore** goes through `WorkspaceRegistry.enqueueOperation → setState`: it shares the same write serialization as the built-in archive (`operationTail` serialization + `recoverPendingMutation` replay). `setState` persists first (`domain.global.set`) then refreshes the registry's in-memory cache, and naturally emits `domain/changed` → the host stream broadcasts `host/archived-sessions-changed`, updating clients in real time — **no private-field hacks needed**.
- **Delete** runs in order:
  1. If the session is still attached to the in-memory `SessionStore` (`ctx.sessions.get(id)` hits) → refuse (`internal` error). The harness has no session-destruction API; deleting a running session's log file would corrupt its next append;
  2. Remove persisted artifacts: `sessionPersistence.locate()` finds `session.jsonl(.zstd)`, also cleaning the twin file with the other compression suffix, and removing the directory too once it is empty;
  3. Clear the registry's in-memory indexes (`headers` / `sessionPaths` / `invalidSessionPaths`), so lookups like `sessionKnown` definitely miss;
  4. Remove the session from its owning workspace's `sessionIds` slot (`WorkspaceEntity.detachSession`, persisted and broadcasting `host/workspace-changed`);
  5. Remove it from `archivedSessionIds` (same write serialization as restore).

## Known limitations

1. **Running sessions cannot be deleted**: deletion is refused while `agent.phase.kind !== 'idle'` (running / maintenance) — this is the safety floor, since deleting a file whose log is being written would corrupt the write path. **Idle** archived sessions (the common "archive then delete" case) are flushed, detached from memory, and then deleted normally. Attempting to delete a running session yields an explicit error message.
2. **Persistence residue**: deletion only cleans the session log file and its directory; if independent storage such as projection caches or telemetry appears later, it must be extended separately (no independent residue files were found in this version).
3. **`registry.headers` and other in-memory indexes + `ctx.sessions.store` are internal fields**: the delete flow directly `.delete()`s registry indexes and calls `detach()` on the `SessionStore.store` entry (triggering `session/disposed` → persistence write-controller retire), depending on the current `dsh-workspace` / `dsh-session` field names — a fragile point; the restore flow goes entirely through public APIs and has no such issue.
4. **Dedicated `/archived` channel**: the plugin mounts its own HTTP channel, loaded/unloaded with the plugin fiber; no conflict with `dsh-api-gateway`'s `/api`.
5. **Rail mode** only provides an entry button (expands the sidebar), no list rendering.
