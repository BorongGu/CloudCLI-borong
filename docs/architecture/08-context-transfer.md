# Session context transfer

Orbit's context-transfer module captures **one source session**, produces an
attributed context package, and hands it to any ordinary session. It is independent
of Group coordination. Source and target may use different harnesses.

## The two dimensions

| Scope / detail | `coarse` — communication and synthesis | `fine` — handoff |
| --- | --- | --- |
| `all_topics` | A topic map covering the source session, with cited goals, constraints, facts, decisions and disagreements | The same scope, with execution evidence, artifacts, checks and next steps |
| `recent_topic` | The current objective, its follow-ups and the earlier decisions it depends on | That topic's execution state and the evidence needed to continue it |

Scope refers to the selected session's available normalized transcript. The
source session's current branch is captured in an immutable snapshot; its stable
record refs (`r1`, `r2`, …), timestamp and fingerprint survive later turns.
Compaction summaries remain labeled, provider output limits remain explicit,
and a working source is marked as a snapshot of persisted activity.

### Recent-topic selection

Semantic selection belongs to the calling agent, which can use its current
understanding of the task and read the snapshot. The backend supplies a complete,
paginated turn index and original normalized records. This avoids adding another
model call to every transfer.

The caller identifies the latest substantive objective, combines clarifications
and resumed discussion, and provides:

- `focus`: one or more turn ranges containing the active topic, including the latest turn;
- `background`: earlier dependency ranges, each with a reason;
- `title`, `rationale` and `confidence` describing the boundary.

For example, cache design in turns 1–2, a travel detour in turn 3, and a return to
the cache in turn 4 can use focus `4..4` and background `1..2`. Short instructions
such as “continue” inherit their objective from the earlier selected turns.
Revisions should retain the relevant prior decision and label it `superseded`.
Open questions and disagreement should remain visible in the briefing.

The backend validates that ranges exist, focus includes the latest turn, the topic
map covers every selected turn, and each briefing item cites records within that
scope. The caller authors the semantic claims; citation validation establishes
their provenance, while the receiving agent evaluates their content.

## Calling the capability

The implemented entry points are authenticated REST and the portable shell CLI
`scripts/orbit-context.mjs`. The CLI is usable from all four harnesses' shell tools.
REST accepts the browser JWT or an existing Orbit `x-api-key`.

1. `POST /api/context/prepare` with `{ "sessionId": "source-app-id" }` freezes
   the source and returns metadata, the first page of its turn index, synthesis
   instructions and a package example.
2. Read further index pages at `GET /snapshots/:id/outline?offset=50&limit=50`.
   Read source evidence at `GET /snapshots/:id/records?turn=4`, `?ref=r7`, or
   `?offset=50&limit=50`. Refs and turn numbers belong to this snapshot.
3. `POST /packages` validates the scope and cited briefing, and creates the package.
4. `GET /packages/:id` returns the briefing and manifest; `/packages/:id/records`
   supports pagination and `?ref=...` for exact evidence retrieval.
5. `POST /packages/:id/deliver` hands the package to an existing target session.
   A new target can first be allocated through the normal
   `POST /api/providers/sessions` API with its chosen harness and project.

All paths after step 1 are relative to `/api/context`.

Example package creation:

```json
{
  "snapshotId": "snapshot-id",
  "scope": {
    "kind": "recent_topic",
    "title": "Cache implementation",
    "rationale": "The latest instruction resumes cache work after a separate topic.",
    "confidence": "high",
    "focus": [{ "from": 4, "to": 4 }],
    "background": [{ "from": 1, "to": 2, "reason": "Encryption constraint and implementation state." }]
  },
  "granularity": "fine",
  "maxChars": 64000,
  "briefing": {
    "author": "source agent",
    "topics": [
      { "title": "Cache design and implementation", "summary": "SQLite cache with encrypted values; verification is pending.", "turns": [1, 2, 4] }
    ],
    "items": [
      { "kind": "constraint", "status": "reported", "text": "Preserve encrypted values.", "refs": ["r1"] },
      { "kind": "artifact", "status": "observed", "text": "cache.ts was written.", "refs": ["r4"] },
      { "kind": "next_step", "status": "proposed", "text": "Run the cache tests.", "refs": ["r8"] }
    ]
  }
}
```

Briefing item kinds are `goal`, `constraint`, `fact`, `decision`, `disagreement`,
`progress`, `artifact`, `verification`, `open_question` and `next_step`.
Statuses are `observed`, `reported`, `proposed`, `uncertain` and `superseded`.
Choose whichever items the task needs and support them with evidence.

### Delivery

```json
{
  "targetSessionId": "target-app-id",
  "mode": "attach",
  "instruction": "Use this context when answering my next question.",
  "requestId": "a-stable-unique-id"
}
```

| Mode | Behavior |
| --- | --- |
| `attach` (default) | Queue a context attachment. The target's next normal turn atomically claims and consumes it. |
| `start` | Start a registered normal turn with the package and instruction. A busy target returns 409 with its existing work preserved. |
| `steer` | Request the harness's live-input primitive; store its explicit acceptance or failure. |

All four harnesses receive `attach` and `start` through the shared runtime gateway.
Live steering is capability-dependent: Codex exposes it for ordinary sessions;
the current Claude/OpenCode live channels are enabled by their Group adapters;
Cursor uses next-turn attachment. Group member targets use their public discussion
and are excluded from this ordinary-session delivery route.

`requestId` is idempotent per user and binds the package, target, mode and
instruction. Poll `GET /deliveries/:id` for the durable receipt. Pending
attachments can be cancelled with `DELETE /deliveries/:id`.

Statuses: `pending` → `submitting` → `delivered`, `failed` or `uncertain`.
For normal turns, `delivered` means the provider completed the consuming run;
for steer, it means native acceptance. Provider errors and server restarts during
submission leave an `uncertain` receipt for inspection. Retrying with the same
request id returns that receipt and preserves single submission.

### CLI

Store the connection in a user-readable-only file:

```json
{ "url": "http://100.64.0.46:3001/api/context", "apiKey": "YOUR_ORBIT_API_KEY" }
```

```sh
node scripts/orbit-context.mjs --connection /path/to/connection.json prepare < source.json
node scripts/orbit-context.mjs --connection /path/to/connection.json create < package-input.json
node scripts/orbit-context.mjs --connection /path/to/connection.json deliver < delivery-input.json
```

`--help` lists all operation inputs. On a failed delivery request, the CLI reports
the generated request id so a retry can reuse it. `get`, `outline`, `records`,
`delivery`, `cancel` and `delete` provide readback and lifecycle operations.
Package installation also exposes `orbit-context`; this host's deployment adds
the same launcher under `~/.local/bin/`.

Possible clients of the same API include a chat `/context` or `/handoff` command,
a session menu, an MCP wrapper exposing prepare/read/create/deliver tools, and
workflow steps. These UI/MCP wrappers can follow the same semantic authoring
protocol and reuse the existing backend.

## Budgets, provenance and storage

`maxChars` bounds the injected text: default 16,000 for coarse and 64,000 for fine,
maximum 160,000. The full cited briefing must fit. Fine packages add complete
source records, prioritizing cited evidence, until the budget is reached.
The manifest lists `inlineRefs` and `omittedRefs`; all selected evidence is retained
in the record endpoint and `records.jsonl`. A coarse briefing uses those references
for optional deeper reading.

Artifacts live beside the Orbit database under `context-packages/<uuid>/`:
`briefing.md`, `package.json` (including selected records) and `records.jsonl`.
Directories use mode 0700 and files use 0600. Any local harness running as the
same user can read those paths; remote API clients can fetch the same records.
Attachments are represented by recorded metadata/path references. File content
and repository state should be rechecked by the recipient when executing a handoff.

Snapshots are explicit persisted exports, owned by the requesting Orbit user.
They retain evidence after source changes/deletion. `DELETE /snapshots/:id`
removes its packages, local exports and pending receipts; an in-flight submission
must settle first. No model call is made by prepare, read or package creation.

## Modules

`context-transfer` owns source capture, semantic-manifest validation, package
rendering and delivery. `database/context-transfer.db.ts` owns persistence and
atomic claims. `providers/provider-runtime.service.ts` consumes pending context
before the existing provider run. The ordinary websocket run registry handles
new target turns and live output as usual.
