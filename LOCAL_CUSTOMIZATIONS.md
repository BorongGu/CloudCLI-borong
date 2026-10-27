# Tailnet deployment and local customizations

This fork adds a shared Codex App Server integration, native Goals in web chat,
OpenCode Go account routing, and the current mobile/desktop interface changes.

## Native Codex Goals

Choose Codex in the chat model picker, then enter:

```text
/goal <objective>
/goal
/goal pause
/goal resume
/goal clear
```

The first command creates or updates the native thread goal. The remaining
commands inspect, pause, resume, or clear it. A row above the composer shows
the objective, status, token usage and elapsed time, with lifecycle controls.

Goals are persisted and advanced by the shared Codex daemon. CloudCLI observes
its automatic turns, retains native item ids, and forwards their output through
the existing websocket run registry. Reopening a chat reads its current native
goal; a running goal is reattached through `chat.subscribe` with `watchGoal`.
Setting or resuming a goal relies on Codex's own continuation mechanism.

The backend goal API is:

```text
GET  /api/providers/sessions/:sessionId/goal
POST /api/providers/sessions/:sessionId/goal
```

POST accepts `action` (`set`, `pause`, `resume`, `clear`) and an `objective` for
`set`. App session ids are resolved to their provider-native thread ids on the
server. Goal controls execute immediately while a turn is running. A normal
chat stop pauses an active Goal before interrupting its current turn.

## Working input and questions

While Codex is working, Enter or the send button appends input to the current
native turn with `turn/steer`. Tab with text in the composer, or the Queue
button, persists a separate follow-up for the next turn. An input accepted by
Codex is echoed locally; a failed request retains the typed text. A native
turn that finishes during submission falls back to the durable queue.

The steering API is `POST /api/providers/sessions/:sessionId/steer`, with
`content` and optional uploaded `attachments`. The server resolves the native
thread, checks its current turn id, and validates the same upload boundary as
an ordinary send. Model and permission settings apply at turn startup.

Native `item/tool/requestUserInput` requests appear as inline choice/text
cards. Answers retain the native request and question ids. Nonblocking cards
keep the composer and activity indicator available, preserve independently
typed drafts, and replay through the existing subscription snapshot. Async
`agentMessage.questions` cards carry their original call id and question
index when answered, and survive a completed response until they are answered.
Native resolution events retract cards on every subscribed device. The
question card handles its own Escape key. History renders the question and
selected answer as conversation text.

The deployed backend now includes the queued-message routes, user service,
and draft repository used by the source client. Queued follow-ups are checked
every second, independently from scheduled runs in other sessions, and retain
the existing atomic SQLite claim behavior. Each queued run inherits the current
phone/desktop viewers and continues their replay sequence, so its working
status, streamed response and completion arrive on the already-open clients.

## Other included changes

- Settings → Appearance offers Claude and GitHub interface styles independently
  from light/dark/system color mode. The account's existing UI preferences store
  persists the choice. GitHub uses [Primer](https://primer.style/product/getting-started/foundations/color-usage/)-inspired neutral surfaces, system text,
  fine borders, compact panels and underlined navigation. Phone composers retain
  their compact sizing, and session markers retain their terracotta meaning.
- Upstream release checks, update banners and the web self-upgrade modal are
  removed. The About tab displays the installed build version; deployments of
  this fork are maintained through its Git repository and host build scripts.
- Sidebar reminders are limited to explicit errors and unanswered interactive
  requests; metadata/history updates leave idle rows clear. Prompt resolution
  and reconnect snapshots clear resolved requests. Confirmed running/background
  work uses solid terracotta markers, actionable reminders use an outlined
  marker, and recent activity is shown by timestamps. A successful terminal
  event with assistant output adds a small unread completion check that survives
  refresh. Opening the session or receiving its final reply in the visible
  session acknowledges the reply; read receipts suppress replayed terminal
  events. New turns and confirmed running responses clear the previous check.
- BTW windows restore their original source, transcript, unsent draft and resized
  geometry after a page reload. Native Codex/OpenCode forks stay attached to a
  user-scoped server registry and replay output on reconnect. A disconnected
  window is retained for 30 minutes; Finish clears its temporary native context
  and the tab's saved window immediately.
- Native CLI and web chat share the same Codex App Server and thread history.
- Live message snapshots retain stable ids, so incremental output updates one row.
- Markdown renders HTML line-break tags inside table cells and prose, including
  streamed replies. Code samples and escaped tags retain their literal text.
- Mobile foreground return and send recover the websocket; unsent drafts remain available.
- Native Codex model defaults, including GPT-6.1 Sol, are reflected in browser defaults.
- OpenCode Go is available through the existing provider/model picker.
- The standalone [Go account router](plugins/opencode-go-account-router/README.md)
  persists account affinity, rolling/weekly/monthly usage, and quota cooldowns
  across CLI processes. Its source, lockfile, tests and MIT license are included.
- The current interface styling, locally served JetBrains Mono and Source Han
  Serif assets, and their font licenses are included.
- Application text uses a scale one pixel below Tailwind's defaults, with chat
  prose at 15px. Text weights and relative math sizing use the same styling;
  mobile form fields retain 16px for steady iOS keyboard focus. The Appearance
  font-size setting controls the code editor independently.
- Phone composers start with one text line, tighter padding and smaller activity
  tabs. Multiline input grows to 160px or 30% of the viewport, then scrolls;
  context, quota, model and send controls remain available in the compact footer.

## Host deployment

The scripts under [scripts/local-deployment](scripts/local-deployment) describe
the user-service deployment used on this Linux host. The runtime npm package is
installed under `~/.local/share/cloudcli-runtime`; source is checked out
separately. The service reads host settings from
`~/.config/cloudcli/server.env` and uses the existing private authentication
stores.

Choose the network mode when starting the host's service:

```bash
install -m 755 scripts/local-deployment/cloudcli-start.py "$HOME/.local/bin/cloudcli-start"
cloudcli-start                    # Interactive localhost / Tailnet selection
cloudcli-start localhost          # Bind to 127.0.0.1:3001
cloudcli-start tailnet            # Bind to the address from tailscale ip -4
cloudcli-start --status           # Show the saved mode and URL
```

`--mode localhost` and `--mode tailnet` are also accepted. The selected mode
is saved in `~/.config/cloudcli/server.env` and reused by the enabled user
service at boot. The launcher restarts the service, waits for its health check,
and restores the previous configuration if startup fails. Localhost refers to
the machine running CloudCLI; Tailnet mode is used by other Tailnet devices.

Build the client and backend patches from the source checkout:

```bash
npm ci
npm run build:client -- --outDir "$HOME/.config/cloudcli/client-patch" --emptyOutDir
node scripts/local-deployment/build-backend-patch.mjs
cp scripts/local-deployment/apply-defaults.py "$HOME/.config/cloudcli/apply-defaults.py"
python3 "$HOME/.config/cloudcli/apply-defaults.py"
systemctl --user restart codex-web.service
```

The bootstrap publishes hashed client assets and overlays compiled backend
patches while retaining original packaged modules. The user unit starts the
shared daemon idempotently and reapplies these patches at startup. The Go
launcher uses an isolated OpenCode config directory with the account-router
plugin; private keys stay in the host's credential stores.

## Validation

- Frontend suite: 851 tests passed across 117 files.
- Related provider/websocket/user/queue backend suite: 164 passed, one skipped.
- Go account-router suite: 24 tests passed.
- Frontend and backend TypeScript checking passed with Node.js 22 type definitions.
- Client production build and backend compilation passed.
- Actual browser validation: mobile Goal creation, pause and reload; desktop
  resume; two native automatic turns streamed to chat; persisted file outputs;
  completed-goal reload and clear.
- Actual working-input validation: mobile native question and refresh, desktop
  answer, a second mobile instruction accepted into the same running turn,
  queued HTTP 200 and a separate completed next turn. Phone and desktop both
  receive that queued turn live and return to idle; history shows readable
  question answers.

Host validation records are kept under `~/.local/share/cloudcli-data/`.
