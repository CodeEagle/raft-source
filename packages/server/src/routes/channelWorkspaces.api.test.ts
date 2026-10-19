import { DAEMON_CAPABILITY_DELEGATION_V1, type DelegationRecord, type DelegationOutcome } from "@botiverse/raft-shared";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { and, asc, eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { channelWorkspaceBindings, channelWorkspaceConfigs, channelWorkspaceTaskRuns, serverMembers, tasks, users, workspaces } from "../db/schema";
import { signAccessToken } from "../middleware/auth";
import { createAgent } from "../services/agentService";
import { AgentOrchestrator } from "../services/agentOrchestrator";
import { addHuman, createChannel } from "../services/channelService";
import { createServer } from "../services/serverService";
import { registerMachine } from "../services/machineService";

const test = createApiTest({ onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@example.com`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    passwordHash: "hash",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

function headers(userId: string, serverId: string) {
  return {
    Authorization: `Bearer ${signAccessToken(userId)}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

async function fixture(label: string, runtime = "codex") {
  const owner = await seedUser(`${label}-owner`);
  const server = await createServer(label, `${label.toLowerCase()}-${randomUUID()}`, owner.id);
  const { machine } = await registerMachine(server.id, owner.id, `${label}-computer`);
  const agent = await createAgent(server.id, `${label}-agent`, { runtime, machineId: machine.id });
  const channel = await createChannel(server.id, `${label}-channel`, undefined, "channel", {
    type: "user",
    id: owner.id,
    initialAgentIds: [agent.id],
  });
  return { owner, server, machine, agent, channel };
}

test("channel workspace settings are versioned, target the agent Computer, and expose the Codex worker lane", async ({ app }) => {
  const f = await fixture("WorkspaceVersioning");
  const validationCalls: Array<{ machineId: string; requestedPath: string }> = [];
  app.app.set("agentOrchestrator", {
    validateMachineWorkspacePath: async (machineId: string, requestedPath: string) => {
      validationCalls.push({ machineId, requestedPath });
      return { requestedPath, canonicalPath: requestedPath, status: "available" };
    },
    hasMachineLocally: () => true,
  });

  const configUrl = `${app.baseUrl}/api/channels/${f.channel.id}/workspaces/${f.agent.id}`;
  const before = await fetch(configUrl, { headers: headers(f.owner.id, f.server.id) });
  assert.equal(before.status, 200);
  assert.deepEqual(await before.json(), {
    revision: 0,
    bindings: [],
    execution: {
      enabled: true,
      runtime: "codex",
      sandboxProfiles: ["read-only", "workspace-write"],
      conversationLane: "workspace_read_only_on_next_start",
      workerLane: "scheduled",
      reason: "orchestra_active",
    },
  });

  const saved = await fetch(configUrl, {
    method: "PUT",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify({
      expectedRevision: 0,
      bindings: [
        { machineId: f.machine.id, path: "/workspace/project-a", mode: "writer" },
        { machineId: f.machine.id, path: "/workspace/project-b", mode: "reader" },
      ],
    }),
  });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as {
    revision: number;
    executionEnabled: boolean;
    execution: { enabled: boolean; workerLane: string; conversationLane: string };
    bindings: Array<{ validationStatus: string; mode: string }>;
  };
  assert.equal(savedBody.revision, 1);
  assert.equal(savedBody.executionEnabled, true);
  assert.deepEqual(savedBody.execution, {
    enabled: true,
    runtime: "codex",
    sandboxProfiles: ["read-only", "workspace-write"],
    conversationLane: "workspace_read_only_on_next_start",
    workerLane: "scheduled",
    reason: "orchestra_active",
  });
  assert.deepEqual(savedBody.bindings.map((binding) => [binding.validationStatus, binding.mode]), [
    ["available", "writer"],
    ["available", "reader"],
  ]);
  assert.deepEqual(validationCalls, [
    { machineId: f.machine.id, requestedPath: "/workspace/project-a" },
    { machineId: f.machine.id, requestedPath: "/workspace/project-b" },
  ]);

  const storedConfig = await getDb().select().from(channelWorkspaceConfigs).where(and(
    eq(channelWorkspaceConfigs.channelId, f.channel.id),
    eq(channelWorkspaceConfigs.agentId, f.agent.id),
  ));
  assert.equal(storedConfig[0]?.revision, 1);
  const storedBindings = await getDb().select({ mode: channelWorkspaceBindings.mode, requestedPath: workspaces.requestedPath, position: channelWorkspaceBindings.position })
    .from(channelWorkspaceBindings)
    .innerJoin(workspaces, eq(channelWorkspaceBindings.workspaceId, workspaces.id))
    .where(and(
      eq(channelWorkspaceBindings.channelId, f.channel.id),
      eq(channelWorkspaceBindings.agentId, f.agent.id),
    ))
    .orderBy(asc(channelWorkspaceBindings.position));
  assert.deepEqual(storedBindings.map((binding) => [binding.requestedPath, binding.mode]), [
    ["/workspace/project-a", "writer"],
    ["/workspace/project-b", "reader"],
  ]);

  const stale = await fetch(configUrl, {
    method: "PUT",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify({ expectedRevision: 0, bindings: [] }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { revision: number }).revision, 1);
});

test("workspace task submission creates one assigned Raft task and supports status reads and cancellation", async ({ app }) => {
  const f = await fixture("WorkspaceTaskFlow");
  const dispatches: string[] = [];
  const cancellations: string[] = [];
  app.app.set("io", undefined);
  app.app.set("agentOrchestrator", {
    validateMachineWorkspacePath: async (_machineId: string, requestedPath: string) => ({
      requestedPath,
      canonicalPath: requestedPath,
      status: "available",
    }),
    hasMachineLocally: () => true,
    dispatchChannelWorkspaceTask: async (runId: string) => { dispatches.push(runId); return true; },
    cancelChannelWorkspaceTask: async (_agentId: string, runId: string) => { cancellations.push(runId); return true; },
  });
  const configUrl = `${app.baseUrl}/api/channels/${f.channel.id}/workspaces/${f.agent.id}`;
  const saved = await fetch(configUrl, {
    method: "PUT",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify({
      expectedRevision: 0,
      bindings: [{ machineId: f.machine.id, path: "/workspace/task-project", mode: "writer" }],
    }),
  });
  assert.equal(saved.status, 200);
  const config = await saved.json() as { bindings: Array<{ workspaceId: string }> };
  const workspaceId = config.bindings[0]?.workspaceId;
  assert.ok(workspaceId);

  const idempotencyKey = randomUUID();
  const createUrl = `${app.baseUrl}/api/channels/${f.channel.id}/workspaces/${f.agent.id}/tasks`;
  const request = {
    workspaceId,
    instruction: "Add a small health endpoint and document it.",
    idempotencyKey,
  };
  const response = await fetch(createUrl, {
    method: "POST",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify(request),
  });
  assert.equal(response.status, 200);
  const created = await response.json() as {
    run: { id: string; status: string; workspaceRevision: number; requestedPath: string; canonicalWorkspacePath: string };
    task: { id: string; status: string; claimedById: string; description: string };
    duplicate: boolean;
  };
  assert.equal(created.duplicate, false);
  assert.equal(created.run.status, "queued");
  assert.equal(created.run.workspaceRevision, 1);
  assert.equal(created.run.requestedPath, "/workspace/task-project");
  assert.equal(created.run.canonicalWorkspacePath, "/workspace/task-project");
  assert.equal(created.task.status, "todo");
  assert.equal(created.task.claimedById, f.agent.id);
  assert.equal(created.task.description, request.instruction);

  const duplicate = await fetch(createUrl, {
    method: "POST",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify(request),
  });
  assert.equal(duplicate.status, 200);
  const replay = await duplicate.json() as { run: { id: string }; duplicate: boolean };
  assert.equal(replay.duplicate, true);
  assert.equal(replay.run.id, created.run.id);
  assert.equal((await getDb().select().from(channelWorkspaceTaskRuns).where(eq(channelWorkspaceTaskRuns.idempotencyKey, idempotencyKey))).length, 1);
  assert.equal((await getDb().select().from(tasks).where(eq(tasks.id, created.task.id))).length, 1);

  const list = await fetch(createUrl, { headers: headers(f.owner.id, f.server.id) });
  assert.equal(list.status, 200);
  assert.equal((await list.json() as { runs: unknown[] }).runs.length, 1);

  const cancel = await fetch(`${createUrl}/${created.run.id}/cancel`, {
    method: "POST",
    headers: headers(f.owner.id, f.server.id),
    body: "{}",
  });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json() as { run: { status: string } }).run.status, "cancel_requested");
  assert.deepEqual(cancellations, [created.run.id]);
  assert.deepEqual(dispatches, [created.run.id, created.run.id]);
});

test("worker lifecycle updates advance the canonical task to review and persist its result", async ({ app }) => {
  const f = await fixture("WorkspaceTaskLifecycle");
  app.app.set("io", undefined);
  app.app.set("agentOrchestrator", {
    validateMachineWorkspacePath: async (_machineId: string, requestedPath: string) => ({
      requestedPath,
      canonicalPath: requestedPath,
      status: "available",
    }),
    hasMachineLocally: () => true,
    dispatchChannelWorkspaceTask: async () => true,
    cancelChannelWorkspaceTask: async () => true,
  });
  const configUrl = `${app.baseUrl}/api/channels/${f.channel.id}/workspaces/${f.agent.id}`;
  const saved = await fetch(configUrl, {
    method: "PUT",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify({
      expectedRevision: 0,
      bindings: [{ machineId: f.machine.id, path: "/workspace/lifecycle-project", mode: "writer" }],
    }),
  });
  assert.equal(saved.status, 200);
  const config = await saved.json() as { bindings: Array<{ workspaceId: string }> };
  const response = await fetch(`${configUrl}/tasks`, {
    method: "POST",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify({
      workspaceId: config.bindings[0]?.workspaceId,
      instruction: "Implement the assigned change.",
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(response.status, 200);
  const created = await response.json() as { run: { id: string; delegation?: DelegationRecord }; task: { id: string } };

  const orchestrator = new AgentOrchestrator();
  (orchestrator as any).validateMachineAgentMessage = async () => f.agent;
  const update = (status: "starting" | "running" | "succeeded", detail?: string) => ({
    type: "agent:workspace:task:update",
    agentId: f.agent.id,
    runId: created.run.id,
    taskId: created.task.id,
    status,
    leaseId: "worker-lease-1",
    ...(created.run.delegation ? { delegationAttemptId: created.run.delegation.contract.attemptId } : {}),
    ...(status === "succeeded" ? { workerOutcome: { version: 1, kind: "completed", summary: detail! } } : {}),
    ...(status === "running" ? { workerPid: 4567 } : {}),
    ...(detail ? { detail } : {}),
  });
  await orchestrator.handleMachineMessage(f.machine.id, update("starting") as never);
  await orchestrator.handleMachineMessage(f.machine.id, update("running") as never);
  await orchestrator.handleMachineMessage(f.machine.id, update("succeeded", "Implemented the endpoint and docs.") as never);

  const [run] = await getDb().select().from(channelWorkspaceTaskRuns).where(eq(channelWorkspaceTaskRuns.id, created.run.id));
  const [task] = await getDb().select().from(tasks).where(eq(tasks.id, created.task.id));
  assert.equal(run?.status, "succeeded");
  assert.equal(run?.result, "Implemented the endpoint and docs.");
  assert.equal(task?.status, "in_review");
  assert.equal(task?.claimedById, f.agent.id);
});

test("terminal cancellation callbacks reconcile the server run and ignore late nonterminal events", async ({ app }) => {
  const f = await fixture("WorkspaceCancelRecon");
  app.app.set("io", undefined);
  app.app.set("agentOrchestrator", {
    validateMachineWorkspacePath: async (_machineId: string, requestedPath: string) => ({
      requestedPath,
      canonicalPath: requestedPath,
      status: "available",
    }),
    hasMachineLocally: () => true,
    dispatchChannelWorkspaceTask: async () => true,
    cancelChannelWorkspaceTask: async () => true,
  });
  const configUrl = `${app.baseUrl}/api/channels/${f.channel.id}/workspaces/${f.agent.id}`;
  const saved = await fetch(configUrl, {
    method: "PUT",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify({
      expectedRevision: 0,
      bindings: [{ machineId: f.machine.id, path: "/workspace/cancellation-reconciliation", mode: "writer" }],
    }),
  });
  assert.equal(saved.status, 200);
  const config = await saved.json() as { bindings: Array<{ workspaceId: string }> };
  const response = await fetch(`${configUrl}/tasks`, {
    method: "POST",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify({
      workspaceId: config.bindings[0]?.workspaceId,
      instruction: "Run a cancellable worker.",
      idempotencyKey: randomUUID(),
    }),
  });
  assert.equal(response.status, 200);
  const created = await response.json() as { run: { id: string; delegation?: DelegationRecord }; task: { id: string } };

  const orchestrator = new AgentOrchestrator();
  (orchestrator as any).validateMachineAgentMessage = async () => f.agent;
  const acknowledgements: Array<{ status: string; applied: boolean }> = [];
  const connection = {
    serverId: f.server.id,
    ws: {
      readyState: 1,
      send: (raw: string) => {
        const ack = JSON.parse(raw) as { status: string; applied: boolean };
        acknowledgements.push({ status: ack.status, applied: ack.applied });
      },
    },
  };
  const update = (status: "starting" | "running" | "cancelled" | "cancel_requested", detail?: string) => ({
    type: "agent:workspace:task:update",
    agentId: f.agent.id,
    runId: created.run.id,
    taskId: created.task.id,
    status,
    leaseId: "cancel-reconcile-lease",
    ...(created.run.delegation ? { delegationAttemptId: created.run.delegation.contract.attemptId } : {}),
    ...(status === "running" ? { workerPid: 9876 } : {}),
    ...(detail ? { detail } : {}),
  });
  const deliver = async (status: "starting" | "running" | "cancelled" | "cancel_requested", detail?: string) => {
    await (orchestrator as any).handleWorkspaceTaskRunUpdate(f.machine.id, connection, update(status, detail));
  };
  await deliver("starting");
  await deliver("running");

  const cancel = await fetch(`${configUrl}/tasks/${created.run.id}/cancel`, {
    method: "POST",
    headers: headers(f.owner.id, f.server.id),
    body: "{}",
  });
  assert.equal(cancel.status, 200);
  assert.equal((await cancel.json() as { run: { status: string } }).run.status, "cancel_requested");

  // The daemon's terminal callback is the source of truth for completion.
  await deliver("cancelled", "cancel_requested");
  let [run] = await getDb().select().from(channelWorkspaceTaskRuns).where(eq(channelWorkspaceTaskRuns.id, created.run.id));
  assert.equal(run?.status, "cancelled");
  assert.equal(run?.result, "cancel_requested");
  assert.deepEqual(acknowledgements.at(-1), { status: "cancelled", applied: true });

  // A duplicated terminal callback and an older running/cancelling callback
  // are both acknowledged/ignored by the state machine and cannot regress the
  // server-visible terminal state.
  await deliver("cancelled");
  await deliver("running");
  await deliver("cancel_requested");
  [run] = await getDb().select().from(channelWorkspaceTaskRuns).where(eq(channelWorkspaceTaskRuns.id, created.run.id));
  assert.equal(run?.status, "cancelled");
  assert.deepEqual(acknowledgements.slice(-3), [
    { status: "cancelled", applied: false },
    { status: "cancelled", applied: false },
    { status: "cancelled", applied: false },
  ]);
});

test("offline paths remain explicitly unavailable and are not redirected to another Computer", async ({ app }) => {
  const f = await fixture("WorkspaceOffline");
  app.app.set("agentOrchestrator", {
    validateMachineWorkspacePath: async () => { throw new Error("Machine is not connected"); },
    hasMachineLocally: () => false,
  });
  const response = await fetch(`${app.baseUrl}/api/channels/${f.channel.id}/workspaces/${f.agent.id}`, {
    method: "PUT",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify({
      expectedRevision: 0,
      bindings: [{ machineId: f.machine.id, path: "/workspace/offline", mode: "writer" }],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { bindings: Array<{ validationStatus: string; validationMessage: string }> };
  assert.equal(body.bindings[0]?.validationStatus, "offline");
  assert.match(body.bindings[0]?.validationMessage ?? "", /offline/i);
});

test("workspace settings report unsupported runtime sandbox capability explicitly", async ({ app }) => {
  const f = await fixture("WorkspaceUnsupported", "claude");
  const response = await fetch(`${app.baseUrl}/api/channels/${f.channel.id}/workspaces/${f.agent.id}`, {
    headers: headers(f.owner.id, f.server.id),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { execution: Record<string, unknown> };
  assert.deepEqual(body.execution, {
    enabled: false,
    runtime: "claude",
    sandboxProfiles: [],
    conversationLane: "unsupported",
    workerLane: "unsupported",
    reason: "runtime_sandbox_unverified",
  });
});

test("workspace APIs reject non-admin channel readers, cross-Computer paths, and traversal paths", async ({ app }) => {
  const f = await fixture("WorkspaceAuthorization");
  const peer = await seedUser("workspace-peer");
  await getDb().insert(serverMembers).values({ serverId: f.server.id, userId: peer.id, role: "member" });
  await addHuman(f.channel.id, peer.id);
  const otherMachine = await registerMachine(f.server.id, f.owner.id, "other-workspace-computer");
  app.app.set("agentOrchestrator", {
    validateMachineWorkspacePath: async (machineId: string, requestedPath: string) => ({ machineId, requestedPath, status: "available", canonicalPath: requestedPath }),
    hasMachineLocally: () => true,
  });
  const configUrl = `${app.baseUrl}/api/channels/${f.channel.id}/workspaces/${f.agent.id}`;

  const denied = await fetch(configUrl, { headers: headers(peer.id, f.server.id) });
  assert.equal(denied.status, 403);

  const wrongMachine = await fetch(configUrl, {
    method: "PUT",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify({ expectedRevision: 0, bindings: [{ machineId: otherMachine.machine.id, path: "/workspace/wrong", mode: "reader" }] }),
  });
  assert.equal(wrongMachine.status, 400);
  assert.equal((await wrongMachine.json() as { code: string }).code, "workspace_machine_mismatch");

  const traversal = await fetch(configUrl, {
    method: "PUT",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify({ expectedRevision: 0, bindings: [{ machineId: f.machine.id, path: "/workspace/../private", mode: "writer" }] }),
  });
  assert.equal(traversal.status, 400);
});

test("workspace alias and parent-child overlaps are refused after target Computer resolution", async ({ app }) => {
  const f = await fixture("WorkspaceOverlap");
  app.app.set("agentOrchestrator", {
    validateMachineWorkspacePath: async (_machineId: string, requestedPath: string) => ({
      requestedPath,
      status: "available",
      canonicalPath: requestedPath.endsWith("-alias") ? "/workspace/project" : requestedPath,
    }),
    hasMachineLocally: () => true,
  });
  const response = await fetch(`${app.baseUrl}/api/channels/${f.channel.id}/workspaces/${f.agent.id}`, {
    method: "PUT",
    headers: headers(f.owner.id, f.server.id),
    body: JSON.stringify({
      expectedRevision: 0,
      bindings: [
        { machineId: f.machine.id, path: "/workspace/project", mode: "writer" },
        { machineId: f.machine.id, path: "/workspace/project-alias", mode: "reader" },
      ],
    }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, "workspace_path_overlap");
});

test("blocked delegation persists typed checkpoint, rejects replay and continues only its authenticated owner", async ({ app }) => {
  const f = await fixture("DelegationContinuation");
  app.app.set("io", undefined);
  let dispatchCount = 0;
  app.app.set("agentOrchestrator", {
    validateMachineWorkspacePath: async (_id: string, requestedPath: string) => ({ requestedPath, canonicalPath: requestedPath, status: "available" }),
    hasMachineLocally: () => true,
    dispatchChannelWorkspaceTask: async () => { dispatchCount++; return true; },
    cancelChannelWorkspaceTask: async () => true,
  });
  const url = `${app.baseUrl}/api/channels/${f.channel.id}/workspaces/${f.agent.id}`;
  const configResponse = await fetch(url, { method: "PUT", headers: headers(f.owner.id, f.server.id), body: JSON.stringify({ expectedRevision: 0, bindings: [{ machineId: f.machine.id, path: "/workspace/continuation", mode: "writer" }] }) });
  assert.equal(configResponse.status, 200);
  const config = await configResponse.json() as { bindings: Array<{ workspaceId: string }> };
  const request = { workspaceId: config.bindings[0].workspaceId, instruction: "Implement, commit and verify", idempotencyKey: randomUUID(), delegation: { mode: "delegated" } };
  const hard = await fetch(`${url}/tasks`, { method: "POST", headers: headers(f.owner.id, f.server.id), body: JSON.stringify({ ...request, delegation: { mode: "delegate_required" } }) });
  assert.equal(hard.status, 409);
  assert.equal((await hard.json() as { code: string }).code, "delegation_enforcement_unsupported");
  const response = await fetch(`${url}/tasks`, { method: "POST", headers: headers(f.owner.id, f.server.id), body: JSON.stringify(request) });
  assert.equal(response.status, 200);
  const created = await response.json() as { run: { id: string; delegation: DelegationRecord }; task: { id: string } };
  const orchestrator = new AgentOrchestrator();
  (orchestrator as any).validateMachineAgentMessage = async () => f.agent;
  const frames: Array<{ run: { delegation?: DelegationRecord } }> = [];
  const conn = { serverId: f.server.id, lastPong: Date.now(), lastIngressAt: Date.now(), capabilities: new Set<string>(), ws: { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) } };
  (orchestrator as any).machineConnections.set(f.machine.id, conn);
  assert.equal(await orchestrator.dispatchChannelWorkspaceTask(created.run.id), false, "an older daemon cannot ignore the contract");
  assert.equal(frames.length, 0);
  conn.capabilities.add(DAEMON_CAPABILITY_DELEGATION_V1);
  assert.equal(await orchestrator.dispatchChannelWorkspaceTask(created.run.id), true);
  assert.equal(frames[0].run.delegation?.contract.attemptId, created.run.delegation.contract.attemptId);
  const outcome: DelegationOutcome = { version: 1, kind: "needs_operation", summary: "Commit needs capability", operation: { capability: "git.commit", description: "Commit prepared changes", reason: "policy_denied" }, checkpoint: { id: "checkpoint-1", stateFingerprint: "tree-abc", completed: ["implemented"], remaining: ["verify commit"] } };
  const update = { type: "agent:workspace:task:update", agentId: f.agent.id, runId: created.run.id, taskId: created.task.id, leaseId: "lease-one", delegationAttemptId: created.run.delegation.contract.attemptId };
  await orchestrator.handleMachineMessage(f.machine.id, { ...update, status: "running", workerPid: 123 } as never);
  await orchestrator.handleMachineMessage(f.machine.id, { ...update, status: "succeeded", detail: "Done without structured outcome" } as never);
  let [stored] = await getDb().select().from(channelWorkspaceTaskRuns).where(eq(channelWorkspaceTaskRuns.id, created.run.id));
  assert.equal(stored.status, "running", "prose alone cannot become success");
  await orchestrator.handleMachineMessage(f.machine.id, { ...update, status: "blocked", workerOutcome: outcome, detail: outcome.summary } as never);
  [stored] = await getDb().select().from(channelWorkspaceTaskRuns).where(eq(channelWorkspaceTaskRuns.id, created.run.id));
  assert.equal(stored.status, "blocked");
  assert.deepEqual(stored.delegation?.outcome, outcome);
  const [task] = await getDb().select().from(tasks).where(eq(tasks.id, created.task.id));
  assert.equal(task.status, "in_progress");
  assert.equal(await orchestrator.dispatchChannelWorkspaceTask(stored.id), false, "reconnect must not replay blocked effects");
  const retryUrl = `${url}/tasks/${stored.id}/retry`;
  const post = (body: unknown) => fetch(retryUrl, { method: "POST", headers: headers(f.owner.id, f.server.id), body: JSON.stringify(body) });
  assert.equal((await post({})).status, 409);
  const continuation = { previousAttemptId: created.run.delegation.contract.attemptId, checkpointId: "checkpoint-1", workerId: f.agent.id, receipt: "Authorized exact operation completed; tree verified" };
  assert.equal((await post({ continuation: { ...continuation, workerId: "other-worker" } })).status, 409);
  assert.equal((await fetch(retryUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ continuation }) })).status, 401);
  for (const status of ["todo", "in_review", "done"] as const) {
    await getDb().update(tasks).set({ status }).where(eq(tasks.id, created.task.id));
    assert.equal((await post({ continuation })).status, 409, `cannot continue a ${status} task`);
  }
  await getDb().update(tasks).set({ status: "in_progress", claimedById: null, claimedByType: null }).where(eq(tasks.id, created.task.id));
  assert.equal((await post({ continuation })).status, 409, "unclaimed work cannot continue under old ownership");
  await getDb().update(tasks).set({ claimedById: f.agent.id, claimedByType: "agent" }).where(eq(tasks.id, created.task.id));
  const resumed = await post({ continuation });
  assert.equal(resumed.status, 200);
  [stored] = await getDb().select().from(channelWorkspaceTaskRuns).where(eq(channelWorkspaceTaskRuns.id, created.run.id));
  assert.equal(stored.status, "queued");
  assert.notEqual(stored.delegation?.contract.attemptId, update.delegationAttemptId);
  assert.equal(stored.delegation?.contract.workerId, f.agent.id);
  assert.deepEqual(stored.delegation?.continuation?.checkpoint, outcome.checkpoint);
  assert.equal(dispatchCount, 2);
  assert.equal((await post({ continuation })).status, 409, "checkpoint receipt cannot be consumed twice");
  await orchestrator.handleMachineMessage(f.machine.id, { ...update, status: "succeeded", workerOutcome: { version: 1, kind: "completed", summary: "late old attempt" } } as never);
  [stored] = await getDb().select().from(channelWorkspaceTaskRuns).where(eq(channelWorkspaceTaskRuns.id, created.run.id));
  assert.equal(stored.status, "queued", "old attempt cannot finish a continuation");
  const conflict = await fetch(`${url}/tasks`, { method: "POST", headers: headers(f.owner.id, f.server.id), body: JSON.stringify({ ...request, delegation: { requiredCapabilities: ["docker.run"] } }) });
  assert.equal(conflict.status, 409);
});
