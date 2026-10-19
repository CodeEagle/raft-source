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
