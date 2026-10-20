# Thread mention context selection

When an agent is mentioned in a thread, the server still supplies the original
root plus earlier thread messages. Instead of always taking the last six replies,
selection considers the latest 48 earlier replies (one extra database row detects
older history). It prioritizes the latest human request, explicit message references
inside those candidates, the most recent reply, opening human context within that
window, and then recent non-system progress. Selected messages are emitted in
chronological order.

The earlier-reply payload stays at most six complete messages and 24,000 UTF-16
code units of message bodies. The root and current incoming request remain complete
and separate, outside this budget. This is not a total runtime-prompt token limit.
Oversize earlier replies are omitted, not clipped. The daemon explicitly identifies
omitted history and retains the exact `raft message read --target` entry point.
An empty selected payload does not imply that the thread has no earlier replies.

This is deterministic presentation selection, not a summary model or access policy.
A message reference only ranks candidates already supplied from the same thread;
it cannot fetch another message, activate a topic, change membership, or broaden
read permissions. No database migration or wire-type change is required. The existing
`recent_messages` array now contains selected original replies and may have gaps.
Older daemons still display its original text and the `history_truncated` flag.
Model-visible receipt lists contain only actual source message IDs. Existing follow,
startup/catch-up/live projection and receipt handling are preserved.

Limitations: decisions older than the candidate window are not searched automatically;
references outside that window are not expanded; the root/current request are not
budgeted; there is no guarantee that a heuristic selection captures every decision.
Agents must use the supplied history entry point when more context is needed. This
change does not implement per-channel/per-agent mention-only visibility settings,
persistent topic authorization, or unthreaded-channel context collection.

Validation: selector cases cover buried human requests, later corrections, bounded
references, duplicate/current/future rows, window and body limits, and unchanged
short history. PGlite integration verifies late mention delivery and exclusion of
an unrelated parent-channel reference. Daemon tests verify honest omitted-history
rendering, exact source receipts and fresh/resumed/suppressed context projection.
Server and daemon type checks pass on the isolated enhancement baseline.
