import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import {
  AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE,
  AGENT_API_ATTACHMENT_DOWNLOAD_URL_UNAVAILABLE_RESPONSE,
  BasicTracer,
  MemoryTraceSink,
} from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { attachments, users } from "../db/schema";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { __setStorageForTests, resetStorageForTests, type StorageBackend } from "../services/storageService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

/**
 * GET /internal/agent-api/attachments/:attachmentId/url: the download route's
 * resolution (capability, visibility, uniform 404) with the presigned URL in a
 * JSON body. The URL is a bearer capability and must never reach logs or traces.
 */

const SIGNED_URL = "https://objects.example.test/private/object?X-Amz-Signature=do-not-log-this";
const SIGNED_URL_LEAK = /X-Amz-Signature|do-not-log-this|objects\.example\.test/;

function agentHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function seedFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `agent-dl-url-${suffix}@slock.test`,
    name: `agent-dl-url-${suffix}`,
    displayName: "Download URL Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Agent Download URL Test", `dl-url-${suffix.slice(0, 8)}`, owner.id);
  const agent = await createAgent(server.id, "DownloadUrlBot", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, `dl-url-room-${suffix.slice(0, 8)}`);
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const privateChannel = await createChannel(server.id, `dl-url-private-${suffix.slice(0, 8)}`, "agent cannot see this", "private");
  await addHuman(privateChannel.id, owner.id);

  const visibleId = randomUUID();
  const privateId = randomUUID();
  await db.insert(attachments).values([
    {
      id: visibleId,
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "quarterly report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 11,
      storageKey: `${server.id}/${visibleId}.pdf`,
    },
    {
      id: privateId,
      channelId: privateChannel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "private.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
      storageKey: `${server.id}/${privateId}.txt`,
    },
  ]);

  const readKey = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "dl-url-read", createdByUserId: null });
  const sendOnlyKey = await mintAgentCredential({ agentId: agent.id, scopes: ["send"], name: "dl-url-send-only", createdByUserId: null });
  return { server, visibleId, privateId, readKey: readKey.apiKey, sendOnlyKey: sendOnlyKey.apiKey };
}

function presigningStorage(presigns: Array<{ key: string; options: unknown }>): StorageBackend {
  return {
    put: async () => {},
    get: async () => Readable.from(Buffer.from("bytes")),
    delete: async () => {},
    getPresignedUrl: async (key, options) => {
      presigns.push({ key, options });
      return SIGNED_URL;
    },
  };
}

test("agent-api attachment download URL: visible → 200 with a 5 minute URL; denied ids answer exactly like the download route", async ({ app }) => {
  try {
    const fx = await seedFixture();
    const presigns: Array<{ key: string; options: unknown }> = [];
    __setStorageForTests(presigningStorage(presigns));

    const before = Date.now();
    const res = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}/url`, { headers: agentHeaders(fx.readKey) });
    const after = Date.now();
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const body = await res.json() as { url: string; expiresAt: string; filename: string; mimeType: string };
    assert.equal(body.url, SIGNED_URL);
    assert.equal(body.filename, "quarterly report.pdf");
    assert.equal(body.mimeType, "application/pdf");
    const expiresAtMs = Date.parse(body.expiresAt);
    assert.equal(new Date(expiresAtMs).toISOString(), body.expiresAt, "expiresAt is an ISO timestamp");
    assert.ok(expiresAtMs >= before + 300_000 && expiresAtMs <= after + 300_000, `expiresAt ${body.expiresAt} is ~5 minutes ahead`);
    // Same presign as the download route's 302 target.
    assert.deepEqual(presigns, [{
      key: `${fx.server.id}/${fx.visibleId}.pdf`,
      options: {
        expiresIn: 300,
        responseContentDisposition: "attachment; filename=\"quarterly report.pdf\"; filename*=UTF-8''quarterly%20report.pdf",
        responseContentType: "application/pdf",
      },
    }]);

    // Not visible (private channel), missing, malformed: the same uniform 404
    // the download route answers, and nothing reaches presigning.
    for (const hiddenId of [fx.privateId, randomUUID(), "e66f3b51"]) {
      const viaUrl = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${hiddenId}/url`, { headers: agentHeaders(fx.readKey) });
      const viaDownload = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${hiddenId}`, {
        headers: agentHeaders(fx.readKey),
        redirect: "manual",
      });
      assert.equal(viaUrl.status, 404);
      assert.equal(viaDownload.status, viaUrl.status);
      const urlBody = await viaUrl.json();
      assert.deepEqual(urlBody, AGENT_API_ATTACHMENT_DOWNLOAD_UNAVAILABLE_RESPONSE);
      assert.deepEqual(await viaDownload.json(), urlBody);
    }
    assert.equal(presigns.length, 1, "missing, malformed, and denied resources never reach presigning");

    // Capability: a credential without `read` is refused exactly like download.
    const deniedUrl = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}/url`, { headers: agentHeaders(fx.sendOnlyKey) });
    const deniedDownload = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}`, {
      headers: agentHeaders(fx.sendOnlyKey),
      redirect: "manual",
    });
    assert.equal(deniedUrl.status, 403);
    assert.equal(deniedDownload.status, 403);
    assert.deepEqual(await deniedUrl.json(), await deniedDownload.json());
    assert.equal(presigns.length, 1);
  } finally {
    resetStorageForTests();
    await app.close();
  }
});

test("agent-api attachment download URL: storage without presign answers 409 download_url_unavailable; download still streams", async ({ app }) => {
  try {
    const fx = await seedFixture();
    let gets = 0;
    __setStorageForTests({
      put: async () => {},
      get: async () => {
        gets += 1;
        return Readable.from(Buffer.from("local bytes"));
      },
      delete: async () => {},
    });

    const res = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}/url`, { headers: agentHeaders(fx.readKey) });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), AGENT_API_ATTACHMENT_DOWNLOAD_URL_UNAVAILABLE_RESPONSE);
    assert.equal(gets, 0, "the URL route never streams bytes");

    // Visibility is still checked first: a hidden attachment is 404, not 409.
    const hidden = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.privateId}/url`, { headers: agentHeaders(fx.readKey) });
    assert.equal(hidden.status, 404);

    const streamed = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}`, { headers: agentHeaders(fx.readKey) });
    assert.equal(streamed.status, 200);
    assert.equal(await streamed.text(), "local bytes");
  } finally {
    resetStorageForTests();
    await app.close();
  }
});

test("agent-api attachment download streams unsafe or same-origin presigned targets, but redirects safe HTTPS external targets", async ({ app }) => {
  try {
    const fx = await seedFixture();
    const payload = Buffer.from("local bytes");
    let presignedUrl = "http://storage.internal.test/private/object?sig=http";
    let storageGets = 0;
    __setStorageForTests({
      put: async () => {},
      get: async () => {
        storageGets += 1;
        return Readable.from(payload);
      },
      delete: async () => {},
      getPresignedUrl: async () => presignedUrl,
    });

    const unsafe = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}`, {
      headers: agentHeaders(fx.readKey),
      redirect: "manual",
    });
    assert.equal(unsafe.status, 200);
    assert.equal(unsafe.headers.get("location"), null);
    assert.deepEqual(Buffer.from(await unsafe.arrayBuffer()), payload);

    for (const [label, localUrl] of [
      ["localhost", "https://localhost:19069/private/object?sig=localhost"],
      ["localhost trailing dot", "https://localhost.:19069/private/object?sig=localhost-dot"],
      ["IPv4 loopback", "https://127.0.0.1:19069/private/object?sig=ipv4"],
      ["IPv6 loopback", "https://[::1]:19069/private/object?sig=ipv6"],
      ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]:19069/private/object?sig=mapped"],
    ] as const) {
      presignedUrl = localUrl;
      const local = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}`, {
        headers: agentHeaders(fx.readKey),
        redirect: "manual",
      });
      assert.equal(local.status, 200, `${label} target should stream through the server`);
      assert.equal(local.headers.get("location"), null);
      assert.deepEqual(Buffer.from(await local.arrayBuffer()), payload);
    }

    presignedUrl = "https://127.example.com/private/object?sig=dns-name";
    const dnsLike = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}`, {
      headers: agentHeaders(fx.readKey),
      redirect: "manual",
    });
    assert.equal(dnsLike.status, 302, "127.example.com is not a loopback IP");
    assert.equal(dnsLike.headers.get("location"), presignedUrl);

    // Exercise same-origin HTTPS independently of the HTTP scheme check. The
    // test app trusts one reverse proxy hop. Use a public host so this case
    // cannot pass merely because the target was classified as loopback.
    app.app.set("trust proxy", 1);
    const publicHost = `attachments.raft.test:${new URL(app.baseUrl).port}`;
    presignedUrl = `https://${publicHost}/private/object?sig=same-origin`;
    const sameOrigin = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}`, {
      headers: {
        ...agentHeaders(fx.readKey),
        "X-Forwarded-Host": publicHost,
        "X-Forwarded-Proto": "https",
      },
      redirect: "manual",
    });
    assert.equal(sameOrigin.status, 200);
    assert.equal(sameOrigin.headers.get("location"), null);
    assert.deepEqual(Buffer.from(await sameOrigin.arrayBuffer()), payload);

    presignedUrl = "https://agent:secret@objects.example.test/private/object?sig=credentialed";
    const credentialed = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}`, {
      headers: agentHeaders(fx.readKey),
      redirect: "manual",
    });
    assert.equal(credentialed.status, 200, "presigned credentials must never be redirected");
    assert.equal(credentialed.headers.get("location"), null);
    assert.deepEqual(Buffer.from(await credentialed.arrayBuffer()), payload);

    presignedUrl = "https://objects.example.test/private/object?sig=unknown-origin";
    const unknownOrigin = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}`, {
      headers: { ...agentHeaders(fx.readKey), "X-Forwarded-Proto": "not-a-protocol" },
      redirect: "manual",
    });
    assert.equal(unknownOrigin.status, 200, "an unknown request origin must fail closed to streaming");
    assert.equal(unknownOrigin.headers.get("location"), null);
    assert.deepEqual(Buffer.from(await unknownOrigin.arrayBuffer()), payload);

    presignedUrl = "https://objects.example.test/private/object?sig=external";
    const external = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}`, {
      headers: agentHeaders(fx.readKey),
      redirect: "manual",
    });
    assert.equal(external.status, 302);
    assert.equal(external.headers.get("location"), presignedUrl);
    assert.equal(await external.text(), "");
    assert.equal(storageGets, 9, "only unsafe and same-origin targets stream through the server");
  } finally {
    resetStorageForTests();
    await app.close();
  }
});

test("agent-api attachment download URL: the signed URL never reaches logs or trace attributes", async ({ app }) => {
  const captured: unknown[][] = [];
  const original = { error: console.error, warn: console.warn, log: console.log, info: console.info };
  try {
    const fx = await seedFixture();
    const sink = new MemoryTraceSink();
    app.app.set("serverTracer", new BasicTracer({ sink }));
    for (const level of ["error", "warn", "log", "info"] as const) {
      console[level] = (...args: unknown[]) => { captured.push(args); };
    }

    __setStorageForTests(presigningStorage([]));
    const ok = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}/url`, { headers: agentHeaders(fx.readKey) });
    assert.equal(ok.status, 200);
    assert.match((await ok.json() as { url: string }).url, SIGNED_URL_LEAK, "the URL is in the body");

    // A presign failure whose message carries the URL: 500, logged without it.
    __setStorageForTests({
      ...presigningStorage([]),
      getPresignedUrl: async () => {
        throw new Error(`presign failed for ${SIGNED_URL}`);
      },
    });
    const failed = await fetch(`${app.baseUrl}/internal/agent-api/attachments/${fx.visibleId}/url`, { headers: agentHeaders(fx.readKey) });
    assert.equal(failed.status, 500);
    const failedBody = await failed.text();
    assert.doesNotMatch(failedBody, SIGNED_URL_LEAK);
    assert.ok(
      captured.some((args) => String(args[0]).includes("internal.agent-api.attachments.url error:")),
      "the failure is logged",
    );

    const spans = sink.getAllSpans();
    assert.ok(spans.length > 0, "requests were traced");
    assert.doesNotMatch(JSON.stringify(spans), SIGNED_URL_LEAK);
    assert.doesNotMatch(JSON.stringify(captured), SIGNED_URL_LEAK);
  } finally {
    Object.assign(console, original);
    resetStorageForTests();
    await app.close();
  }
});
