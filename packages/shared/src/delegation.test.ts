import assert from "node:assert/strict";
import { test } from "vitest";
import { assertDelegationContinuation, delegationCapabilityBlocker, delegationRecordSchema, resolveDelegationWorkerResult, type DelegationRecord } from "./delegation";

const record: DelegationRecord = { version: 1, contract: { version: 1, taskId: "task", runId: "run", attemptId: "attempt", workerId: "worker", mode: "delegated", resource: { id: "resource", revision: 1, root: "/project" }, requiredCapabilities: ["workspace.write"] } };
const blocked = { version: 1 as const, kind: "needs_operation" as const, summary: "Commit blocked; tests remain", operation: { capability: "git.commit", description: "Commit this change", reason: "policy_denied" as const }, checkpoint: { id: "cp", stateFingerprint: "tree abc", completed: ["implemented"], remaining: ["verify commit"] } };
test("capability preflight distinguishes unknown, denied and unsupported hard enforcement", () => {
  const evidence = { adapter: "test", observedAt: "2026-10-19", enforcement: "advisory" as const, capabilities: { "workspace.write": "supported" as const } };
  assert.equal(delegationCapabilityBlocker(record.contract, evidence), null);
  assert.equal(delegationCapabilityBlocker({ ...record.contract, requiredCapabilities: ["docker.run"] }, evidence), "capability_unknown:docker.run");
  assert.equal(delegationCapabilityBlocker(record.contract, { ...evidence, capabilities: { "workspace.write": "denied" } }), "capability_denied:workspace.write");
  assert.equal(delegationCapabilityBlocker({ ...record.contract, mode: "delegate_required" }, evidence), "delegation_enforcement_unsupported");
});
test("worker blocked JSON is blocked, prose or invalid JSON cannot be reviewable", () => {
  assert.equal(resolveDelegationWorkerResult(JSON.stringify(blocked)).status, "blocked");
  assert.equal(resolveDelegationWorkerResult(`Progress output\nRAFT_DELEGATION_RESULT=${JSON.stringify(blocked)}`).status, "blocked");
  for (const output of ["Done", '{"version":1,"kind":"completed"}', JSON.stringify({ ...blocked, checkpoint: { ...blocked.checkpoint, remaining: [] } })]) assert.equal(resolveDelegationWorkerResult(output).status, "failed");
  assert.equal(resolveDelegationWorkerResult('{"version":1,"kind":"completed","summary":"Implemented and tested"}').status, "succeeded");
});
test("continuation retains worker, task, resource, scope and exact checkpoint", () => {
  const previous = { ...record, outcome: blocked };
  const next: DelegationRecord = { version: 1, contract: { ...record.contract, attemptId: "next" }, continuation: { previousAttemptId: "attempt", checkpointId: "cp", workerId: "worker", receipt: "Authorized operation completed", checkpoint: blocked.checkpoint } };
  assert.doesNotThrow(() => assertDelegationContinuation(previous, delegationRecordSchema.parse(next)));
  for (const contract of [{ ...next.contract, workerId: "other" }, { ...next.contract, taskId: "other" }, { ...next.contract, resource: { ...next.contract.resource, root: "/elsewhere" } }]) assert.throws(() => assertDelegationContinuation(previous, { ...next, contract }), /ownership_mismatch/);
  assert.throws(() => assertDelegationContinuation(previous, { ...next, continuation: { ...next.continuation!, checkpoint: { ...blocked.checkpoint, remaining: ["different"] } } }), /ownership_mismatch/);
});
