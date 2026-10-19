import type { AgentContext } from "./auth/env";
import {
  CHANNEL_WORKSPACE_MAX_BYTES,
  channelWorkspaceDirectoryName,
  channelWorkspaceDirectoryPath,
  formatChannelWorkspaceContextBlock,
  loadChannelWorkspaceContextSync,
  loadChannelWorkspaceContextsSync,
  type ChannelWorkspaceContext,
  type ChannelWorkspaceContextEntry,
} from "@botiverse/raft-shared/src/channelWorkspaceContextNode";

export {
  CHANNEL_WORKSPACE_MAX_BYTES,
  channelWorkspaceDirectoryName,
  channelWorkspaceDirectoryPath,
  formatChannelWorkspaceContextBlock,
};
export type { ChannelWorkspaceContext, ChannelWorkspaceContextEntry };

export type ChannelWorkspaceContextMap = ReadonlyMap<string, ChannelWorkspaceContextEntry>;

/** CLI's synchronous seam delegates all filesystem safety to shared Node code. */
export function loadChannelWorkspaceContext(agentWorkspacePath: string, channelId: string): ChannelWorkspaceContext {
  return loadChannelWorkspaceContextSync(agentWorkspacePath, channelId);
}

function normalizedWorkspacePath(env: NodeJS.ProcessEnv): string | null {
  const workspace = env.SLOCK_CURRENT_WORKSPACE_PATH?.trim();
  return workspace ? workspace : null;
}

/** Managed runners receive the workspace path from the daemon; external agents do not. */
export function resolveManagedWorkspacePath(
  agentContext: Pick<AgentContext, "clientMode">,
  env: NodeJS.ProcessEnv,
): string | null {
  return agentContext.clientMode === "managed-runner" ? normalizedWorkspacePath(env) : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Load channel context once per channel. A single bad file is represented as a
 * per-channel error so the caller can still print that message's body.
 */
export function loadChannelWorkspaceContextsForMessages(
  agentContext: Pick<AgentContext, "clientMode">,
  env: NodeJS.ProcessEnv,
  messages: ReadonlyArray<Record<string, unknown>>,
): ChannelWorkspaceContextMap {
  const workspacePath = resolveManagedWorkspacePath(agentContext, env);
  if (!workspacePath) return new Map();

  const errors = new Map<string, ChannelWorkspaceContextEntry>();
  const contextMessages = messages.map((message) => ({
    channel_id: typeof message.channel_id === "string" ? message.channel_id : null,
    third_party_event: message.third_party_event,
  }));
  const contexts = loadChannelWorkspaceContextsSync(
    workspacePath,
    contextMessages,
    (channelId, error) => errors.set(channelId, { error: errorText(error) }),
  );
  const entries = new Map<string, ChannelWorkspaceContextEntry>();
  for (const [channelId, context] of contexts) entries.set(channelId, { context });
  for (const [channelId, entry] of errors) {
    if (!entries.has(channelId)) entries.set(channelId, entry);
  }
  return entries;
}
