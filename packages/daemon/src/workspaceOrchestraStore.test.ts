import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { WorkspaceOrchestraStore, type EnqueueWorkspaceOrchestraJob } from "./workspaceOrchestraStore";

function jobInput(workspacePath: string, overrides: Partial<EnqueueWorkspaceOrchestraJob> = {}): EnqueueWorkspaceOrchestraJob {
  return {
    serverId: "server-1",
    machineId: "machine-1",
    channelId: "channel-1",
    agentId: "agent-1",
    taskId: "task-1",
    messageId: "message-1",
    workspaceId: "workspace-1",
    canonicalWorkspacePath: workspacePath,
    workspaceRevision: 1,
    instruction: "Implement the assigned task.",
    ...overrides,
  };
}

test("workspace orchestra enqueue is idempotent by server, message, and agent", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "workspace-orchestra-idempotent-"));
  try {
    const store = new WorkspaceOrchestraStore(machineDir);
    const input = jobInput(path.join(machineDir, "project"));
    const first = store.enqueue(input);
    const duplicate = store.enqueue(input);

    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.job.id, first.job.id);
    assert.equal(store.list().length, 1);
    assert.throws(() => store.enqueue({ ...input, workspaceRevision: 2 }), /conflicts with its persisted/);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("workspace writer leases serialize overlapping paths while independent projects proceed", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "workspace-orchestra-overlap-"));
  try {
    const store = new WorkspaceOrchestraStore(machineDir, () => true);
    const project = path.join(machineDir, "project");
    const nested = path.join(project, "nested");
    const other = path.join(machineDir, "other");
    const first = store.enqueue(jobInput(project));
    const second = store.enqueue(jobInput(nested, { taskId: "task-2", messageId: "message-2", workspaceId: "workspace-2" }));
    const third = store.enqueue(jobInput(other, { taskId: "task-3", messageId: "message-3", workspaceId: "workspace-3" }));

    const firstLease = store.claimNext();
    assert.equal(firstLease?.id, first.job.id);
    assert.ok(firstLease?.leaseId);
    store.recordWorkerSpawned(first.job.id, firstLease!.leaseId!, 1234);

    const independentLease = store.claimNext();
    assert.equal(independentLease?.id, third.job.id);
    assert.ok(independentLease?.leaseId);
    store.recordWorkerSpawned(third.job.id, independentLease!.leaseId!, 1235);
    assert.equal(store.claimNext(), null, "the nested writer stays queued while its parent writer is active");

    store.finish(first.job.id, firstLease!.leaseId!, "succeeded", "done", true);
    const nestedLease = store.claimNext();
    assert.equal(nestedLease?.id, second.job.id);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("restart reconciliation preserves unknown live writers and only releases a lock after process death", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "workspace-orchestra-restart-"));
  try {
    const writerAlive = { value: true as boolean | undefined };
    const probe = () => writerAlive.value;
    const firstStore = new WorkspaceOrchestraStore(machineDir, probe);
    const input = jobInput(path.join(machineDir, "project"));
    const first = firstStore.enqueue(input);
    const queued = firstStore.enqueue(jobInput(path.join(machineDir, "project", "subdir"), {
      taskId: "task-2",
      messageId: "message-2",
      workspaceId: "workspace-2",
    }));
    const lease = firstStore.claimNext();
    assert.equal(lease?.id, first.job.id);
    firstStore.recordWorkerSpawned(first.job.id, lease!.leaseId!, 5678);

    const restartedStore = new WorkspaceOrchestraStore(machineDir, probe);
    assert.equal(restartedStore.list().find((job) => job.id === first.job.id)?.status, "uncertain");
    assert.equal(restartedStore.claimNext(), null, "a live or uncertain old writer holds the overlapping directory");

    writerAlive.value = undefined;
    restartedStore.reconcile();
    assert.equal(restartedStore.claimNext(), null, "unknown liveness is still a held lock");

    writerAlive.value = false;
    restartedStore.reconcile();
    assert.equal(restartedStore.list().find((job) => job.id === first.job.id)?.status, "failed");
    assert.equal(restartedStore.claimNext()?.id, queued.job.id);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});

test("failed stop confirmation keeps the workspace lease uncertain", async () => {
  const machineDir = await mkdtemp(path.join(os.tmpdir(), "workspace-orchestra-stop-"));
  try {
    const store = new WorkspaceOrchestraStore(machineDir, () => true);
    const queued = store.enqueue(jobInput(path.join(machineDir, "project")));
    const lease = store.claimNext();
    store.recordWorkerSpawned(queued.job.id, lease!.leaseId!, 7890);

    const stopped = store.finish(queued.job.id, lease!.leaseId!, "cancelled", "cancelled", false);
    assert.equal(stopped.status, "uncertain");
    assert.equal(store.claimNext(), null);
  } finally {
    await rm(machineDir, { recursive: true, force: true });
  }
});
