# Manual local secure input (first phase)

The chat composer lock button opens a separate form for selecting an agent and
naming an input. It works without an agent request and does not change the chat
draft. The form never contains the input value. It requires explicit consent to
create an **agent-readable local file** before opening a native macOS hidden-input
dialog on the selected Computer. The signed-in human must own that Computer.

This phase is not a model-inaccessible vault. Agents with filesystem access can
read the file and may send its contents to their model. Files are plaintext on
disk with restrictive permissions, not application-encrypted. The UI states that
the protected vault mode is unavailable; it never silently downgrades that mode.

## Data flow and permissions

- The authenticated, verified-user `/api/secure-input` API accepts metadata only:
  conversation, recipient, request UUID, input name, lifetime, operation, and consent.
  Unexpected fields (including a value) are rejected. Do not enter secrets in the
  name field.
- Both the human and recipient agent must have access to the source conversation.
  The agent must reside on the human's connected Computer and advertise
  `secure-input:native-file-v1`. Current placement and access are checked again
  after collection and before notifying the agent.
- The daemon invokes `/usr/bin/osascript` locally. The value is captured locally
  from stdout; it is absent from command arguments, protocol messages, server
  storage, and the browser form. Native dialog error output is not forwarded.
- The daemon writes a generated UUID file under `~/.raft/secure-input` (directory
  mode 0700, files mode 0600). A UUID must match its original owner, agent, name,
  and lifetime when replayed. The store refuses symlink roots and file records.
- Only the local path, name, and expiry are sent as a human message to the selected
  agent's private DM. The source public channel does not receive that reference.
  Replaying an identical request reuses the same message random ID.

Directory permissions do not isolate agents running as the same operating-system
user. Do not use this phase when the value must remain inaccessible to the agent
or its model. A separate OS-enforced broker would be needed for that guarantee.

## Lifetime, cancellation, and rollout

The UI uses a one-hour lifetime; the API allows 60 seconds through 24 hours.
The daemon removes expired records at startup and every minute while running.
An offline Computer removes them when its daemon resumes, rather than while it
is offline. The result screen offers local file deletion. Deletion cannot revoke
copies or prior reads. An invalid or incomplete result never returns a value.

Closing the browser dialog cancels the pending HTTP request and sends cancellation
to the native prompt. Collection has bounded native and server timeouts. If saving
has already committed, cancellation does not guarantee removal: check the Computer
or retry the same request to obtain its metadata and delete it. Stopping the daemon
aborts prompts. No automatic model-driven input popup is implemented.

Native collection currently requires macOS with an interactive desktop session.
Headless or non-macOS Computers are unsupported. The server transport currently
requires the selected Computer's connection to be local to that server process.
Old Computers do not advertise the capability and are excluded from the picker.
Deploying the server/web alone does not upgrade an existing Computer.

## Validation

Automated coverage includes local exact-value preservation, permissions, UUID
replay, owner mismatch, cancellation, expiry, deletion and unsafe paths; actual
HTTP authorization, private-DM notification and duplicate request handling; and
manual web entry, consent gating, metadata-only submission and unchanged chat
state. Package typechecks and the web production build must pass.

For interactive acceptance on a test Mac, install a build of this daemon, open a
conversation with an eligible agent, click the lock, and consent using a synthetic
value. Confirm the hidden native dialog appears on that Computer, the private DM
contains only its reference, and the local file matches the synthetic value with
0600 permissions. Delete it through the result screen and verify removal. Repeat
with Cancel and closing the browser dialog. Never use real credentials for this
acceptance check. The development validation compiled the AppleScript and tested
an injected collector; an interactive native-dialog end-to-end run is still an
acceptance step.

## Baseline prerequisites

This branch separately repairs a missing server `parseDeploymentConfig` import
and five migration journal tag prefixes (`374`–`378` to `0374`–`0378`) that prevented
fresh database test startup. It does not rewrite historical migration timestamps.
Some existing timestamp ordering predates upstream migrations; release owners
must review upgrade behavior for existing databases before deployment.
