import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asAxSurfaceText, type AgentConfig, type AgentMessage } from "@botiverse/raft-shared";
import { AgentProcessManager } from "./agentProcessManager";
import { setDaemonFetchImplForTests } from "./daemonFetch";
import { formatResumeEmptyPrompt, formatResumeUnreadSummaryPrompt } from "./agentRuntimeInput";
import type { RuntimeDriver, SpawnContext } from "./drivers/index";
import { promptConfig } from "./testing/promptFixture";
import { channelWorkspaceDirectoryName } from "./channelWorkspaceContext";

class PromptChild extends EventEmitter {
  exitCode: number | null = null;
  readonly signalCode = null;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = { write: () => true };
  kill(): boolean {
    // Real children exit after kill returns; let stopAgent install its waiter.
    queueMicrotask(() => {
      this.exitCode = 0;
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    });
    return true;
  }
}

async function withPromptManager(
  nativeStandingPrompt: boolean,
  run: (ctx: { manager: AgentProcessManager; driver: RuntimeDriver; spawns: SpawnContext[] }) => Promise<void>,
): Promise<void> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "raft-prompt-test-"));
  const spawns: SpawnContext[] = [];
  const driver: RuntimeDriver = {
    id: "prompt-test",
    lifecycle: { kind: "persistent", stdin: "direct", inFlightWake: "steer" },
    communication: { chat: "slock_cli", runtimeControl: "none" },
    session: { recovery: "resume_or_fresh" },
    model: { detectedModelsVerifiedAs: "suggestion_only" },
    supportsStdinNotification: true,
    busyDeliveryMode: "direct",
    supportsNativeStandingPrompt: nativeStandingPrompt,
    // A sentinel isolates routing from copy. Real rendered instructions are
    // covered by drivers/systemPrompt.snapshot.test.ts.
    buildSystemPrompt: (config: AgentConfig) => asAxSurfaceText(`standing:${config.description}`),
    spawn: (ctx) => {
      spawns.push(ctx);
      return { process: new PromptChild() as unknown as ChildProcess };
    },
    parseLine: () => [],
    encodeStdinMessage: (text) => text,
  };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.includes("/internal/computer/runners/") && method === "POST") {
      return Response.json({ apiKey: "sk_agent_prompt_test", credentialId: "prompt-test" }, { status: 201 });
    }
    if (url.includes("/internal/computer/runners/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
  setDaemonFetchImplForTests(fetch as never);
  const manager = new AgentProcessManager(() => {}, "sk_machine_test", {
    dataDir, slockHome: dataDir, runtimeSessionHomeDir: dataDir,
    daemonVersion: "1.0.1-test", computerVersion: "2.0.1-test",
    serverUrl: "https://raft.example.test", driverResolver: () => driver,
  });
  try {
    await run({ manager, driver, spawns });
  } finally {
    try {
      await manager.stopAll();
    } finally {
      fetch.mockRestore();
      setDaemonFetchImplForTests(undefined);
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

test.each([true, false])("cold start routes standing instructions with native support=%s", async (native) => {
  await withPromptManager(native, async ({ manager, spawns }) => {
    await manager.startAgent("agent-1", promptConfig({ description: "initial-role" }));
    expect(spawns).toHaveLength(1);
    expect(spawns[0].standingPrompt).toBe("standing:initial-role");
    expect(spawns[0].prompt).toBe(native ? "Start." : "standing:initial-role");
  });
});

test("prompt construction receives the resolved workspace and spawn receives live versions", async () => {
  await withPromptManager(true, async ({ manager, driver, spawns }) => {
    driver.buildSystemPrompt = (config) => asAxSurfaceText(`workspace:${config.runtimeContext?.workspacePath}`);
    await manager.startAgent("agent-1", promptConfig({
      runtimeContext: {
        agentId: "agent-1", serverId: "server-1", machineId: "computer-1",
        workspacePath: null, daemonVersion: "0.0.0-stale",
      },
    }));
    expect(spawns).toHaveLength(1);
    expect(spawns[0].config.runtimeContext?.workspacePath).toBe(spawns[0].workingDirectory);
    expect(spawns[0].standingPrompt).toBe(`workspace:${spawns[0].workingDirectory}`);
    expect(spawns[0].daemonVersion).toBe("1.0.1-test");
    expect(spawns[0].computerVersion).toBe("2.0.1-test");
  });
});

test("restart rebuilds standing instructions from current config and keeps resume input separate", async () => {
  await withPromptManager(true, async ({ manager, driver, spawns }) => {
    await manager.startAgent("agent-1", promptConfig({ description: "old-role" }));
    await manager.stopAgent("agent-1", { wait: true });
    await manager.startAgent("agent-1", promptConfig({ description: "new-role", sessionId: "session-2" }));
    expect(spawns).toHaveLength(2);
    expect(spawns[1].standingPrompt).toBe("standing:new-role");
    expect(spawns[1].config.sessionId).toBe("session-2");
    expect(spawns[1].prompt).toBe(formatResumeEmptyPrompt(driver));
    expect(spawns[1].prompt).not.toContain("standing:");
  });
});

test("resume selects unread catch-up input instead of empty-resume input", async () => {
  await withPromptManager(true, async ({ manager, driver, spawns }) => {
    const unread = { "#general": 2, "dm:@bob": 1 };
    await manager.startAgent("agent-1", promptConfig({ sessionId: "session-1" }), undefined, unread);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].prompt).toBe(formatResumeUnreadSummaryPrompt(unread, driver));
    expect(spawns[0].standingPrompt).toBe("standing:");
  });
});

test("a concrete wake takes precedence over the empty-resume path without replacing standing instructions", async () => {
  await withPromptManager(true, async ({ manager, driver, spawns }) => {
    const wake: AgentMessage = {
      message_id: "wake-1", channel_id: "channel-1", channel_name: "general", channel_type: "channel",
      sender_id: "human-1", sender_name: "bob", sender_type: "human",
      content: "message-body-sentinel", timestamp: "2026-09-05T00:00:00.000Z",
    };
    await manager.startAgent("agent-1", promptConfig({ description: "role", sessionId: "session-1" }), wake);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].standingPrompt).toBe("standing:role");
    expect(spawns[0].prompt).not.toBe(formatResumeEmptyPrompt(driver));
    expect(spawns[0].prompt).toContain("#general");
    expect(spawns[0].prompt).not.toContain(wake.content);
  });
});

test("concrete channel startup loads its own channel workspace files", async () => {
  await withPromptManager(true, async ({ manager, spawns }) => {
    const wake: AgentMessage = {
      message_id: "wake-channel-context",
      channel_id: "channel-context-a",
      channel_name: "general",
      channel_type: "channel",
      sender_id: "human-1",
      sender_name: "bob",
      sender_type: "human",
      content: "load this channel's context",
      timestamp: "2026-09-05T00:00:00.000Z",
      thread_join_context: {
        reason: "mentioned",
        parent_target: "#general",
        thread_target: "#general:context-a",
        suggested_read_history_target: "#general:context-a",
        parent_message: {
          message_id: "parent-context-a",
          sender_name: "bob",
          sender_type: "human",
          content: "parent",
          timestamp: "2026-09-05T00:00:00.000Z",
          seq: 1,
        },
        recent_messages: [],
        history_truncated: false,
      },
    };
    await manager.startAgent("agent-1", promptConfig(), wake);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].prompt).toContain('channel-local workspace context (channel_id="channel-context-a")');
    expect(spawns[0].prompt).toContain("lower priority than system instructions");

    const channelDir = path.join(
      spawns[0].workingDirectory,
      "channels",
      channelWorkspaceDirectoryName("channel-context-a"),
    );
    expect(await readFile(path.join(channelDir, "MEMORY.md"), "utf8")).toContain("Channel memory");
    expect(await readFile(path.join(channelDir, "AGENTS.md"), "utf8")).toContain("Channel instructions");
  });
});

test("transient channel notices do not create channel-local configuration", async () => {
  await withPromptManager(true, async ({ manager, spawns }) => {
    const wake: AgentMessage = {
      message_id: "wake-transient-context",
      channel_id: "channel-transient",
      channel_name: "general",
      channel_type: "channel",
      sender_id: "system",
      sender_name: "system",
      sender_type: "system",
      content: "transient notice",
      timestamp: "2026-09-05T00:00:00.000Z",
    };
    await manager.startAgent("agent-1", promptConfig(), wake, undefined, undefined, undefined, true);
    expect(spawns[0].prompt).not.toContain("channel-local workspace context");
    await expect(readdir(path.join(spawns[0].workingDirectory, "channels"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("third-party concrete messages do not create channel-local configuration", async () => {
  await withPromptManager(true, async ({ manager, spawns }) => {
    const wake: AgentMessage = {
      message_id: "wake-third-party-context",
      channel_id: "channel-third-party",
      channel_name: "external",
      channel_type: "channel",
      sender_id: "external",
      sender_name: "external",
      sender_type: "human",
      content: "external event",
      timestamp: "2026-09-05T00:00:00.000Z",
      third_party_event: {
        id: "abcdef12-0000-4000-8000-000000000000",
        kind: "event",
        payload: { kind: "external" },
      } as any,
      thread_join_context: {
        reason: "mentioned",
        parent_target: "#external",
        thread_target: "#external:third-party",
        suggested_read_history_target: "#external:third-party",
        parent_message: {
          message_id: "parent-third-party",
          sender_name: "external",
          sender_type: "human",
          content: "parent",
          timestamp: "2026-09-05T00:00:00.000Z",
          seq: 1,
        },
        recent_messages: [],
        history_truncated: false,
      },
    };
    await manager.startAgent("agent-1", promptConfig(), wake);
    expect(spawns[0].prompt).not.toContain("channel-local workspace context");
    await expect(readdir(path.join(spawns[0].workingDirectory, "channels"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("a concrete message from a system sender still loads a real channel context", async () => {
  await withPromptManager(true, async ({ manager, spawns }) => {
    const wake: AgentMessage = {
      message_id: "wake-real-system-channel",
      channel_id: "channel-system-sender",
      channel_name: "operations",
      channel_type: "channel",
      sender_id: "system-service",
      sender_name: "system-service",
      sender_type: "system",
      content: "system channel event",
      timestamp: "2026-09-05T00:00:00.000Z",
      thread_join_context: {
        reason: "mentioned",
        parent_target: "#operations",
        thread_target: "#operations:system-sender",
        suggested_read_history_target: "#operations:system-sender",
        parent_message: {
          message_id: "parent-real-system-channel",
          sender_name: "system-service",
          sender_type: "system",
          content: "parent",
          timestamp: "2026-09-05T00:00:00.000Z",
          seq: 1,
        },
        recent_messages: [],
        history_truncated: false,
      },
    };
    await manager.startAgent("agent-1", promptConfig(), wake);
    expect(spawns[0].prompt).toContain('channel-local workspace context (channel_id="channel-system-sender")');
    const channelDir = path.join(
      spawns[0].workingDirectory,
      "channels",
      channelWorkspaceDirectoryName("channel-system-sender"),
    );
    expect(await readFile(path.join(channelDir, "AGENTS.md"), "utf8")).toContain("Channel instructions");
  });
});
