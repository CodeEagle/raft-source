# Delegation contracts, phase 1

This opt-in protocol records delegated task ownership, checks requested capabilities before launching a worker, and preserves a blocked worker's checkpoint for explicit continuation. It does **not** enforce a coordinator tool gateway or provide a host-operation broker. `delegate_required` requests fail with `delegation_enforcement_unsupported`; they never fall back to ordinary execution.

The contract and adapter interface are runtime-neutral. The currently integrated adapter is the existing on-device Codex workspace worker. Other runtime adapters are not enabled by this change. Its capability evidence reports only `workspace.write`, based on the adapter's workspace-write profile plus existing directory revalidation. Git metadata, Docker, listening ports, installation and deployment are **unknown**, not inferred from workspace-write. No permissions or existing sandbox settings are widened.

## Compatibility and rollout

Apply the additive nullable migration `0340_delegation_records` before starting the updated server. Existing rows have `delegation = null`; absent `delegation` in a create request retains the legacy protocol. No backfill or automatic conversion occurs. Upgrade the daemon before using opt-in contracts; it advertises `agent:workspace:delegation-v1` in its authenticated ready message. An updated server refuses contracted dispatch when that capability is absent, the socket is stale, or the machine is not owned by this server replica. The latter is a conservative phase-1 limitation: cross-replica contracted dispatch is not implemented. Ordinary legacy dispatch remains unchanged.

An updated daemon connected to an older server continues to handle its legacy requests. Optional fields do not establish hard enforcement. Deploying this feature requires normal review and deployment authorization; this document does not request or perform a deployment.

## Authenticated API

Use the existing authenticated channel workspace API with a normal human access token and `X-Server-Id` header. No new agent credential, hidden endpoint, or shell permission is created. The caller needs the existing channel workspace/task management permissions. There is no UI control for this opt-in yet.

`POST /api/channels/:channelId/workspaces/:agentId/tasks`:

```json
{
  "workspaceId": "<bound-writer-workspace-id>",
  "idempotencyKey": "<new-uuid>",
  "instruction": "Implement the health endpoint and verify it.",
  "delegation": {
    "mode": "delegated",
    "requiredCapabilities": ["workspace.write"]
  }
}
```

The server creates and persists a version-1 contract with the canonical resource root/revision, task ID, run ID, worker owner and attempt ID. It adds `workspace.write` to requirements, removes duplicates and sorts them. Reusing an idempotency key with a different opt-in, mode, or requirement set is a conflict. `requiredCapabilities: ["docker.run"]` is accepted as a requirement but the current adapter blocks before launch with `capability_unknown:docker.run`. Unknown, denied and unavailable are separate capability results. No destructive probe is used.

`GET /api/channels/:channelId/workspaces/:agentId/tasks` returns each run's typed `delegation` metadata as well as the display result. Worker updates are authenticated by the existing machine/agent/run/task/lease checks and the exact attempt ID. A stale attempt cannot complete the next attempt.

## Worker result format

The worker receives the contract and must finish with a single final line `RAFT_DELEGATION_RESULT=` followed by JSON. Earlier progress text is allowed. JSON-only output is also accepted; prose or malformed objects fail instead of becoming reviewable. A turn ending is not sufficient for contracted success.

Completed result:

```text
RAFT_DELEGATION_RESULT={"version":1,"kind":"completed","summary":"Implemented the endpoint; endpoint tests passed."}
```

Blocked result:

```text
RAFT_DELEGATION_RESULT={"version":1,"kind":"needs_operation","summary":"Commit is blocked; verification remains.","operation":{"capability":"git.commit","description":"Commit the prepared changes","reason":"policy_denied"},"checkpoint":{"id":"checkpoint-1","stateFingerprint":"working-tree fingerprint","completed":["implemented endpoint"],"remaining":["verify committed change"]}}
```

Other outcomes are `failed` and `cancelled`, each with `version: 1` and a nonempty summary. Strings are bounded (summary/checkpoint descriptions at most 800 characters; identifiers at most 200), checkpoint lists at most eight entries, and remaining work must be nonempty for `needs_operation`.

A valid blocked result is persisted in JSONB and the machine-local ledger, reported as `blocked`, and never moves the task to `in_review`. It is accepted only after the worker process group is confirmed stopped; uncertain stopping retains the writer lock. Reconnect, duplicate creation, and an empty retry do not replay checkpointed work.

## Explicit continuation

After handling the precise operation through an already authorized, permitted channel, use the existing authenticated retry endpoint:

`POST /api/channels/:channelId/workspaces/:agentId/tasks/:runId/retry`:

```json
{
  "continuation": {
    "previousAttemptId": "<contract-attempt-id>",
    "checkpointId": "checkpoint-1",
    "workerId": "<original-worker-owner-id>",
    "receipt": "Describe the precise permitted operation and verified result."
  }
}
```

The receipt is an audit statement, **not** an execution grant and not a host operation request. The API does not execute the blocked operation or approve a bypass of a policy denial. The server copies the authoritative checkpoint, retains the same task, resource, requirements and worker owner, checks current binding/revision/assignment, and creates a fresh attempt. It consumes the checkpoint through a conditional state update; duplicate receipts and changed ownership are rejected. The local ledger verifies the same continuation before resetting a stopped blocked attempt. A new process is launched under the existing workspace sandbox with the preserved completed/remaining plan. The worker is instructed to verify actual state against the checkpoint and stop if it diverges; this comparison remains a behavioral requirement in phase 1, not a cryptographically verified tree measurement.

Once a blocked worker is confirmed stopped, its active path writer reservation is released. Other tasks may change the project before continuation. This phase does not provide a continuous logical lock across a host-operation handoff; the continuation acquires a fresh writer lease. Exact checkpoint metadata matching is enforced, but actual filesystem-state comparison is still behavioral, as described above.

Cancellation prohibits continuation and wins a late completion race. Stop uncertainty does not release a resource merely because time passed. Queued continuation metadata survives restart; execution still waits for a current compatible conversation context. The original user instruction is retained, and the checkpoint specifies which work remains; completed operations must not be repeated.

## Limits and next phase

Only the current outcome and the previous checkpoint/receipt are retained in the typed run record; an append-only full attempt audit history is not included.

No coordinator tool gateway, automatic host exceptions, replacement-worker transfer, cross-replica capability routing, operation broker or all-runtime integration is included. The API retains the current authorized manager and original worker owner; continuation does not broaden scope. Terminal invalid-result failure is not silently retried. UI controls and further runtime adapters can use the common schemas after implementing their own measured capabilities and lifecycle guarantees. Phase 2 must add real tool mediation before advertising hard enforcement.
