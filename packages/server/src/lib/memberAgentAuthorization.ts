import { and, eq, isNull } from "drizzle-orm";
import { isMemberOwnedComputer, type ServerRole } from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index";
import { computers, machines } from "../db/schema";

export type MemberAgentMachineAuthorizationCode =
  | "member_computer_required"
  | "member_computer_not_owned";

/** A member request tried to use a Computer outside its own attachment scope. */
export class MemberAgentMachineAuthorizationError extends Error {
  readonly code: MemberAgentMachineAuthorizationCode;

  constructor(code: MemberAgentMachineAuthorizationCode) {
    super(code === "member_computer_required"
      ? "Members must select a Computer attached by their own account"
      : "Members may use only a Computer attached by their own account");
    this.name = "MemberAgentMachineAuthorizationError";
    this.code = code;
  }
}
/**
 * Re-check a member's target machine after the caller membership row has been
 * locked. Owner/admin callers intentionally return without a relation check;
 * their existing server-wide capability remains authoritative.
 *
 * Lock order is caller membership → machine → Computer. Callers invoke this
 * inside their existing fenced transaction, so machine deletion/revocation
 * cannot race a member Agent write between the check and commit.
 */
export async function assertMemberAgentMachineAccess(
  executor: DatabaseExecutor,
  input: {
    serverId: string;
    userId: string;
    role: ServerRole;
    machineId: string | null | undefined;
  },
  options: { lockRows?: boolean } = {},
): Promise<void> {
  if (input.role !== "member") return;
  if (!input.machineId) {
    throw new MemberAgentMachineAuthorizationError("member_computer_required");
  }

  const machineQuery = executor
    .select({ id: machines.id, serverId: machines.serverId })
    .from(machines)
    .where(and(eq(machines.id, input.machineId), eq(machines.serverId, input.serverId)));
  const [machine] = options.lockRows === false
    ? await machineQuery
    : await machineQuery.for("update");
  if (!machine) {
    throw new MemberAgentMachineAuthorizationError("member_computer_not_owned");
  }

  const computerQuery = executor
    .select({ attachedByUserId: computers.attachedByUserId, machineId: computers.machineId })
    .from(computers)
    .where(and(
      eq(computers.serverId, input.serverId),
      eq(computers.machineId, input.machineId),
      eq(computers.attachedByUserId, input.userId),
      isNull(computers.revokedAt),
    ));
  const [computer] = options.lockRows === false
    ? await computerQuery
    : await computerQuery.for("update");
  if (!computer || !isMemberOwnedComputer({
    userId: input.userId,
    attachedByUserId: computer.attachedByUserId,
    machineId: computer.machineId,
  })) {
    throw new MemberAgentMachineAuthorizationError("member_computer_not_owned");
  }
}
