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

## Other included changes

- Native CLI and web chat share the same Codex App Server and thread history.
- Live message snapshots retain stable ids, so incremental output updates one row.
- Mobile foreground return and send recover the websocket; unsent drafts remain available.
- Native Codex model defaults, including GPT-6.1 Sol, are reflected in browser defaults.
- OpenCode Go is available through the existing provider/model picker.
- The standalone [Go account router](plugins/opencode-go-account-router/README.md)
  persists account affinity, rolling/weekly/monthly usage, and quota cooldowns
  across CLI processes. Its source, lockfile, tests and MIT license are included.
- The current interface styling, locally served JetBrains Mono and Source Han
  Serif assets, and their font licenses are included.

## Host deployment

The scripts under [scripts/local-deployment](scripts/local-deployment) describe
the user-service deployment used on this Linux host. The runtime npm package is
installed under `~/.local/share/cloudcli-runtime`; source is checked out
separately. The service reads host settings from
`~/.config/cloudcli/server.env` and uses the existing private authentication
stores.

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

- Frontend suite: 842 tests passed across 116 files.
- Related provider/websocket backend suite: 102 passed, one skipped.
- Go account-router suite: 24 tests passed.
- Frontend and backend TypeScript checking passed with Node.js 22 type definitions.
- Client production build and backend compilation passed.
- Actual browser validation: mobile Goal creation, pause and reload; desktop
  resume; two native automatic turns streamed to chat; persisted file outputs;
  completed-goal reload and clear.

Host validation records are kept under `~/.local/share/cloudcli-data/`.
