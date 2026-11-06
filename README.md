<div align="center">
  <img src="public/orbit-icon.svg" alt="Orbit" width="72" height="72">
  <h1>Orbit</h1>
  <p>A desktop and mobile workspace for coding agents.</p>
  <p><strong>An independently maintained fork of <a href="https://github.com/siteboon/claudecodeui">CloudCLI (Claude Code UI)</a>.</strong></p>
</div>

<p align="center">
  <a href="https://github.com/BorongGu/Orbit">Repository</a> ·
  <a href="https://github.com/BorongGu/Orbit/issues">Issues</a> ·
  <a href="docs/README.zh-CN.md">简体中文</a> ·
  <a href="docs/architecture/README.md">Architecture</a> ·
  <a href="LICENSE">AGPL-3.0-or-later</a>
</p>

Orbit builds on CloudCLI's agent integrations, chat interface, terminal, file explorer and Git tools. This fork develops its own appearance, reading experience, session workflows and multi-agent collaboration. The original project and its contributors are credited below.

## Supported agents

- Claude Code
- OpenAI Codex
- OpenCode, including OpenCode Go account routing
- Cursor CLI

Install and authenticate the CLI providers you intend to use on the machine running Orbit. Available models are loaded from each provider's model catalog.

## Highlights

- **Sessions across desktop and mobile:** project and conversation views, pinned sessions, running-session indicators, history search and saved reading positions.
- **Reading and writing:** streamed Markdown, tables, inline and display LaTeX, formula-aware copying, image attachments and fullscreen reading.
- **Five appearance styles:** Claude, GitHub, Linear, Paper and Raycast, with light/dark modes and adjustable chat font size.
- **Context and subscriptions:** context-window usage, compaction status and remaining subscription quotas.
- **Side conversations:** `/btw <question>` opens a Codex or OpenCode side conversation with inherited context. Each main session retains its own window, draft and side conversation across navigation and refresh.
- **Agent collaboration:** group discussions, peer input, shared task dispatch, and conversation context transfer and handoff.
- **Workspace tools:** integrated terminal, file editing, Git operations, plugins, browser tasks and optional TaskMaster integration.

## Run Orbit from source

Requirements: Node.js 22 or later, npm, Git, and the agent CLIs you want to use.

```bash
git clone https://github.com/BorongGu/Orbit.git
cd Orbit
npm ci
npm run build
```

Start in localhost mode:

```bash
HOST=127.0.0.1 SERVER_PORT=3001 npm run server
```

Open **http://localhost:3001** and complete the web account setup.

For access from your other devices through Tailscale, start the server on its Tailnet address:

```bash
orbit_tailnet_ip="$(tailscale ip -4)" &&
  test -n "$orbit_tailnet_ip" &&
  HOST="$orbit_tailnet_ip" SERVER_PORT=3001 npm run server
```

Open the printed server address from a device in the same Tailnet. The host machine and server process stay running while you use Orbit remotely.

The existing package and command identifiers, `@cloudcli-ai/cloudcli` and `cloudcli`, retain CloudCLI naming for compatibility. Build this repository to use Orbit's changes. Published CloudCLI packages and CloudCLI Cloud are maintained by the upstream project.

### Configuration

See [`.env.example`](.env.example) for configuration options:

| Variable | Purpose |
| --- | --- |
| `HOST` | Address the server listens on, such as `127.0.0.1` or the machine's Tailnet address |
| `SERVER_PORT` | HTTP and WebSocket port; default `3001` |
| `DATABASE_PATH` | Optional path for Orbit's local application database |
| `CLAUDE_CLI_PATH` | Optional path to the Claude Code executable |

Linux installations using the supplied [local deployment scripts](scripts/local-deployment/) can choose localhost or Tailnet when starting their configured systemd service:

```bash
python3 scripts/local-deployment/cloudcli-start.py
# Or choose explicitly:
python3 scripts/local-deployment/cloudcli-start.py localhost
python3 scripts/local-deployment/cloudcli-start.py tailnet
```

That helper uses an existing `codex-web.service` and `~/.config/cloudcli/server.env` configuration.

## Development

Ongoing development happens on **`main`**. Pull the latest commits before making changes:

```bash
git switch main
git pull --ff-only origin main
npm ci
HOST=127.0.0.1 npm run dev
```

The development frontend uses port `5173` and proxies API/WebSocket traffic to the backend on port `3001`.

Common checks:

```bash
npm run test:client
npm test
npm run typecheck
npm run lint
npm run build
```

To update a source installation, pull `main`, install the current dependencies, rebuild, then start the updated server using your chosen access mode.

## Documentation

- [Architecture overview](docs/architecture/README.md)
- [Message storage and lazy loading](docs/architecture/04-message-store-and-lazy-loading.md)
- [Scrolling and reading positions](docs/architecture/05-scrolling.md)
- [Agent groups](docs/architecture/07-groups.md)
- [Context transfer](docs/architecture/08-context-transfer.md)
- [Provider integration](server/modules/providers/README.md)
- [WebSocket protocol](server/modules/websocket/README.md)
- [OpenCode Go account router](plugins/opencode-go-account-router/README.md)
- [Contributing guide](CONTRIBUTING.md)

CloudCLI's [documentation](https://cloudcli.ai/docs) and [plugin starter](https://github.com/cloudcli-ai/cloudcli-plugin-starter) provide additional background on the upstream platform.

## Fork origin and acknowledgments

**Orbit is a fork of [CloudCLI / Claude Code UI](https://github.com/siteboon/claudecodeui), originally developed by Siteboon and the CloudCLI contributors.** Their work provides the foundation for this repository.

- Upstream: [`siteboon/claudecodeui`](https://github.com/siteboon/claudecodeui)
- This fork: [`BorongGu/Orbit`](https://github.com/BorongGu/Orbit)
- Upstream website: [cloudcli.ai](https://cloudcli.ai)

Orbit also builds on React, Vite, Tailwind CSS, CodeMirror, xterm.js, KaTeX and the supported agent SDKs. Font licenses and source acknowledgments are included under [`public/fonts/`](public/fonts/).

## License

[GNU Affero General Public License v3.0 or later](LICENSE) (**AGPL-3.0-or-later**), including the existing additional terms under Section 7. The original license and copyright notices are retained.
