/**
 * dsh-archived-sessions — client half.
 *
 * Rendered as an entry of the sidebar's `sidebar.footer.action` list slot:
 * in wide mode it shows a collapsible "已归档" section at the bottom of the
 * left sidebar (below the workspace browsing region, above the settings
 * row); in rail mode it degrades to a compact icon that re-opens the
 * sidebar. The section lists archived sessions grouped by workspace and
 * offers two actions per session:
 *
 *   restore — calls the `restore` endpoint on the dedicated `/archived`
 *             channel; the session reappears in its workspace position. The
 *             host broadcast (`host/archived-sessions-changed`) refreshes the
 *             store, so no manual list refresh is needed.
 *   delete  — two-step confirm, then calls the `delete` endpoint on the same
 *             channel; on success the session is dropped from the client
 *             session list via `ctx.sessions.refresh()`.
 *
 * This file is a hand-written module-loader bundle (no build step): it calls
 * `window.__ModuleLoader__.load()` with the plugin id and a CommonJS factory,
 * mirroring the shape emitted by the harness's bundlers, so it can be served
 * as-is from the package `./client` export.
 */
window.__ModuleLoader__.load({
	id: "dsh-archived-sessions",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const {
			Button,
			IconArchiveOutline20,
			IconChevronDownOutline14,
			IconEllipsisOutline16,
			IconLoadingOutline16,
			IconRefreshOutline16,
			IconTrashOutline16,
			IconWarningOutline16,
			Menu,
			Modal
		} = require("@deepseek-ai/dsh-client-ui-primitives");

		//#region plugin identity & service declarations
		/** Plugin identity, matching the cordis entry name. */
		exports.name = "dsh-archived-sessions";
		/** Client services this half depends on (service names, not packages). */
		exports.inject = ["slots", "sessions", "workspaces", "connection", "locale", "layout"];

		/** Locale namespace for this plugin's copy. */
		const NS = "archived-sessions";
		//#endregion

		//#region styles
		/** <style> element id; guards against duplicate injection across HMR activations. */
		const CSS_ID = "dsh-archived-sessions-css";
		/** Section styles, token-driven so the section matches the shell theme. */
		const CSS_TEXT = [
			`.dsh-archived { width: 100%; min-width: 0; box-sizing: border-box; padding: 2px 8px 6px; }`,
			`.dsh-archived-head { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px 6px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #9a9aa5); font: inherit; cursor: pointer; }`,
			`.dsh-archived-head:hover, .dsh-archived-head[data-open="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, #e8e8ea); }`,
			`.dsh-archived-label { flex: 1; min-width: 0; text-align: left; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`,
			`.dsh-archived-count { font-size: 11px; color: var(--dsw-alias-label-dimmed, #777); }`,
			`.dsh-archived-chevron { transition: transform .15s var(--ds-ease-in-out, ease); }`,
			`.dsh-archived-chevron-open { transform: rotate(180deg); }`,
			`.dsh-archived-body { max-height: 320px; overflow-y: auto; border-top: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.18)); margin-top: 4px; padding-top: 4px; }`,
			`.dsh-archived-group-title { padding: 2px 6px; font-size: 11px; color: var(--dsw-alias-label-dimmed, #777); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`,
			`.dsh-archived-item { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: 6px; }`,
			`.dsh-archived-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }`,
			`.dsh-archived-item-title { flex: 1; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-primary, #e8e8ea); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`,
			`.dsh-archived-item-actions { flex: none; display: none; align-items: center; gap: 2px; }`,
			`.dsh-archived-item:hover .dsh-archived-item-actions, .dsh-archived-item[data-menu-open="true"] .dsh-archived-item-actions { display: inline-flex; }`,
			`.dsh-archived-icon-button { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: none; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-tertiary, #888); cursor: pointer; flex: none; }`,
			`.dsh-archived-icon-button:hover { color: var(--dsw-alias-label-primary, #e8e8ea); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }`,
			`.dsh-archived-loading { flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary, #888); }`,
			`.dsh-archived-item[data-busy="true"] .dsh-archived-item-title { opacity: .6; }`,
			`.dsh-archived-error { display: flex; align-items: flex-start; gap: 6px; margin: 4px 6px 0; padding: 4px 8px; border: 1px solid var(--dsw-alias-state-error-primary, #e5534b); border-radius: 6px; color: var(--dsw-alias-state-error-primary, #e5534b); font-size: 11px; word-break: break-word; }`,
			`.dsh-archived-empty { padding: 8px 6px; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-dimmed, #777); }`,
			`.dsh-archived-rail { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary, #9a9aa5); cursor: pointer; }`,
			`.dsh-archived-rail:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); color: var(--dsw-alias-label-primary, #e8e8ea); }`
		].join("\n");
		/** Inject the stylesheet once; later activations reuse the existing tag. */
		function installCss() {
			if (typeof document === "undefined") return;
			if (document.getElementById(CSS_ID) !== null) return;
			const style = document.createElement("style");
			style.id = CSS_ID;
			style.setAttribute("data-plugin", "dsh-archived-sessions");
			style.setAttribute("data-plugin-css", "dsh-archived-sessions");
			style.textContent = CSS_TEXT;
			document.head.appendChild(style);
		}
		//#endregion

		//#region locales
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"section.label": "已归档",
			"section.count": "{count} 个会话",
			"section.collapse": "收起已归档",
			"section.expand": "展开已归档",
			"section.empty": "暂无已归档会话",
			"section.emptyHint": "在工作区列表的会话右键菜单选择“归档”，会话会移到这里，并可在此恢复或彻底删除。",
			"ungrouped": "未分组",
			"session.unnamed": "未命名会话",
			"restore.label": "恢复",
			"delete.label": "删除",
			"delete.confirmTitle": "删除已归档会话？",
			"delete.confirmDesc": "会话「{name}」将被彻底删除，日志与记录不可恢复。",
			"confirm.yes": "删除",
			"confirm.no": "取消",
			"actions.aria": "会话操作",
			"error.title": "操作失败",
			"rail.title": "已归档会话（点击展开侧边栏）"
		};
		/** English dictionary. */
		const en = {
			"section.label": "Archived",
			"section.count": "{count} sessions",
			"section.collapse": "Collapse archived",
			"section.expand": "Expand archived",
			"section.empty": "No archived sessions",
			"section.emptyHint": "Choose “Archive” on a session's context menu in the workspace list to move it here; restore or delete it permanently from this section.",
			"ungrouped": "Ungrouped",
			"session.unnamed": "Untitled session",
			"restore.label": "Restore",
			"delete.label": "Delete",
			"delete.confirmTitle": "Delete archived session?",
			"delete.confirmDesc": "Session “{name}” will be permanently deleted; its log and records cannot be recovered.",
			"confirm.yes": "Delete",
			"confirm.no": "Cancel",
			"actions.aria": "Session actions",
			"error.title": "Operation failed",
			"rail.title": "Archived sessions (click to expand the sidebar)"
		};
		//#endregion

		//#region plugin body
		/** The live client context, captured at apply() and refreshed on re-activation. */
		let currentCtx = undefined;

		/**
		 * Client plugin body: register dictionaries, inject styles, and mount the
		 * section into the sidebar footer action list.
		 * @param ctx - client cordis context (slots/sessions/workspaces/connection/locale/layout).
		 */
		function apply(ctx) {
			currentCtx = ctx;
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-archived-sessions: locale dictionaries");
			installCss();
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "archived",
				order: 0,
				label: NS,
				locale: NS,
				inject: () => ({})
			}, ArchivedSection));
		}
		//#endregion

		//#region section component
		/**
		 * Small helpers.
		 */
		const el = react.createElement;
		const cx = (...parts) => parts.filter(Boolean).join(" ");
		const baseName = (value) => (typeof value === "string" ? value : "").split(/[\\/]/).pop();

		/**
		 * The archived-session manager rendered in the sidebar footer.
		 * Receives the standard root kit (`useSessions`, `useWorkspaces`, `t`)
		 * plus the owner prop `wide` (false when the sidebar is in rail mode).
		 */
		function ArchivedSection(props) {
			const { wide, useSessions, useWorkspaces, t } = props;
			const sessions = useSessions((snapshot) => snapshot);
			const workspaces = useWorkspaces((snapshot) => snapshot);
			const [open, setOpen] = react.useState(false);
			const [busy, setBusy] = react.useState(null);
			const [error, setError] = react.useState(null);
			const [confirmId, setConfirmId] = react.useState(null);
			const [menuOpen, setMenuOpen] = react.useState(null);

			const archivedIds = workspaces.archivedSessionIds ?? [];
			const sessionsById = react.useMemo(
				() => new Map((sessions.items ?? []).map((item) => [item.sessionId, item])),
				[sessions.items],
			);

			/** Archived ids grouped by owning workspace; leftover ids land in "ungrouped". */
			const groups = react.useMemo(() => {
				const result = [];
				const seen = new Set();
				for (const workspace of workspaces.items ?? []) {
					const members = (workspace.sessionIds ?? []).filter((id) => archivedIds.includes(id));
					if (members.length === 0) continue;
					for (const id of members) seen.add(id);
					result.push({ key: workspace.workspaceId, title: workspace.title, members });
				}
				const ungrouped = archivedIds.filter((id) => !seen.has(id));
				if (ungrouped.length > 0) result.push({ key: "__ungrouped__", title: t("ungrouped"), members: ungrouped });
				return result;
			}, [archivedIds, workspaces.items, t]);

			/** Display title for one archived session id. */
			const titleOf = (id) => {
				const item = sessionsById.get(id);
				if (item?.title) return item.title;
				if (item?.blank) return t("session.unnamed");
				if (item?.cwd) return baseName(item.cwd);
				return id;
			};

			/** Call the host `restore` endpoint on the dedicated `/archived` channel. */
			const restore = async (id) => {
				if (currentCtx === undefined) return;
				setBusy(id);
				setError(null);
				try {
					const result = await currentCtx.connection.rpc.call("/archived", "restore", { sessionId: id });
					if (result?.ok !== true) setError(result?.error?.message ?? String(result?.error));
				} catch (failure) {
					setError(String(failure?.message ?? failure));
				} finally {
					setBusy(null);
				}
			};

			/** Call the host `delete` endpoint, then drop the session from the local list. */
			const remove = async (id) => {
				if (currentCtx === undefined) return;
				setBusy(id);
				setError(null);
				try {
					const result = await currentCtx.connection.rpc.call("/archived", "delete", { sessionId: id });
					if (result?.ok !== true) {
						setError(result?.error?.message ?? String(result?.error));
						return;
					}
					setConfirmId(null);
					// The host broadcasts workspace/archived changes; the session
					// itself must be dropped from the local session list.
					currentCtx.sessions.refresh().catch(() => {});
				} catch (failure) {
					setError(String(failure?.message ?? failure));
				} finally {
					setBusy(null);
				}
			};

			// Rail mode: a compact archive icon that re-opens the sidebar.
			if (wide !== true) {
				return el("button", {
					type: "button",
					className: "dsh-archived-rail",
					title: t("rail.title"),
					"aria-label": t("rail.title"),
					onClick: () => {
						currentCtx?.layout.toggleSidebar();
					},
					children: el(IconArchiveOutline20, { size: 20 })
				});
			}

			const count = archivedIds.length;
			const toggle = () => setOpen((value) => !value);
			return el("div", { className: "dsh-archived" }, [
				el("button", {
					type: "button",
					key: "head",
					className: "dsh-archived-head",
					"data-open": open ? "true" : "false",
					title: open ? t("section.collapse") : t("section.expand"),
					"aria-expanded": open ? "true" : "false",
					onClick: toggle,
					children: [
						el(IconArchiveOutline20, { key: "icon", size: 16 }),
						el("span", { key: "label", className: "dsh-archived-label", children: t("section.label") }),
						el("span", { key: "count", className: "dsh-archived-count", children: t("section.count", { count }) }),
						el(IconChevronDownOutline14, { key: "chevron", size: 14, className: cx("dsh-archived-chevron", open && "dsh-archived-chevron-open") })
					]
				}),
				open && el("div", { key: "body", className: "dsh-archived-body" }, [
					error !== null && el("div", { key: "error", className: "dsh-archived-error" }, [
						el(IconWarningOutline16, { key: "w", size: 13, className: "dsh-archived-error-icon" }),
						el("span", { key: "m", children: `${t("error.title")}: ${error}` })
					]),
					groups.length === 0
						? el("div", { key: "empty", className: "dsh-archived-empty" }, [
							el("div", { key: "a", children: t("section.empty") }),
							el("div", { key: "b", children: t("section.emptyHint") })
						])
						: groups.map((group) => el("div", { key: group.key, className: "dsh-archived-group" }, [
							el("div", { key: "title", className: "dsh-archived-group-title", children: group.title }),
							group.members.map((id) => {
								const itemBusy = busy === id;
								return el("div", {
									key: id,
									className: "dsh-archived-item",
									"data-busy": itemBusy ? "true" : "false",
									"data-menu-open": menuOpen === id ? "true" : "false"
								}, [
									el("span", { key: "title", className: "dsh-archived-item-title", title: id, children: titleOf(id) }),
									el("span", { key: "actions", className: "dsh-archived-item-actions" }, [
										itemBusy
											? el("span", { key: "loading", className: "dsh-archived-loading", children: el(IconLoadingOutline16, { size: 16 }) })
											: el(Menu, {
												key: "menu",
												open: menuOpen === id,
												onClose: () => setMenuOpen(null),
												items: [
													{ id: "restore", label: t("restore.label"), icon: el(IconRefreshOutline16, { size: 14 }) },
													{ id: "delete", label: t("delete.label"), icon: el(IconTrashOutline16, { size: 14 }), danger: true }
												],
												onSelect: (actionId) => {
													setMenuOpen(null);
													if (actionId === "restore") restore(id);
													if (actionId === "delete") setConfirmId(id);
												},
												portal: true,
												closeOnPointerLeave: true,
												anchor: el("button", {
													type: "button",
													className: "dsh-archived-icon-button",
													"aria-label": t("actions.aria"),
													title: t("actions.aria"),
													onClick: (event) => {
														event.stopPropagation();
														setMenuOpen((current) => (current === id ? null : id));
													},
													children: el(IconEllipsisOutline16, { size: 16 })
												})
											})
									])
								]);
							})
						]))
				]),
				confirmId !== null && el(Modal, {
					key: "confirm-modal",
					open: true,
					onClose: () => setConfirmId(null),
					title: t("delete.confirmTitle"),
					description: t("delete.confirmDesc", { name: titleOf(confirmId) }),
					footer: [
						el(Button, { key: "cancel", variant: "outline", onClick: () => setConfirmId(null), children: t("confirm.no") }),
						el(Button, { key: "confirm", variant: "primary", onClick: () => remove(confirmId), children: t("confirm.yes") })
					]
				})
			]);
		}
		//#endregion

		exports.apply = apply;
		return module.exports;
	}
});
