import { Router, type Router as RouterType } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { SECURE_INPUT_CAPABILITY } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, machines } from "../db/schema";
import * as channels from "../services/channelService";
import * as messages from "../services/messageService";
import * as users from "../services/userService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import type { Server as SocketServer } from "socket.io";

export const secureInputRouter: RouterType = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

secureInputRouter.get("/", async (req, res) => {
  const channelId = req.query.channelId;
  if (typeof channelId !== "string" || !UUID.test(channelId) || !await channels.canUserAccessChannel(channelId, req.userId!, req.serverId!)) {
    res.status(404).json({ error: "Conversation unavailable" }); return;
  }
  const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
  const rows = await getDb().select({ id: agents.id, name: agents.name, displayName: agents.displayName, machineId: machines.id, machineName: machines.name })
    .from(agents).innerJoin(machines, eq(agents.machineId, machines.id))
    .where(and(eq(agents.serverId, req.serverId!), eq(machines.serverId, req.serverId!), eq(machines.userId, req.userId!), isNull(agents.deletedAt)));
  const available = [];
  for (const row of rows) {
    if (orchestrator.hasMachineCapability(row.machineId, SECURE_INPUT_CAPABILITY) && await channels.canAgentAccessChannel(channelId, row.id)) available.push(row);
  }
  res.json({ agents: available, mode: "agent-readable-file" });
});

secureInputRouter.post("/", async (req, res) => {
  const body = req.body;
  const keys = ["channelId", "agentId", "requestId", "name", "ttlSeconds", "allowAgentRead", "operation"];
  if (!body || Object.keys(body).some((key) => !keys.includes(key)) || body.allowAgentRead !== true
    || ![body.channelId, body.agentId, body.requestId].every((s) => typeof s === "string" && UUID.test(s))
    || typeof body.name !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(body.name)
    || !Number.isInteger(body.ttlSeconds) || body.ttlSeconds < 60 || body.ttlSeconds > 86400
    || ![undefined, "collect", "revoke"].includes(body.operation)) {
    res.status(400).json({ error: "Invalid secure input metadata", code: "invalid_secure_input" }); return;
  }
  if (!await channels.canUserAccessChannel(body.channelId, req.userId!, req.serverId!) || !await channels.canAgentAccessChannel(body.channelId, body.agentId)) {
    res.status(404).json({ error: "Conversation unavailable" }); return;
  }
  const [target] = await getDb().select({ id: agents.id, name: agents.name, machineId: machines.id })
    .from(agents).innerJoin(machines, eq(agents.machineId, machines.id))
    .where(and(eq(agents.id, body.agentId), eq(agents.serverId, req.serverId!), eq(machines.serverId, req.serverId!), eq(machines.userId, req.userId!), isNull(agents.deletedAt)));
  const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
  if (!target || !orchestrator.hasMachineCapability(target.machineId, SECURE_INPUT_CAPABILITY)) {
    res.status(409).json({ error: "This Computer does not support local secure input", code: "secure_input_unavailable" }); return;
  }
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  try {
    const result = await orchestrator.requestSecureInput(target.machineId, { requestId: body.requestId, ownerUserId: req.userId!, agentId: target.id, agentName: target.name, name: body.name, ttlSeconds: body.ttlSeconds, operation: body.operation }, abort.signal);
    if (abort.signal.aborted) return;
    if (result.status === "stored") {
      const [current] = await getDb().select({ machineId: agents.machineId }).from(agents)
        .innerJoin(machines, eq(agents.machineId, machines.id))
        .where(and(eq(agents.id, target.id), eq(agents.serverId, req.serverId!), eq(machines.userId, req.userId!), isNull(agents.deletedAt)));
      if (!current || current.machineId !== target.machineId || !await channels.canUserAccessChannel(body.channelId, req.userId!, req.serverId!) || !await channels.canAgentAccessChannel(body.channelId, target.id)) {
        res.status(403).json({ error: "Authorization changed; the local file expires automatically" }); return;
      }
      // A path is private metadata. Never broadcast it to the source channel.
      const dm = await channels.findOrCreateDM(req.serverId!, req.userId!, target.id);
      const user = await users.getUser(req.userId!);
      if (!dm || !user) { res.status(409).json({ ...result, notified: false }); return; }
      await messages.broadcastAndDeliver(req.app.get("io") as SocketServer, orchestrator, {
        channelId: dm.id, senderType: "user", senderId: req.userId!, senderName: user.displayName || user.name,
        content: `Local secure input ${body.name} saved on your Computer. File: ${JSON.stringify(result.path)}. Expires: ${result.expiresAt}. This is an agent-readable file; reading its contents may send them to your model. Do not print or relay its value.`,
        randomId: body.requestId,
      });
    }
    res.json(result);
  } catch { if (!res.headersSent) res.status(503).json({ error: "Local input did not complete; check the Computer before retrying", code: "secure_input_incomplete" }); }
});
