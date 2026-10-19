// Keep one security-critical filesystem implementation for both daemon
// delivery and CLI history reads. This local seam preserves existing imports
// without duplicating path, symlink, size-bound, or formatting behavior.
export {
  CHANNEL_WORKSPACE_MAX_BYTES,
  channelWorkspaceDirectoryName,
  channelWorkspaceDirectoryPath,
  formatChannelWorkspaceContextBlock,
  loadChannelWorkspaceContext,
  loadChannelWorkspaceContexts,
  loadChannelWorkspaceContextSync,
  loadChannelWorkspaceContextsSync,
  type ChannelWorkspaceContext,
  type ChannelWorkspaceContextEntry,
  type ChannelWorkspaceContextLoadErrorHandler,
} from "@botiverse/raft-shared/src/channelWorkspaceContextNode";
