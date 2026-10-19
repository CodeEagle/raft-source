import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dbTest } from "../test/integration/dbTest";
import { getDb } from "../db/index";
import { agentRequestAcknowledgements, messageReactions } from "../db/schema";
import { createAgent } from "./agentService";
import { addAgent } from "./channelService";
import { AgentOrchestrator } from "./agentOrchestrator";

dbTest("human request receipt is durable, idempotent, and adds the server-side eyes reaction", async ({ seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const channel = await seed.channel({ server, members: [owner] });
  const agent = await createAgent(server.id, `request-ack-${randomUUID().slice(0, 8)}`, { runtime: "codex" });
  await addAgent(channel.id, agent.id);
  const message = await seed.message({ channel, author: owner, content: "Please take a look" });
  const emissions: Array<{ room: string; event: string; payload: unknown }> = [];
  const orchestrator = new AgentOrchestrator();
  (orchestrator as any).io = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emissions.push({ room, event, payload });
        },
      };
    },
  };

  try {
    const record = (status: "received" | "queued", deliverySeq = message.seq) =>
      (orchestrator as any).recordAgentRequestAcknowledgement({
        agentId: agent.id,
        serverId: server.id,
        messageId: message.id,
        deliverySeq,
        status,
      });

    assert.equal(await record("received"), "persisted");
    assert.equal(await record("queued"), "persisted");
    assert.equal(await record("received"), "persisted");

    const receipts = await getDb().select().from(agentRequestAcknowledgements)
      .where(eq(agentRequestAcknowledgements.messageId, message.id));
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.status, "queued", "receipt status only moves forward");

    const eyes = await getDb().select().from(messageReactions)
      .where(eq(messageReactions.messageId, message.id));
    assert.deepEqual(eyes.map(({ reactorType, reactorId, emoji }) => [reactorType, reactorId, emoji]), [
      ["agent", agent.id, "👀"],
    ]);
    assert.equal(emissions.filter((entry) => entry.event === "message:updated").length, 1);
    assert.equal(emissions.filter((entry) => entry.event === "agent:request:acknowledged").length, 3);

    assert.equal(await record("queued", message.seq + 1), "ignored", "a mismatched delivery sequence cannot acknowledge this message");
  } finally {
    orchestrator.shutdown();
  }
});
