# Groups: public peer collaboration

Groups contain 2–5 equal members with independent provider sessions. A shared task
and optional per-member notes define the current objective and division of work.
The human owner can inspect the full public discussion, published knowledge,
member transcripts, tool calls/results, pending approvals, and workspace artifacts.

## Public discussion and mentions

Every group message is public. Mentions identify participants expected to respond;
`to` remains an alias for a primary mention for CLI compatibility. `mentions`
accepts member names/IDs, `user` for the human, and `*` for all other members.
The discussion composer also recognizes explicit `@name`, `@user`, and `@all`.

| Primitive | Purpose |
| --- | --- |
| `send` | Contribute to the public discussion, optionally mentioning participants. |
| `publish` | Preserve an important shared finding, decision, or correction. |
| `request` | Ask one or more mentioned participants, including the human, for a considered reply. |
| `reply` | Publicly answer a specific message using `replyTo`. A participant's reply closes their pending response. |
| `read` | Read the public discussion or published information; paginate with `after` and `nextCursor`. |

An active member receives other members' public updates during work through the
harness's live-input adapter. An idle member starts a new turn for a mention or a
shared task. Other public information remains available for their next participation.
A reply to a member wakes that member when needed. Publishing contributes context
without creating an automatic round of responses from idle peers.

Peer messages have a two-second coalescing window. Their delivery is batched;
human messages and task updates are immediately eligible. Mid-turn updates carry
the new information and participant identities instead of repeating the full
bootstrap instructions.

The concise English instruction is `GROUP_MODE_SYSTEM_PROMPT` in
`server/shared/utils.ts`, also visible in the group's settings. It requires
independent examination of evidence, critical assessment of peer claims, agreement
based on one's own judgment, and delayed, substantive replies. It encourages
combining related points while leaving acknowledgements, repeated agreement and
unchanged opinions silent. Task-specific roles and workflows remain user input.

## Console and human interaction

`/groups/:groupId` owns the public discussion, the current task, member cards,
model/reasoning menus, published information and pending responses. Questions for
the human appear prominently. Sending a discussion message and formally updating
the task are separate composer actions.

`/groups/:groupId/members/:memberId` presents the full native transcript, tools,
approvals, activity and Stop control within the group console. Discussion input
stays in the public group composer. Workspace artifacts open in the shared file
viewer. Model choices use ordinary chat's catalog and menu, and are stored against
the member session for subsequent turns.

Ordinary conversation lists, search, archived lists, project session counts and
sidebar broadcasts exclude group members. Legacy `/session/:sessionId` links
resolve group membership and redirect to the member console. The ordinary running
list excludes group members; Groups requests the complete activity list.

Recent snapshots contain 150 discussion messages and 100 publications. The owner
can page backward through the persisted history. The member CLI can page forward
through all public messages. Display limits affect initial presentation; stored
records remain available through pagination and the member console.

## Delivery and execution

| Harness | Working-member delivery |
| --- | --- |
| Codex | Native `turn/steer` with the expected active turn ID. |
| Claude Code | Priority input merged into the SDK's held input stream. |
| OpenCode | Authenticated native session input through an owned local server, retaining the CLI stream. |
| Cursor | Input on the next execution turn; the creation form labels this behavior. |

Codex receives the group instruction as native developer instructions. Claude
receives it through the SDK system-prompt extension. The group bootstrap carries
identity, the common task, member notes, and communication-tool usage. The
provider-neutral CLI uses a private member-scoped connection file; the database
stores credential hashes and resolves each caller's identity from its credential.

Delivery states distinguish `queued`, `delivering`, `delivered`, `running`,
`completed`, `failed`, and `interrupted`. `delivered` records acceptance into the
harness's input channel. A response is a separate public message. Passive context
for idle members is shown as available for later reading.

The automatic-start limit counts newly started member executions. Starting three
members uses three starts; inserting input into their active work uses the current
executions. Reaching zero retains pending work, while active turns can still
receive updates. Pause stops further dispatch. Current executions can be stopped
from their member consoles.

SQLite claims prevent duplicate concurrent deliveries. Each write has a
caller-scoped `requestId` for idempotent retries. An explicit native idle response
permits a new queued turn. Ambiguous transport failures remain inspectable rather
than being automatically resent. On restart, queued work is retained and an
in-flight delivery is marked interrupted for inspection before retry.

## Implementation and verification

- `server/modules/groups`: public discussion semantics, task input, connection
  files, history, pending responses and dispatcher.
- `server/modules/database/repositories/groups.db.ts`: atomic event/delivery
  persistence, mention wakeups, coalescing and session membership.
- Provider runtime adapters: native instructions and live input.
- `src/modules/groups`: separate group console and owner controls.
- `scripts/orbit-group.mjs`: `send`, `publish`, `request`, `reply`, and `read` over JSON stdin.

Tests cover public visibility, mention/reply relationships, native-input routing,
continued execution during delivery, batching, idle wakeups, model persistence,
ordinary-list isolation, replay/idempotency, recovery, and browser interactions.
Native adapter tests exercise scripted transports and local test servers so the
suite remains deterministic and independent of model quotas.
