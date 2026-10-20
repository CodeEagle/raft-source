import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { messages, users, serverMembers } from "../db/schema";
import { signAccessToken } from "../middleware/auth";
import { createAgent } from "../services/agentService";
import { createChannel } from "../services/channelService";
import { createServer } from "../services/serverService";
import { registerMachine } from "../services/machineService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import type { SecureInputRequest } from "@botiverse/raft-shared";
const test = createApiTest({ onboardingOpenerFlagDefaultEnabled: false });
async function fixture() {
  const [owner] = await getDb().insert(users).values({ email: `${randomUUID()}@example.com`, name: `secure-${randomUUID()}`, passwordHash: "hash", emailVerified: true, profileSetupCompletedAt: new Date() }).returning();
  const server = await createServer("Secure Input", `secure-${randomUUID()}`, owner!.id);
  const { machine } = await registerMachine(server.id, owner!.id, "Local Mac");
  const agent = await createAgent(server.id, `worker-${randomUUID().slice(0, 8)}`, { runtime: "codex", machineId: machine.id });
  const channel = await createChannel(server.id, `channel-${randomUUID()}`, undefined, "channel", { type: "user", id: owner!.id, initialAgentIds: [agent.id] });
  return { owner: owner!, server, agent, channel,
    headers: { Authorization: `Bearer ${signAccessToken(owner!.id)}`, "Content-Type": "application/json", "X-Server-Id": server.id },
    body: { channelId: channel.id, agentId: agent.id, requestId: randomUUID(), name: "DEPLOY_TOKEN", ttlSeconds: 3600, allowAgentRead: true } };
}
test("metadata goes to the Computer and only a private DM receives the reference", async ({ app }) => {
  const f = await fixture(); let dispatched: SecureInputRequest | undefined;
  const orchestrator = app.app.get("agentOrchestrator") as AgentOrchestrator;
  orchestrator.hasMachineCapability = () => true;
  orchestrator.requestSecureInput = async (_machine, request) => { dispatched = request; return { status: "stored", requestId: request.requestId, path: `/private/${request.requestId}.value`, expiresAt: new Date(Date.now() + 3600_000).toISOString() }; };
  const response = await fetch(`${app.baseUrl}/api/secure-input`, { method: "POST", headers: f.headers, body: JSON.stringify(f.body) });
  assert.equal(response.status, 200); assert.equal(dispatched?.ownerUserId, f.owner.id); assert.equal(dispatched?.agentId, f.agent.id); assert.equal("value" in dispatched!, false);
  const replay = await fetch(`${app.baseUrl}/api/secure-input`, { method: "POST", headers: f.headers, body: JSON.stringify(f.body) });
  assert.equal(replay.status, 200);
  const sent = await getDb().select().from(messages).where(eq(messages.senderId, f.owner.id));
  const reference = sent.find((m) => m.content.includes(f.body.requestId)); assert.ok(reference); assert.notEqual(reference.channelId, f.channel.id); assert.equal(sent.filter((m) => m.content.includes(f.body.requestId)).length, 1);
});
test("plaintext fields, missing consent and old Computer capabilities never dispatch", async ({ app }) => {
  const f = await fixture(); let dispatched = false;
  const orchestrator = app.app.get("agentOrchestrator") as AgentOrchestrator;
  orchestrator.hasMachineCapability = () => false;
  orchestrator.requestSecureInput = async () => { dispatched = true; throw Error("must not dispatch"); };
  for (const body of [{ ...f.body, value: "synthetic-not-a-real-secret" }, { ...f.body, allowAgentRead: false }]) {
    const response = await fetch(`${app.baseUrl}/api/secure-input`, { method: "POST", headers: f.headers, body: JSON.stringify(body) }); assert.equal(response.status, 400);
  }
  const old = await fetch(`${app.baseUrl}/api/secure-input`, { method: "POST", headers: f.headers, body: JSON.stringify(f.body) }); assert.equal(old.status, 409); assert.equal(dispatched, false);
});

test("a channel member cannot open a prompt on another human's Computer", async ({ app }) => {
  const f = await fixture(); let dispatched = false;
  const [other] = await getDb().insert(users).values({ email: `${randomUUID()}@example.com`, name: `other-${randomUUID()}`, passwordHash: "hash", emailVerified: true, profileSetupCompletedAt: new Date() }).returning();
  await getDb().insert(serverMembers).values({ serverId: f.server.id, userId: other!.id, role: "member" });
  const orchestrator = app.app.get("agentOrchestrator") as AgentOrchestrator;
  orchestrator.hasMachineCapability = () => true;
  orchestrator.requestSecureInput = async () => { dispatched = true; throw Error("must not dispatch"); };
  const response = await fetch(`${app.baseUrl}/api/secure-input`, { method: "POST", headers: { ...f.headers, Authorization: `Bearer ${signAccessToken(other!.id)}` }, body: JSON.stringify(f.body) });
  assert.equal(response.status, 409); assert.equal(dispatched, false);
});

test("closing the HTTP request cancels the local operation without posting a reference", async ({ app }) => {
  const f = await fixture(); let entered!: () => void; let finished!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const cancelled = new Promise<void>((resolve) => { finished = resolve; });
  const orchestrator = app.app.get("agentOrchestrator") as AgentOrchestrator;
  orchestrator.hasMachineCapability = () => true;
  orchestrator.requestSecureInput = async (_machine, request, signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { resolve({ status: "cancelled", requestId: request.requestId }); finished(); }, { once: true });
    entered();
  });
  const controller = new AbortController();
  const pending = fetch(`${app.baseUrl}/api/secure-input`, { method: "POST", headers: f.headers, body: JSON.stringify(f.body), signal: controller.signal });
  await ready; controller.abort(); await assert.rejects(pending);
  await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(Error("Local cancellation not received")), 2000))]);
  const sent = await getDb().select().from(messages).where(eq(messages.senderId, f.owner.id));
  assert.equal(sent.some((message) => message.content.includes(f.body.requestId)), false);
});
