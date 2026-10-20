import type { AgentThreadContextMessage } from "@botiverse/raft-shared";

/** Presentation limits only. Callers must supply already-authorized messages
 * from ONE thread; this selector neither fetches history nor grants access. */
export const THREAD_CONTEXT_CANDIDATE_LIMIT = 48;
export const THREAD_CONTEXT_MESSAGE_LIMIT = 6;
export const THREAD_CONTEXT_BODY_BUDGET = 24_000;

/**
 * Keep source messages intact so model-visible receipts still refer to exactly
 * what was rendered. The root and current request are carried separately and
 * are not charged to this earlier-reply budget. Oversize replies are omitted,
 * never silently clipped or acknowledged as fully shown.
 */
export function selectThreadContextMessages<T extends AgentThreadContextMessage>(input: {
  candidates: readonly T[];
  beforeSeq: number;
  triggerContent: string;
  rootMessageId: string;
}): { messages: T[]; historyTruncated: boolean } {
  const seen = new Set<string>();
  const eligible = input.candidates
    .filter((message) => message.message_id !== input.rootMessageId &&
      typeof message.seq === "number" && Number.isSafeInteger(message.seq) && message.seq < input.beforeSeq)
    .sort((a, b) => a.seq! - b.seq!)
    .filter((message) => {
      if (seen.has(message.message_id)) return false;
      seen.add(message.message_id);
      return true;
    });
  const candidates = eligible.slice(-THREAD_CONTEXT_CANDIDATE_LIMIT);
  const selected = new Set<T>();
  let remaining = THREAD_CONTEXT_BODY_BUDGET;
  const add = (message: T | undefined) => {
    if (!message || selected.has(message) || selected.size >= THREAD_CONTEXT_MESSAGE_LIMIT) return;
    if (message.content.length > remaining) return;
    selected.add(message);
    remaining -= message.content.length;
  };
  const newestFirst = [...candidates].reverse();
  // Human instructions must survive long runs of agent/system status updates.
  add(newestFirst.find((message) => message.sender_type === "human"));
  // Reference matching ranks only the supplied candidates. A textual reference
  // cannot authorize a read, create a follow, or pull another thread's content.
  for (const message of newestFirst) {
    const shortId = message.message_id.slice(0, 8);
    const shortReference = /^[0-9a-f]{8}$/i.test(shortId) &&
      new RegExp(`(?:msg=|:)${shortId}(?![0-9a-f])`, "i").test(input.triggerContent);
    if (input.triggerContent.includes(message.message_id) || shortReference) add(message);
  }
  add(newestFirst[0]);
  // Retain the opening human context when still inside the bounded candidate
  // window, instead of pretending the six latest status lines are the topic.
  add(candidates.find((message) => message.sender_type === "human") ??
    candidates.find((message) => message.sender_type !== "system"));
  for (const message of newestFirst) if (message.sender_type !== "system") add(message);
  for (const message of newestFirst) add(message);
  return {
    messages: candidates.filter((message) => selected.has(message)),
    historyTruncated: eligible.length > selected.size,
  };
}
