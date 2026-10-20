import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, stat, symlink, rm, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SecureInputStore } from "./secureInput";
const request = () => ({ requestId: randomUUID(), ownerUserId: randomUUID(), agentId: randomUUID(), agentName: "worker", name: "DEPLOY_TOKEN", ttlSeconds: 60 });
async function fixture(run: (root: string) => Promise<void>) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "raft-secure-input-"));
  try { await run(path.join(parent, "private")); } finally { await rm(parent, { recursive: true, force: true }); }
}
describe("local secure input", () => {
  it("preserves exact value locally, never returns it, and replays without prompting", async () => fixture(async (root) => {
    const secret = `  synthetic-${randomUUID()}\nprivate material\n`;
    let prompts = 0; const store = new SecureInputStore(root, async () => { prompts++; return secret; }, "darwin");
    const req = request(); const result = await store.collect(req);
    expect(result.status).toBe("stored"); if (result.status !== "stored") throw Error("store failed");
    expect(JSON.stringify(result)).not.toContain(secret); expect(await readFile(result.path, "utf8")).toBe(secret);
    expect((await stat(root)).mode & 0o777).toBe(0o700); expect((await stat(result.path)).mode & 0o777).toBe(0o600);
    expect(await store.collect(req)).toEqual(result); expect(prompts).toBe(1);
    expect((await store.collect({ ...req, ownerUserId: randomUUID() })).status).toBe("failed");
  }));
  it("cancels a pending native prompt without persisting a value", async () => fixture(async (root) => {
    let entered!: () => void; const ready = new Promise<void>((r) => { entered = r; });
    const store = new SecureInputStore(root, async (_, signal) => { entered(); return new Promise((r) => signal.addEventListener("abort", () => r("synthetic"), { once: true })); }, "darwin");
    const req = request(); const pending = store.collect(req); await ready; store.cancel(req.requestId);
    expect((await pending).status).toBe("cancelled"); await expect(access(path.join(root, req.requestId + ".value"))).rejects.toThrow();
  }));
  it("deletes on expiry and allows explicit deletion only by the original owner", async () => fixture(async (root) => {
    let now = Date.now(); const store = new SecureInputStore(root, async () => "synthetic", "darwin", () => now);
    const req = request(); const result = await store.collect(req); expect(result.status).toBe("stored");
    expect((await store.collect({ ...req, ownerUserId: randomUUID(), operation: "revoke" })).status).toBe("failed");
    expect((await store.collect({ ...req, operation: "revoke" })).status).toBe("revoked");
    const second = request(); await store.collect(second); now += 61_000; await store.cleanup();
    await expect(access(path.join(root, second.requestId + ".value"))).rejects.toThrow();
  }));
  it("rejects unsafe directories, traversal IDs, and unsupported platforms before input", async () => fixture(async (root) => {
    const linked = root + "-link"; await symlink(path.dirname(root), linked);
    const prompt = async () => { throw Error("must not prompt"); };
    expect((await new SecureInputStore(linked, prompt, "darwin").collect(request())).status).toBe("failed");
    expect((await new SecureInputStore(root, prompt, "darwin").collect({ ...request(), requestId: "../escape" })).status).toBe("failed");
    expect((await new SecureInputStore(root, prompt, "linux").collect(request())).status).toBe("unsupported");
  }));
});
