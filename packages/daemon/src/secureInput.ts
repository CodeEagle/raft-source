import { execFile } from "node:child_process";
import { mkdir, lstat, readFile, writeFile, unlink, readdir, rename } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SecureInputRequest, SecureInputResult } from "@botiverse/raft-shared";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCRIPT = 'on run argv\nset answer to display dialog (item 1 of argv) default answer "" with hidden answer buttons {"Cancel", "Save locally"} default button "Save locally" cancel button "Cancel" giving up after 120\nif gave up of answer then error number -128\nreturn text returned of answer\nend run';
export function collectNativeSecret(prompt: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-e", SCRIPT, prompt], { signal, timeout: 125_000, maxBuffer: 128 * 1024 }, (error, stdout) => {
      resolve(error ? null : stdout.replace(/\r?\n$/, "")); // Never forward stderr/errors.
    });
  });
}
interface Record extends SecureInputRequest { expiresAt: string }
export class SecureInputStore {
  private busy = false;
  private pending = new Map<string, AbortController>();
  constructor(readonly root = path.join(os.homedir(), ".raft", "secure-input"), private prompt = collectNativeSecret, private platform = process.platform, private now = () => Date.now()) {}
  cancel(requestId: string): void { this.pending.get(requestId)?.abort(); }
  stop(): void { for (const request of this.pending.values()) request.abort(); }
  private async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const st = await lstat(this.root);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()) throw Error("Unsafe secure input directory");
  }
  async cleanup(): Promise<void> {
    await this.prepare();
    for (const file of await readdir(this.root)) {
      const orphan = /^(.*)\.(pending|value)$/.exec(file);
      if (orphan && UUID.test(orphan[1]!)) {
        const own = path.join(this.root, file);
        const st = await lstat(own).catch(() => null);
        if (!st || !st.isFile() || st.isSymbolicLink()) continue;
        try { await lstat(path.join(this.root, `${orphan[1]}.json`)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT" && st.mtimeMs + 130_000 < this.now()) await unlink(own);
        }
      }
      const id = file.replace(/\.json$/, "");
      if (!UUID.test(id) || file !== `${id}.json`) continue;
      try {
        const metaPath = path.join(this.root, file);
        const st = await lstat(metaPath);
        if (!st.isFile() || st.isSymbolicLink()) continue;
        const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record;
        if (Date.parse(meta.expiresAt) <= this.now()) {
          await unlink(path.join(this.root, `${id}.value`)).catch(() => {});
          await unlink(path.join(this.root, file));
        }
      } catch { /* Never log stored values or exception payloads. */ }
    }
  }
  async collect(request: SecureInputRequest): Promise<SecureInputResult> {
    const { requestId } = request;
    if (!UUID.test(requestId) || !UUID.test(request.ownerUserId) || !UUID.test(request.agentId)
      || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(request.name)
      || !Number.isInteger(request.ttlSeconds) || request.ttlSeconds < 60 || request.ttlSeconds > 86400) return { status: "failed", requestId };
    if (this.platform !== "darwin") return { status: "unsupported", requestId };
    if (this.busy) return { status: "busy", requestId };
    this.busy = true;
    const abort = new AbortController(); this.pending.set(requestId, abort);
    const filename = path.join(this.root, `${requestId}.value`);
    try {
      await this.cleanup();
      const metadata = path.join(this.root, `${requestId}.json`);
      try {
        const st = await lstat(metadata);
        if (!st.isFile() || st.isSymbolicLink()) throw Error("Unsafe metadata");
        const old = JSON.parse(await readFile(metadata, "utf8")) as Record;
        if (old.ownerUserId !== request.ownerUserId || old.agentId !== request.agentId || old.name !== request.name || old.ttlSeconds !== request.ttlSeconds) return { status: "failed", requestId };
        if (request.operation === "revoke") {
          await unlink(filename).catch(() => {}); await unlink(metadata);
          return { status: "revoked", requestId };
        }
        const stored = await lstat(filename).catch(() => null);
        if (!stored || !stored.isFile() || stored.isSymbolicLink()) throw Error("Value not committed");
        return { status: "stored", requestId, path: filename, expiresAt: old.expiresAt };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (request.operation === "revoke") return { status: "failed", requestId };
      const value = await this.prompt(`Raft — ${request.name}\nAgent: ${request.agentName.slice(0, 80)}\nSave to a local private file. The agent can read this value and may send it to its model.`, abort.signal);
      if (value === null || abort.signal.aborted) return { status: "cancelled", requestId };
      if (!value.length || Buffer.byteLength(value) > 64 * 1024) return { status: "failed", requestId };
      const temporary = path.join(this.root, `${requestId}.pending`);
      await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
      const expiresAt = new Date(this.now() + request.ttlSeconds * 1000).toISOString();
      try { await writeFile(metadata, JSON.stringify({ ...request, expiresAt }), { flag: "wx", mode: 0o600 }); }
      catch { await unlink(temporary).catch(() => {}); throw Error("Metadata commit failed"); }
      try { await rename(temporary, filename); }
      catch { await unlink(metadata).catch(() => {}); throw Error("Value commit failed"); }
      return { status: "stored", requestId, path: filename, expiresAt };
    } catch { return { status: "failed", requestId }; }
    finally { this.pending.delete(requestId); this.busy = false; }
  }
}
