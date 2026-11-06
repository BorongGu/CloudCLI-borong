# Groups: peer communication primitives

Groups provide 2–5 persistent, equal members. Each member owns a dedicated Orbit
session using Claude Code, Codex, Cursor, or OpenCode. A group task contains shared
instructions and optional per-member notes; all members receive the complete task
and the roster of notes. Roles, research methods, and workflows are task content.

Open **Groups** from either sidebar layout, create members and select their
workspace, harness, optional model ID, and execution permissions. Creation only
allocates sessions. **Dispatch to all members** queues the actual model turns.
Members' full transcripts and permission requests are available through their
session links.

## Communication

| Operation | Visibility | Delivery |
| --- | --- | --- |
| `send` | Recipient and sender; `to: "*"` shares with the group | Queues a turn for recipients |
| `publish` | Entire group | Durable shared information; supplied with subsequent group turns and available via `read` |
| `request` | One recipient and sender | Queues a turn; its message ID links subsequent replies |
| `reply` | Original sender and replying member | Queues a turn for the original sender; replies to the human remain on the group timeline |
| `read` | Public messages and that member's direct messages | Read-only; supports `after`, `publishedOnly`, `nextCursor`, and `hasMore` |

The human owner can inspect all group messages. The group timeline contains
explicit communication; each member's ordinary assistant output stays in its
provider conversation. Published information is immutable; publish a correction
or an updated finding as another item. Requests can receive follow-up replies.

Each write has a caller-scoped `requestId`. Repeating the same request returns the
existing event and preserves its deliveries. A changed payload requires a new ID.
The CLI generates IDs and prints them on success and on ambiguous transport errors
so a retry can reuse the original identity.

## Harness-independent CLI

Every group turn includes the member roster, primitive descriptions, the command
for the member's private connection file, incoming messages, and a bounded batch
of newly published information. For example:

```sh
node /path/to/orbit/scripts/orbit-group.mjs --connection /private/member.json request <<'GROUP_JSON'
{"to":"B","content":"Which interface fits?","requestId":"interface-question-1"}
GROUP_JSON
```

The connection file contains a member-scoped bearer credential and this server's
local address. Files use mode 0600 under the database's adjacent `groups/`
directory; the database stores credential hashes. The bridge resolves identity
and group from that credential, checks direct-message visibility, and validates
reply targets. All members run as the local OS user; this credential scoping is
an API boundary, while shell access follows each harness's selected permissions.

The CLI uses the existing shell tool in each harness. The runtime adapters keep
their existing model execution and permission behavior. A future native MCP
adapter can expose these same primitives over the same service.

## Dispatch and recovery

`agent_groups`, `group_members`, `group_messages`, and `group_deliveries` live in
Orbit's SQLite database. Message insertion and recipient creation are atomic.
The server dispatcher claims a chronological batch for each idle member, reserves
one group turn, and invokes `runDetachedChatTurn`. Live transcripts retain the
normal websocket subscription and replay behavior.

Busy sessions and sessions with background work retain their queued messages.
Claims and the run registry prevent overlapping turns; a reservation race returns
the batch to the queue. Explicit sends, requests, and replies can resume peers.
Publishing alone leaves peers at their current activity.

The task's run allowance counts provider-turn starts, including later message
wakeups. It is an invocation limit rather than token accounting. Reaching zero
retains queued work. **Continue dispatching** sets a fresh allowance; **Pause
dispatching** stops future dispatches while current turns continue. Stop a current
turn from its member session.

Delivery states are `queued`, `running`, `completed`, `failed`, and `interrupted`.
`completed` records that the provider turn ended successfully, not that a request
has been answered. Replies are separate events linked by `replyTo`. Provider
errors remain visible. After a server restart, queued messages are retained and
running deliveries become interrupted. Inspect the member transcript before
explicitly retrying an interrupted turn because its previous execution may have
produced side effects.

## Boundaries and endpoints

- `server/modules/groups`: validated user/member endpoints, communication service,
  connection-file provisioning, and server-owned dispatcher.
- `server/modules/database/repositories/groups.db.ts`: transactional persistence.
- `src/modules/groups`: group creation, shared task dispatch, conversation and
  publication views. Recent snapshots contain 150 messages and 100 publications;
  the read endpoint paginates the full persisted history.
- `scripts/orbit-group.mjs`: provider-neutral JSON CLI.

User-authenticated routes:

```text
GET/POST /api/groups
GET/PATCH /api/groups/:id
GET/POST /api/groups/:id/messages
POST /api/groups/:id/dispatch
```

Member-authenticated route: `POST /group-bridge/:operation`.

Run the Groups backend tests for persistence, visibility, idempotency, runtime
reservation, pause/allowance, recovery, HTTP validation, and the three-member CLI
request/reply/publication loop. Run the Groups frontend tests for task notes,
retry identity, publishing, and group creation. Real model behavior remains a
separate smoke test from these deterministic runtime tests.
