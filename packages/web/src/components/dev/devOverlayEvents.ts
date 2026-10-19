export const SHOW_LOCAL_DEV_TOOLS_EVENT = "raft:show-local-dev-tools";
export const HIDE_LOCAL_DEV_TOOLS_EVENT = "raft:hide-local-dev-tools";

/**
 * Permission-driven hides must not consume the user's one-session hide. That
 * distinction lets a role change back to owner/admin restore the tools while
 * still honoring the explicit "hide until reload" action in the panel.
 */
export type LocalDevToolsEventReason = "permission" | "user";

export interface LocalDevToolsEventDetail {
  reason?: LocalDevToolsEventReason;
}
