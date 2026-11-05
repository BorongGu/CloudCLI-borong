# Isolated guest chat

This entrypoint gives a guest a small public chat UI using `gpt-6-astra` with
`high` reasoning. It reuses CloudCLI's buttons, inputs, streaming text pacing,
Markdown, table, KaTeX and expandable reasoning-summary rendering. It runs independently of the company
CloudCLI service and requires a dedicated login.

## Boundaries

- The guest server imports only the guest module. Its HTTP allowlist exposes
  authentication, guest conversations and owned image attachments.
- Conversation IDs are allocated and looked up in its own store. Native thread
  IDs, RPC methods, model overrides and filesystem paths are never client inputs.
- Codex has its own `CODEX_HOME`, configuration, history and workspace. Only the
  subscription credential is copied during initial setup.
- The container mounts only the dedicated guest directory and configuration.
  The web process and Codex run as UID 1000 with an empty capability bounding set.
- Shell, apps, agents, browser, hooks and other execution tools are disabled.
  A native Codex 0.164.0 request capture verified an empty model tool list.
- A namespace firewall allows loopback, response traffic and the model proxy.
  The proxy accepts CONNECT only for four exact OpenAI hostnames on port 443.
  Startup pins these hostnames to the operator machine's resolved addresses,
  accommodating private model gateways without allowing arbitrary internal hosts.
- Authenticated, Origin-checked WebSocket updates stream only the selected guest
  transcript, with polling for recovery. Model and thread connections are warmed
  before the first question. The login bundle is split from answer rendering,
  and static assets are precompressed.
- Login uses scrypt and Secure/HttpOnly/SameSite cookies. Tickets expire and are
  revoked by logout; restarting the guest web process requires logging in again.
  Mutating requests require a matching Origin, and login attempts are rate limited.
- Images are limited to three PNG/JPEG/WebP files per question, 5 MB each. Markdown
  renders company file links as plain text and omits model-authored image requests.

## Build and run

Prerequisites: Node 22, repository build dependencies, Docker Compose, the native
Codex binary, and `cloudflared`. Runtime data belongs outside the checkout.

```sh
export GUEST_ROOT="$HOME/.local/share/cloudcli-guest"
npm run build:guest
GUEST_CODEX_SOURCE=/path/to/native/codex node scripts/guest-chat/build.mjs
python3 scripts/guest-chat/prepare.py
# Place the official cloudflared binary at $GUEST_ROOT/build/cloudflared (executable).
docker build --network host -t cloudcli-guest:local "$GUEST_ROOT/build"
docker compose -f scripts/guest-chat/compose.yaml up -d
docker compose -f scripts/guest-chat/compose.yaml --profile public up -d --no-deps tunnel
docker logs cloudcli-guest-tunnel
```

The tunnel connects directly to the isolated guest network; no company port is
forwarded. Quick Tunnel generates a public HTTPS URL, retained for the life of
the tunnel process. A tunnel restart generates a new URL. Use a named Cloudflare
tunnel and a domain for a permanent address. Containers restart automatically
with Docker. Rebuilding the image and recreating guest containers affects guest
requests; keep that separate from normal company CloudCLI deployments.

The generated login is in `$GUEST_ROOT/config/login.json`, mode 0600. The server
loads only its hashed counterpart in `credentials.json`. Keep these files and
the subscription credential outside Git. Password changes require rotating
the salt/hash and restarting the guest web container. Re-run `prepare.py` to
refresh pinned model gateway addresses while preserving the existing login.

## Verification

`server/modules/guest-chat/tests/guest-chat.test.ts` covers authentication,
revocation, CSRF, foreign IDs, endpoint allowlisting, fixed model settings,
idempotency, streaming, restart/resume, image validation and egress policy.
Guest UI and restricted Markdown tests live in their owning frontend modules.
Before sharing an address, also test the deployed firewall, company-home
visibility, a real model reply, and desktop/mobile browser login.

## Mobile performance and recovery

- Authentication returns the history and selected transcript together. The page
  keeps eight recently viewed transcripts in memory, along with each draft and
  scroll position, and refreshes a cached conversation after displaying it.
- Selecting an image starts preparation and upload immediately. Larger images
  are exported as WebP at up to 2560 pixels on the long edge, using the smaller
  of the original and optimized files. The server retains the 5 MB limit.
- Binary uploads have progress, cancellation and retry, with two uploads at a
  time. Stable upload IDs and message request IDs make retries idempotent.
  Unsent uploads are capped at 100 files; records older than 24 hours are cleaned
  at startup and before another upload.
- Live clients negotiate revision-based text patches and compression. A missed
  revision reconnects to a snapshot; heartbeats, visibility/online events and
  bounded HTTP requests recover from interrupted mobile connections.
- Private attachment caching and compressed history responses reduce repeated
  transfers. Sending, delivery confirmation, image progress and model waiting
  have separate visible states. The public URL continues to use the same tunnel.
