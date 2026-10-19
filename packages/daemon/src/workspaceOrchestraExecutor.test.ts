import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { WorkspaceOrchestraExecutor } from "./workspaceOrchestraExecutor";
import { WorkspaceOrchestraStore, type EnqueueWorkspaceOrchestraJob } from "./workspaceOrchestraStore";

function input(workspacePath: string, overrides: Partial<EnqueueWorkspaceOrchestraJob> = {}): EnqueueWorkspaceOrchestraJob {
  return {
    id: "run-1",
    serverId: "server-1",
    machineId: "machine-1",
    channelId: "channel-1",
    agentId: "agent-1",
    taskId: "task-1",
    messageId: "message-1",
    workspaceId: "workspace-1",
    requestedPath: workspacePath,
    canonicalWorkspacePath: workspacePath,
    workspaceRevision: 1,
    instruction: "Implement the assigned task.",
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for workspace executor state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("executor reports starting, running, then reviewable completion through the independent runner", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "workspace-orchestra-executor-"));
  try {
    const store = new WorkspaceOrchestraStore(machineDir);
    const updates: string[] = [];
    let complete!: (value: { outcome: "succeeded"; detail: string; processStoppedConfirmed: true }) => void;
    const executor = new WorkspaceOrchestraExecutor(
      store,
      async (_job, _context, control) => {
        control.spawned(1234);
        return new Promise((resolve) => { complete = resolve; });
      },
      (job) => { updates.push(job.status); },
      1,
    );

    const created = executor.submit(input(path.join(machineDir, "project")), { conversation: "separate" });
    assert.equal(created.job.status, "queued");
    await waitUntil(() => store.get(created.job.id)?.status === "running");
    assert.ok(updates.includes("starting"));
    assert.ok(updates.includes("running"));

    complete({ outcome: "succeeded", detail: "Implemented and ready for review.", processStoppedConfirmed: true });
    await waitUntil(() => store.get(created.job.id)?.status === "succeeded");
    assert.equal(store.get(created.job.id)?.outcome, "Implemented and ready for review.");
    assert.equal(updates.at(-1), "succeeded");
    await executor.stopAll();
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("cancellation keeps the workspace lease until the runner confirms process stop", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "workspace-orchestra-cancel-"));
  try {
    const store = new WorkspaceOrchestraStore(machineDir);
    let entered!: () => void;
    let stop!: () => void;
    const runnerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const stopRequested = new Promise<void>((resolve) => { stop = resolve; });
    const executor = new WorkspaceOrchestraExecutor(
      store,
      async (_job, _context, control) => {
        control.spawned(2345);
        entered();
        await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { outcome: "cancelled", detail: "cancelled", processStoppedConfirmed: true };
      },
      (job) => { if (job.status === "cancel_requested") stop(); },
      1,
    );

    const created = executor.submit(input(path.join(machineDir, "project")), {});
    await runnerEntered;
    executor.cancel(created.job.id);
    await stopRequested;
    assert.equal(store.get(created.job.id)?.status, "cancel_requested");
    assert.equal(store.claimNext(), null, "the directory remains locked while cancellation is unresolved");
    await waitUntil(() => store.get(created.job.id)?.status === "cancelled");
    assert.notEqual(store.get(created.job.id)?.status, "uncertain");
    await executor.stopAll();
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("an unconfirmed stop keeps the directory locked as uncertain", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "workspace-orchestra-uncertain-"));
  try {
    const store = new WorkspaceOrchestraStore(machineDir);
    let complete!: (value: { outcome: "failed"; detail: string; processStoppedConfirmed: false }) => void;
    const executor = new WorkspaceOrchestraExecutor(
      store,
      async (_job, _context, control) => {
        control.spawned(3456);
        return new Promise((resolve) => { complete = resolve; });
      },
      () => undefined,
      1,
    );
    const created = executor.submit(input(path.join(machineDir, "project")), {});
    await waitUntil(() => store.get(created.job.id)?.status === "running");
    complete({ outcome: "failed", detail: "stop not confirmed", processStoppedConfirmed: false });
    await waitUntil(() => store.get(created.job.id)?.status === "uncertain");
    assert.equal(store.claimNext(), null);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("blocked worker persists checkpoint and only explicit same-owner continuation starts another attempt", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "delegation-continuation-"));
  try {
    const workspacePath = path.join(machineDir, "project");
    const contract = { version: 1 as const, taskId: "task-1", runId: "run-1", attemptId: "attempt-1", workerId: "agent-1", mode: "delegated" as const, resource: { id: "workspace-1", revision: 1, root: workspacePath }, requiredCapabilities: ["workspace.write"] };
    const outcome = { version: 1 as const, kind: "needs_operation" as const, summary: "Commit blocked", operation: { capability: "git.commit", description: "Commit", reason: "policy_denied" as const }, checkpoint: { id: "checkpoint-1", stateFingerprint: "tree abc", completed: ["code"], remaining: ["test"] } };
    const original = input(workspacePath, { delegation: { version: 1, contract } });
    const store = new WorkspaceOrchestraStore(machineDir, () => false);
    const executor = new WorkspaceOrchestraExecutor(store, async (_job, _context, control) => {
      control.spawned(4567);
      return { outcome: "blocked", detail: outcome.summary, workerOutcome: outcome, processStoppedConfirmed: true };
    }, () => undefined);
    executor.submit(original, {});
    await waitUntil(() => store.get("run-1")?.status === "blocked");
    await executor.stopAll();
    const recovered = new WorkspaceOrchestraStore(machineDir, () => false);
    assert.deepEqual(recovered.get("run-1")?.delegation?.outcome, outcome);
    assert.equal(recovered.enqueue(original).job.status, "blocked", "ordinary replay cannot rerun checkpointed work");
    assert.equal(recovered.claimNext(), null);
    const next = { ...original, delegation: { version: 1 as const, contract: { ...contract, attemptId: "attempt-2" }, continuation: { previousAttemptId: "attempt-1", checkpointId: "checkpoint-1", workerId: "agent-1", receipt: "Operation completed", checkpoint: outcome.checkpoint } } };
    assert.throws(() => recovered.enqueue({ ...next, delegation: { ...next.delegation, contract: { ...next.delegation.contract, workerId: "other" } } }), /identity_mismatch/);
    recovered.enqueue(next);
    const lease = recovered.claimNext()!;
    assert.equal(lease.delegation?.contract.workerId, "agent-1");
    assert.notEqual(lease.leaseId, store.get("run-1")?.leaseId);
    assert.deepEqual(lease.delegation?.continuation?.checkpoint.remaining, ["test"]);
    recovered.requestCancel(lease.id);
    const late = recovered.finish(lease.id, lease.leaseId!, "succeeded", "late success", true, { version: 1, kind: "completed", summary: "late success" });
    assert.equal(late.status, "cancelled", "cancellation wins completion race");
  } finally { await rm(machineDir, { recursive: true, force: true }); }
});

test("blocked result with unconfirmed stop remains uncertain and cannot continue", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "delegation-uncertain-"));
  try {
    const store = new WorkspaceOrchestraStore(machineDir, () => true);
    const original = input(path.join(machineDir, "project"));
    store.enqueue(original);
    const lease = store.claimNext()!;
    store.recordWorkerSpawned(lease.id, lease.leaseId!, 5678);
    store.finish(lease.id, lease.leaseId!, "blocked", "operation blocked", false);
    assert.equal(store.get(lease.id)?.status, "uncertain");
    store.enqueue(input(path.join(machineDir, "project", "child"), { id: "run-2", taskId: "task-2", messageId: "message-2" }));
    assert.equal(store.claimNext(), null);
  } finally { await rm(machineDir, { recursive: true, force: true }); }
});

test("a continuation submitted by the blocked callback keeps its own active controller", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "delegation-reentrant-"));
  try {
    const workspacePath = path.join(machineDir, "project");
    const contract = { version: 1 as const, taskId: "task-1", runId: "run-1", attemptId: "first", workerId: "agent-1", mode: "delegated" as const, resource: { id: "workspace-1", revision: 1, root: workspacePath }, requiredCapabilities: ["workspace.write"] };
    const workerOutcome = { version: 1 as const, kind: "needs_operation" as const, summary: "Blocked", operation: { capability: "git.commit", description: "Commit", reason: "policy_denied" as const }, checkpoint: { id: "checkpoint", stateFingerprint: "tree", completed: [], remaining: ["test"] } };
    const original = input(workspacePath, { delegation: { version: 1, contract } });
    const store = new WorkspaceOrchestraStore(machineDir, () => false);
    let secondStarted = false;
    const executor = new WorkspaceOrchestraExecutor(store, async (job, _context, control) => {
      control.spawned(1234);
      if (job.delegation?.contract.attemptId === "first") return { outcome: "blocked", detail: "blocked", workerOutcome, processStoppedConfirmed: true };
      secondStarted = true;
      await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
      return { outcome: "cancelled", detail: "stopped", processStoppedConfirmed: true };
    }, (job) => {
      if (job.status === "blocked") executor.submit({ ...original, delegation: { version: 1, contract: { ...contract, attemptId: "second" }, continuation: { previousAttemptId: "first", checkpointId: "checkpoint", workerId: "agent-1", receipt: "exact operation completed", checkpoint: workerOutcome.checkpoint } } }, {});
    });
    executor.submit(original, {});
    await waitUntil(() => secondStarted);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal((executor as unknown as { active: Map<string, AbortController> }).active.size, 1);
    await executor.stopAll();
    assert.equal(store.get("run-1")?.status, "cancelled");
  } finally { await rm(machineDir, { recursive: true, force: true }); }
});
