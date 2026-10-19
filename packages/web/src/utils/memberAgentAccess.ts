import type { ServerCapabilities, ServerRole } from "@botiverse/raft-shared";
import type { Machine } from "../store/machineStore";

/**
 * Member-owned Computer actions are intentionally separate from the
 * server-wide capability matrix. The matrix describes what a role may do in
 * general; these predicates add the per-Computer ownership boundary.
 */
export function canCreateAgentForRole(
  role: ServerRole | null | undefined,
  capabilities: Pick<ServerCapabilities, "createAgents">,
): boolean {
  return capabilities.createAgents || role === "member";
}

export function canRegisterMachineForRole(
  role: ServerRole | null | undefined,
  capabilities: Pick<ServerCapabilities, "registerMachines">,
): boolean {
  return capabilities.registerMachines || role === "member";
}

/** Computers a member is allowed to target while creating a new Agent. */
export function filterAgentCreationMachines<T extends Pick<Machine, "computerAttachedByCurrentUser">>(
  machines: readonly T[],
  role: ServerRole | null | undefined,
): readonly T[] {
  if (role !== "member") {
    return machines;
  }

  return machines.filter((machine) => machine.computerAttachedByCurrentUser === true);
}

/**
 * A member may manage only a Computer they attached themselves. Admin/owner
 * capabilities continue to cover server-wide machine management, but the
 * createAgents capability alone is never treated as machine management.
 */
export function canManageMachineForRole(
  machine: Pick<Machine, "computerAttachedByCurrentUser" | "creator">,
  currentUserId: string | null | undefined,
  role: ServerRole | null | undefined,
  capabilities: Pick<
    ServerCapabilities,
    | "editMachines"
    | "controlComputers"
    | "removeMachines"
    | "rotateMachineKeys"
    | "migrateAgents"
  >,
): boolean {
  if (machine.computerAttachedByCurrentUser === true) {
    return true;
  }

  if (currentUserId && machine.creator?.id === currentUserId) {
    return true;
  }

  if (role === "member") {
    return false;
  }

  return [
    capabilities.editMachines,
    capabilities.controlComputers,
    capabilities.removeMachines,
    capabilities.rotateMachineKeys,
    capabilities.migrateAgents,
  ].some(Boolean);
}
