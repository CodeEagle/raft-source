import type { ServerRole } from "@botiverse/raft-shared";

/** Only server administrators may use local environment/debug tooling. */
export function canRenderEnvironmentDevTools(role: ServerRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}
