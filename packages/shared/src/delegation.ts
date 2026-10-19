import { z } from "zod";

const id = z.string().min(1).max(200);
const text = z.string().min(1).max(800);
export const delegationRequirementsSchema = z.object({
  mode: z.enum(["delegated", "delegate_required"]).default("delegated"),
  requiredCapabilities: z.array(id).max(31).default([]),
}).strict().transform((value) => ({ ...value, requiredCapabilities: [...new Set(["workspace.write", ...value.requiredCapabilities])].sort() }));
export const delegationContractSchema = z.object({
  version: z.literal(1), taskId: id, runId: id, attemptId: id, workerId: id,
  mode: z.enum(["delegated", "delegate_required"]),
  resource: z.object({ id, revision: z.number().int().positive(), root: z.string().min(1).max(4096) }).strict(),
  requiredCapabilities: z.array(id).max(32),
}).strict();
export type DelegationContract = z.infer<typeof delegationContractSchema>;
export interface DelegationCapabilities {
  adapter: string;
  observedAt: string;
  enforcement: "advisory" | "hard" | "unsupported";
  capabilities: Record<string, "supported" | "denied" | "unavailable" | "unknown">;
}
export function delegationCapabilityBlocker(contract: DelegationContract, evidence: DelegationCapabilities): string | null {
  if (contract.mode === "delegate_required" && evidence.enforcement !== "hard") return "delegation_enforcement_unsupported";
  for (const capability of contract.requiredCapabilities) {
    const state = evidence.capabilities[capability] ?? "unknown";
    if (state !== "supported") return `capability_${state}:${capability}`;
  }
  return null;
}
const checkpointSchema = z.object({ id, stateFingerprint: text, completed: z.array(text).max(8), remaining: z.array(text).min(1).max(8) }).strict();
export const delegationOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(1), kind: z.literal("completed"), summary: text }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("failed"), summary: text }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("cancelled"), summary: text }).strict(),
  z.object({
    version: z.literal(1), kind: z.literal("needs_operation"), summary: text,
    operation: z.object({ capability: id, description: text, reason: z.enum(["policy_denied", "unavailable", "authentication", "path", "unknown"]) }).strict(),
    checkpoint: checkpointSchema,
  }).strict(),
]);
export type DelegationOutcome = z.infer<typeof delegationOutcomeSchema>;
export const delegationContinuationSchema = z.object({ previousAttemptId: id, checkpointId: id, workerId: id, receipt: text, checkpoint: checkpointSchema }).strict();
export type DelegationContinuation = z.infer<typeof delegationContinuationSchema>;
export const delegationRecordSchema = z.object({
  version: z.literal(1), contract: delegationContractSchema, outcome: delegationOutcomeSchema.optional(), continuation: delegationContinuationSchema.optional(),
}).strict();
export type DelegationRecord = z.infer<typeof delegationRecordSchema>;
/** A model turn ending is not an accepted result. No prose/markdown fallback. */
export function parseDelegationOutcome(output: string): DelegationOutcome {
  const marker = "RAFT_DELEGATION_RESULT=";
  const finalLine = output.trim().split(/\r?\n/).at(-1) ?? "";
  return delegationOutcomeSchema.parse(JSON.parse(finalLine.startsWith(marker) ? finalLine.slice(marker.length) : output));
}
export function assertDelegationContinuation(previous: DelegationRecord, next: DelegationRecord): void {
  const a = previous.contract, b = next.contract, receipt = next.continuation;
  if (previous.outcome?.kind !== "needs_operation" || !receipt
    || receipt.previousAttemptId !== a.attemptId || receipt.checkpointId !== previous.outcome.checkpoint.id
    || JSON.stringify(receipt.checkpoint) !== JSON.stringify(previous.outcome.checkpoint)
    || receipt.workerId !== a.workerId || b.workerId !== a.workerId
    || a.attemptId === b.attemptId || a.taskId !== b.taskId || a.runId !== b.runId
    || a.resource.id !== b.resource.id || a.resource.revision !== b.resource.revision || a.resource.root !== b.resource.root
    || a.mode !== b.mode || JSON.stringify(a.requiredCapabilities) !== JSON.stringify(b.requiredCapabilities)) {
    throw new Error("delegation_continuation_ownership_mismatch");
  }
}

/** Only a validated outcome can produce a reviewable contracted completion. */
export function resolveDelegationWorkerResult(output: string): { status: "succeeded" | "failed" | "cancelled" | "blocked"; detail: string; outcome?: DelegationOutcome } {
  try {
    const outcome = parseDelegationOutcome(output);
    return { status: outcome.kind === "completed" ? "succeeded" : outcome.kind === "needs_operation" ? "blocked" : outcome.kind, detail: outcome.summary, outcome };
  } catch {
    return { status: "failed", detail: "invalid_delegation_worker_result" };
  }
}

/** Daemon supports typed workspace delegation contracts and attempt-fenced outcomes; not hard coordinator enforcement. */
export const DAEMON_CAPABILITY_DELEGATION_V1 = "agent:workspace:delegation-v1";
