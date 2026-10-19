import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CHANNEL_WORKSPACE_MAX_BYTES,
  channelWorkspaceDirectoryName,
  channelWorkspaceDirectoryPath,
  loadChannelWorkspaceContext,
  loadChannelWorkspaceContextsForMessages,
} from "./channelWorkspaceContext";

test("channel workspace context uses the daemon's injective base64url directory name", () => {
  const channelId = "channel/with spaces:and-unicode-频道";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-channel-context-"));

  const context = loadChannelWorkspaceContext(root, channelId);

  assert.equal(context.directoryName, `ch_${Buffer.from(channelId, "utf8").toString("base64url")}`);
  assert.equal(context.workspacePath, channelWorkspaceDirectoryPath(root, channelId));
  assert.equal(fs.readFileSync(path.join(context.workspacePath, "AGENTS.md"), "utf8"), "# Channel instructions\n\nAdd channel-local instructions here.\n");
  assert.equal(fs.readFileSync(path.join(context.workspacePath, "MEMORY.md"), "utf8"), "# Channel memory\n\nNo channel-specific memory has been recorded yet.\n");
});

test("channel workspace context never overwrites existing files and bounds loaded bytes", () => {
  const channelId = "channel-a";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-channel-context-"));
  const context = loadChannelWorkspaceContext(root, channelId);
  const agentsPath = path.join(context.workspacePath, "AGENTS.md");
  const memoryPath = path.join(context.workspacePath, "MEMORY.md");
  fs.writeFileSync(agentsPath, "keep this operator file\n", "utf8");
  fs.writeFileSync(memoryPath, "x".repeat(CHANNEL_WORKSPACE_MAX_BYTES + 100), "utf8");

  const reloaded = loadChannelWorkspaceContext(root, channelId);

  assert.equal(fs.readFileSync(agentsPath, "utf8"), "keep this operator file\n");
  assert.match(reloaded.memoryMd, new RegExp(`truncated after ${CHANNEL_WORKSPACE_MAX_BYTES} bytes`));
  assert.ok(Buffer.byteLength(reloaded.memoryMd, "utf8") < CHANNEL_WORKSPACE_MAX_BYTES + 200);
});

test("channel workspace context fails closed for symlinked channel files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-channel-context-"));
  const context = loadChannelWorkspaceContext(root, "channel-a");
  const outside = path.join(root, "outside.md");
  fs.writeFileSync(outside, "outside", "utf8");
  fs.unlinkSync(path.join(context.workspacePath, "MEMORY.md"));
  fs.symlinkSync(outside, path.join(context.workspacePath, "MEMORY.md"));

  assert.throws(
    () => loadChannelWorkspaceContext(root, "channel-a"),
    /symbolic link/i,
  );
});

test("managed channel context loads each concrete channel once and skips self-hosted/system/third-party messages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-channel-context-"));
  const contexts = loadChannelWorkspaceContextsForMessages(
    { clientMode: "managed-runner" },
    { SLOCK_CURRENT_WORKSPACE_PATH: root },
    [
      { channel_id: "channel-a" },
      { channel_id: "channel-a" },
      { channel_id: "channel-b" },
      { channel_id: "system" },
      { channel_id: "third-party-agent-events:agent-1", third_party_event: { provider: "external" } },
    ],
  );

  assert.deepEqual([...contexts.keys()], ["channel-a", "channel-b"]);
  assert.equal(
    loadChannelWorkspaceContextsForMessages(
      { clientMode: "self-hosted-runner" },
      { SLOCK_CURRENT_WORKSPACE_PATH: root },
      [{ channel_id: "channel-a" }],
    ).size,
    0,
  );
});
