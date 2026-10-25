# Pi Scope Server

Node HTTP server (Node 24+, built-in `node:sqlite` + `node:http`) that ingests
agent events, stores them in SQLite, and serves a live scope UI.

## Quick start

Requires Node 24+ (no install step — `node:sqlite` is built in).

```bash
# Start it — a random auth token is generated and printed in the boot banner
node server.ts

# Or pin the token yourself
SCOPE_AUTH_TOKEN=my-secret-token node server.ts
```

The server's own runtime packages — `node-pty` (the Terminal's PTY) and `ws` (its
WebSockets) — are not installed here. They come from the bundled pi project in
the user's data dir (`~/.pi-scope/pi`), which the launcher seeds on
first run, so the server and the desktop app share one copy
(`pi-deps.ts` holds the resolution rules). A checkout whose bundle is missing can
seed it with `node apps/scope-desktop/pi-bundle-install.mjs`.

Extension packages live in the agent dir's own npm project (`<agentDir>/pi`,
i.e. `~/.pi-scope/agent/pi`): the extensions pi has available are inspected on
every install/launch and their declared dependencies are installed there
(`apps/scope-desktop/pi-extensions-install.mjs`). Extensions that resolve their
own packages at run time are pointed at it with `PI_BROWSER_MODULE_ROOT`, which
the `pi` shim and the chat child environment set, so they find their packages
wherever the agent was started from.

## Environment variables

| Var | Default | Description |
|-----|---------|-------------|
| `SCOPE_PORT` | `43190` | HTTP port |
| `SCOPE_HOST` | `0.0.0.0` | Bind address. All interfaces by default, so the phone QR is reachable; `127.0.0.1` keeps it local-only |
| `SCOPE_TLS_PORT` | `SCOPE_PORT` + 1 | Port of the phone-facing HTTPS listener. The desktop UI, the launcher's health probes and the tests keep using the plain-HTTP port |
| `SCOPE_TLS` | *(enabled)* | `0` turns the phone-facing HTTPS listener off; phones then get a plain `http://` link |
| `SCOPE_TLS_CERT` / `SCOPE_TLS_KEY` | *(generated)* | Serve this certificate/key pair instead of the self-signed one (set both) — e.g. a `mkcert` or internal-CA pair the phone already trusts |
| `SCOPE_TLS_DIR` | `~/.pi-scope/tls` | Where the generated pair is cached (`cert.pem`, `key.pem` mode 0600). Re-minted when the machine's LAN addresses change, because the certificate names them |
| `SCOPE_DB_PATH` | `db/scope.db` | SQLite database path |
| `SCOPE_AUTH_TOKEN` | *(random UUID)* | Bearer token for auth. When unset a random one is generated per run and written to `tmp/scope_token` (mode 0600) so the launcher and the pi extension can find it |
| `SCOPE_FILE_ROOT` | project root | Comma-separated allowed roots for `/files/*` and `/checkpoints/*` |
| `SCOPE_AGENT_DIR` | `~/.pi-scope/agent` | Pi Scope's **own** pi agent dir. The bundled `pi` is pinned here via `PI_CODING_AGENT_DIR`, so it never reads or writes the global pi agent dir. |
| `SCOPE_SETTINGS_JSON` | `<agentDir>/settings.json` | Override the pi settings file the agent-team sidebar reads/writes |
| `SCOPE_PROVIDER_CACHE_FILE` | `<agentDir>/../Provider_Cache/model_provider.json` | Override where the kilo / tokenharbor extension model cache is read from. The default is derived from the agent dir's parent, which is where the extension's `model-cache.ts` writes it (`~/.pi-scope/Provider_Cache` for Pi Scope, `~/.pi/Provider_Cache` for a global pi) |
| `SCOPE_SKILLS_DIR` | `<agentDir>/skills` | Override the skills directory scanned for the agent-team sidebar |
| `SCOPE_EXTRA_PATH` | — | Colon-separated extra dirs prepended to `PATH` for chat-spawned `pi` subprocesses (e.g. `SCOPE_EXTRA_PATH=/path/to/.venv/bin`) |
| `SCOPE_HARNESS_BIN_<ID>` | — | Absolute path to a coding-agent CLI the Chat composer offers when it is installed where a desktop launch does not search (e.g. `SCOPE_HARNESS_BIN_CLAUDE=/opt/claude/bin/claude`, `SCOPE_HARNESS_BIN_OPENCODE=~/.opencode/bin/opencode`). Ids are `claude`, `codex`, `gemini`, `opencode`, `cline`, `kilo`, `aider`, `cursor`, plus any custom harness id |
| `SCOPE_WORKFLOW_STORE` | `<plugins dir>/.data/subagent-workflow.json` | Where Chat reads the Workflow plugin's harness settings (binary overrides and custom harnesses). The default follows `SCOPE_PLUGINS_DIR` |
| `SCOPE_PYTHON_VENV` | `<agentDir>/../.venv` | The shared Python venv (built with `uv` by `apps/scope-desktop/pi-python-install.mjs`) for every Python-dependent element. The default is derived from the agent dir's parent (`~/.pi-scope/.venv` for Pi Scope, `~/.pi/.venv` for a global pi). Its `bin` is prepended to the chat/agent `PATH`. Override to relocate it |
| `PLAYWRIGHT_BROWSERS_PATH` | `<agentDir>/../playwright-browsers` | Where Playwright's Chromium build lives (installed by `pi-python-install.mjs`). Derived from the agent dir's parent (`~/.pi-scope/playwright-browsers` for Pi Scope, `~/.pi/playwright-browsers` for a global pi) so the Node `browser` extension and the Python elements share one build. An inherited value wins |
| `SCOPE_KEYS_JSON` | `<agentDir>/api-keys.json` | API keys entered in Settings → API Keys (owner-only file, mode 0600) |
| `SCOPE_PI_REGISTRY` | `https://registry.npmjs.org` | npm registry the Settings → Update tab asks for the latest bundled `pi` version (point at a mirror for air-gapped installs) |
| `SCOPE_NPM_BIN` | `npm` | `npm` executable the Update tab runs to install a newer bundled `pi` |

Chat-spawned `pi` subprocesses are launched through the user's **interactive
shell** (`bash -ic` / `zsh -ic`, preferring `$SHELL`), so the environment they see
is the one a terminal would give them: `~/.bashrc` (bash) or `~/.zshrc` (zsh) is
sourced. This matters because the desktop launcher starts the server from a
session that never reads those files. The login flag is deliberately omitted:
login-only profile files are skipped, so a slow or banner-printing login shell
can't delay or corrupt the chat protocol. The shell's own stdout is discarded and
pi's NDJSON stream is routed to a dedicated fd, so rc banners or prompt themes
can't corrupt the RPC stream either.

On top of that they get the workspace's Python venv bin dirs (and Pi Scope's
shared venv, `~/.pi-scope/.venv`) prepended to `PATH`, and
`PLAYWRIGHT_BROWSERS_PATH` set to Pi Scope's own browsers dir
(`~/.pi-scope/playwright-browsers`, or the user's shell rc / Playwright's default
cache when that is what actually holds a build) — so tools like `web-fetch` find
the venv's `playwright` and its Chromium browser exactly as they do in the
terminal, even when the server was launched from a GUI session that never sourced
the shell rc. The `PATH` prefix is re-applied inside the shell too, so an rc file
that reassigns `PATH` instead of prepending to it doesn't drop those dirs.

API keys entered in **Settings → API Keys** are stored in Pi Scope's own agent
dir (`~/.pi-scope/agent/api-keys.json`, mode 0600) and injected into
that of
every chat-spawned `pi` subprocess, so an extension that reads `process.env`
(e.g. the speech-to-text extension's `GROQ_API_KEY`) works without the key
living in a shell profile. A stored key overrides the inherited environment; the
Settings page shows each key's effective source. Secrets never leave the server
— the UI only receives a masked preview.

## Phones connect over HTTPS

When the server is LAN-reachable it starts a second listener on `SCOPE_TLS_PORT`,
whose certificate is minted on first use and cached in `SCOPE_TLS_DIR`. `GET /lan`
hands the phone `https://…` URLs, so the pairing code you type on the phone —
and the credentials it is traded for — travel encrypted instead of readable by
anything else on the Wi-Fi. The QR itself carries no credential: it is the
address only, and the phone's pairing screen asks for the code the panel shows.
That code behaves like an OTP — six digits, two minutes of life, and single use:
`POST /pair` spends it, so one code pairs exactly one phone and the panel
immediately shows the next.

What the code buys is not the server's own `SCOPE_AUTH_TOKEN`. It is a pair of
mobile credentials (`auth-jwt.ts`): an HS256 JWT access token that expires in 30
minutes, and an opaque refresh token that stays valid for 30 days, hashed at
rest and rotated on every use. `POST /pair/refresh` renews the pair without
another code, `POST /pair/revoke` revokes it, and both die with the process — a
restarted server asks for a new code, exactly as a per-run token did. The access
token is accepted everywhere the master token is, so the mobile page's SSE stream
and workspace media work with `?token=`; it cannot stop the server, which still
insists on the master token.

### Installing the phone layout as an app

The mobile entry is a PWA. `public/manifest.webmanifest` declares `start_url` and
`scope` as `/m`, a standalone display, and the icons in `public/icons/` (any and
maskable, plus the `apple-touch-icon` iOS actually reads), so Chrome and Safari
offer "Add to Home Screen" once the page is open over the HTTPS listener.

`public/sw.js` is a deliberate pass-through. Installability requires a service
worker with a fetch handler, and this one never caches an app response or API
call — the view is live data from this machine behind a per-run token, so a cache
would only serve a stale UI or a dead credential. The single thing it stores is
`public/mobile-offline.html`, shown in place of a navigation that cannot reach
the server, because a standalone install has no address bar to explain itself.
It is registered with scope `/m`, so the desktop app at `/` is never under it.

No public authority issues a certificate for `192.168.x.x`, and the address
changes with the network, so this machine mints its own trust: a long-lived local
CA in `~/.pi-scope/tls/ca-cert.pem` (about eight years) signs a 397-day server
certificate for the LAN addresses in use. Chrome still shows "your connection is
not private" until the CA is known, and `Advanced → Proceed` accepts it for that
browser session — enough to use the phone layout, but **not enough to install it**:
Chrome refuses to register a service worker on an origin with a certificate
error, and the install needs a worker.

Installing that CA one time fixes both. `GET /scope-ca.crt` serves it on the
plain-HTTP port too (the certificate is public, and the phone has to fetch it
before it can trust this server):

- **Android**: open `http://<lan-ip>:<port>/scope-ca.crt`, then Settings → Security
  → Encryption & credentials → Install a certificate → **CA certificate** → the
  downloaded file.
- **iOS**: open the link in Safari and allow the profile, install it under
  Settings → General → VPN & Device Management, then enable it in Settings →
  General → About → **Certificate Trust Settings** (`Pi Scope Local CA`).

After that the warning is gone, the origin is clean, and "Add to Home screen"
offers the install. A network change re-mints the *server* certificate only; the
CA — the part the phone trusts — is kept. To skip all of this, point
`SCOPE_TLS_CERT`/`SCOPE_TLS_KEY` at a pair the phone already trusts and make sure
its SANs include the LAN address the QR uses.

The plain-HTTP port still listens: the desktop window, `stop.sh`, the launcher's
health probes and the extension's `--obs-server-url` keep using
`http://127.0.0.1:<SCOPE_PORT>`, so nothing on loopback pays for TLS it does not
need. Encryption covers the network hop only — it is not proof of who is on the
other end, and it does not make the LAN bind safe to expose on a network you do
not trust.

## Chat harnesses

The Chat composer can drive more than the bundled `pi` agent. Its harness picker
lists **Pi** (the default, with the app's full model catalogue) and the external
CLIs **Claude Code**, **Codex CLI**, **Gemini CLI**, **opencode**, **Cline**,
**Kilo Code**, **Aider** and **Cursor Agent**. The picker marks a CLI that is not
installed and remembers the choice per browser; a prompt from an external harness
runs that CLI non-interactively and streams its output as the chat reply. The
transcript labels every reply with the harness that produced it — changing the
picker later does not relabel earlier answers, and the attribution is included in
the conversation snapshot a reload restores.

Every external-harness turn is also recorded as a normal session in SQLite
(`harness-record.ts`): Chat reports the user prompt when the run starts and the
reply, thinking, tools and outcome when it settles, and the server stores them as
`user_message` / `assistant_message` / `turn_*` events with `payload.harness`.
That is what makes these conversations appear in the Chat **Workspaces** rail
next to Pi sessions, open as a replayable transcript, and keep their harness
attribution after a restart. A run stopped midway records the partial reply, and
a run that could not start records the error instead of leaving a dangling turn.

A harness's model list comes from its own CLI: a listing command where it has
one — `opencode models`, `kilo models`, `cursor-agent --list-models` — or the
metadata protocol it already speaks (`claude` initialize, Codex app-server
`model/list`, ACP `session/new` for Gemini/Cline). The pill therefore shows the
providers/models that CLI is actually set up for, not a baked-in list. Aider,
which publishes neither, shows its documented aliases. Until the first answer
arrives every model picker — the Chat pill, the Office task dialog's model
field, a Workflow node's Model dropdown — says it is loading instead of passing
those documented aliases off as the CLI's list; an empty or refused answer ends
the wait and falls back to them. All of them are the same picker (`select[data-model-select]`
in `helpers.js`): typing filters the list, the models are grouped and sorted by
provider under a heading carrying that provider's icon. The list is cached for
five minutes and is re-asked after a failure, so signing in or editing the CLI's
configuration shows up without a restart. **Settings → Models → Refresh all
models** bypasses that cache and re-asks every installed harness at once, so
Chat and Workflow pick up changed lists immediately.

Gemini CLI is launched with `--skip-trust` and Codex CLI with
`--skip-git-repo-check`: the workspace picked in this app is the trust boundary,
and neither CLI has a TTY to answer its own trust prompt (Gemini's ACP discovery
uses `--skip-trust` for the same reason).

Typing `/` in the composer opens that harness's own slash commands, filtered as
you type; Enter/Tab inserts the command, arrows move and Esc closes. The list is
**discovered from the harness itself** — nothing is copied into this repo — and
it is scoped to the chat's workspace, because project skills and custom commands
are directory scoped:

| Harness | Asked over |
| --- | --- |
| Pi | `pi --mode rpc` → `get_commands` (extension commands, prompt templates, skills) |
| Claude Code | `claude -p` stream-json → control_request `initialize` (names, descriptions, argument hints) |
| Codex CLI | `codex app-server` → `skills/list` (installed skills) |
| Gemini CLI | ACP (`gemini --acp`) → `available_commands_update` |
| opencode | ACP (`opencode acp`) → `available_commands_update` |
| Kilo Code | ACP (`kilo acp`) → `available_commands_update` |
| Cline | ACP (`cline --acp`) → `available_commands_update` |

For an ACP harness the composer prefers the command list the **live** session
published over the wire, including a mid-conversation
`available_commands_update` (project commands and skills can appear after the
session starts), and shows the argument hint ACP carries in `input.hint`. A
command sent from the menu is passed to `session/prompt` **verbatim** — no
reference-library or transcript preamble is prepended, because the agent only
expands a native command when it opens the prompt. Names ACP marks as skills
(`$skill`) stay out of the `/` menu, since they are not slash commands. When no
session is open yet — and always for Cline, whose turns run headless — the same
list is discovered over a short-lived ACP session (as the table describes) and
cached for five minutes.

The ACP harnesses (Gemini CLI, opencode, Kilo Code) are driven as **live
sessions**, not one-shot print runs: `acp-client.ts` starts the CLI's ACP server,
creates a session in the chat's workspace, streams `agent_message_chunk` /
`tool_call` updates, and keeps the session for the next message — so the agent
remembers the conversation and the harness's own slash commands are dispatched by
`session/prompt`. A `session/request_permission` is rendered as the chat's normal
answerable card (Allow once / Reject, whatever options the agent offered); the
answer goes back over JSON-RPC, and an unanswered card is cancelled on Stop or
when the session is closed. Calls the agent makes to the *client* (fs, terminal)
are refused: the harness runs its own tools. Claude Code and Codex CLI have no
ACP server and keep their native protocols.

Cline is the exception: its ACP server (CLI 3.0.x) answers a prompt with an empty
`end_turn` — no text and no tool calls — and a `session/load`ed conversation
replays its old turns but never answers the next one. Its turns therefore run
**headless** (`cline`, no subcommand), with the prompt written to a temp file
whose descriptor becomes the child's stdin: Node's `stdio: "pipe"` is a
socketpair, and Cline only recognises a redirected prompt when stdin is a real
file (over a socket it refuses with "interactive mode requires a TTY"). `--acp`
is still how its model list and command menu are discovered. A turn is one
process, so a follow-up carries the transcript preamble, exactly as the other
print-mode harnesses do. `ChatHarness.promptViaFile` marks the harnesses that
need this route; `acpRun: false` keeps ACP for metadata only.

Cline writes its reasoning to stdout painted with the SGR *dim* attribute and
labelled `[thinking] `. `harness-output.ts` reads that styling as the turn
streams: dim text goes to the chat's thinking lane (and to a `thinking: …` row in
a Workflow run log), everything else is the answer — so a node's `{input}` and
the assistant bubble carry only what Cline answered. `ChatHarness.dimThinking`
marks the harnesses whose stdout is split this way.

The session id is kept in the agent dir (`chat-acp-sessions.json`, keyed by the
chat session), so a **server restart** continues the same agent session. The
handshake asks for ACP 2 and reads the agent's capabilities (the same negotiation
t3code uses): a v2 agent that advertises `loadSession` is resumed with
`session/load`, one that advertises `sessionCapabilities.resume` uses
`session/resume`, and a v1-only agent keeps the original `session/load` path. A
CLI that refuses the id falls back to a fresh `session/new`. A
model or mode picked in the composer is pushed into the live session
(`session/set_model` / `session/set_mode`, or `session/set_config_option` for a
model an agent publishes only as a config option, as opencode does) instead of
waiting for a new one, and before the first prompt. If the agent still refuses
the requested model — an unauthenticated provider, an id it no longer serves —
the turn fails with the agent's own reason instead of prompting on its default
model. The mechanisms are declared per harness in `acp-harness.ts`: Gemini and
Kilo use `session/set_model` only, Cline tries it then falls back to its `model`
config option (never `provider`) after rejecting an id its session does not
advertise, and opencode uses its `model` config option only, waiting for a late
option and retrying a transient rejection. A profile
lists only what its own CLI implements, so a workaround for one harness cannot
alter another; print-mode harnesses keep their per-harness `modelFlag`. The modes
the agent advertises get their own composer pill (Gemini's Plan/YOLO, opencode's
build/plan). A workflow node also runs an ACP harness as a live session
(`createAcpSession` through the plugin kit) — Cline excepted, whose nodes take
the headless mode described above; because a run is unattended, it
answers the agent's permission request with the offered allow option and writes
the decision to the run log.

Discovery runs on demand (`GET /chat/harness-commands?harness=&cwd=`), never
submits a prompt, asks for metadata only, and kills the child as soon as it
answers. Answers are cached for five minutes per harness+binary+directory and
concurrent opens share one process; a failure is retried rather than cached, and
the menu shows what went wrong plus a refresh control. Aider and Cursor Agent
publish no command interface to a pipe, so they show no menu rather than a
made-up list — and a harness that advertises none says so in the menu. An
external harness also hides the Pi-only Agent Team rail, since the
teams/models/tools there are read by `pi` and no other CLI.

Custom harnesses and per-harness binary paths defined in **Settings → Plugins →
Workflow** are shared into Chat: a CLI only has to be described once. The
`SCOPE_HARNESS_BIN_<ID>` environment variable still wins over a Workflow path.

## Herdr cwd integration

The Terminal endpoint supports a **Herdr** multiplexer shell. When selected, the shared
working directory (used by `/files/*` and `/checkpoints/*`) mirrors the focused Herdr
pane's live cwd — queried over Herdr's Unix socket — instead of the frozen PTY directory.

The server resolves the socket from (in order) `$HERDR_SOCKET_PATH`, `$HERDR_SOCK`,
`$XDG_CONFIG_HOME/herdr/herdr.sock`, `~/.config/herdr/herdr.sock`,
`$XDG_RUNTIME_DIR/herdr/herdr.sock`, `$XDG_RUNTIME_DIR/herdr.sock`, and
`~/.local/share/herdr/herdr.sock`, with a 3-second discovery cache so a Herdr that
starts after the server is also detected. If no socket is reachable it falls back to the
PTY's `/proc/<pid>/cwd`.

## Smoke test

```bash
# Terminal 1: start server
SCOPE_AUTH_TOKEN=dev_token node server.ts

# Terminal 2: check health (expect HTTP 200)
curl -i http://127.0.0.1:43190/health
```

## End-to-end tests

The Chat view has a headless-browser suite that runs the **real** `public/` assets
against a mock backend (`test/mock-backend.mjs`) — no SQLite, no `pi` subprocess,
no network. `test/chat.e2e.test.mjs` drives workspace selection / restore / add /
remove / subagent nesting and the streaming + click flows; `test/harness.mjs` holds
the shared Playwright helpers.

```bash
# from apps/scope-server (Playwright + Chromium come from the repo's root install)
npm test
# or pick a subset:
node --test --test-name-pattern="workspace" test/chat.e2e.test.mjs
```

## API

All endpoints except `/health` and `/` require `Authorization: Bearer <token>`.
The SSE endpoint also accepts `?token=<token>` (browsers can't set headers on EventSource).

The routes marked *loopback-trusted* below (`POST /events`, `/capture/*`,
`POST /shutdown`, `GET /sessions/:id/seq`) skip the token on a loopback bind,
because the only reachable caller is then a local process. A browser POST is not
local traffic though — any page the user visits can have the browser deliver a
simple cross-origin POST it can't read but that still takes effect — so those
routes also require the caller to send either no `Origin` header (curl, the pi
extension, the launcher) or this server's own. A cross-site request gets `401`;
send the token to use them from another origin. Once `SCOPE_HOST` is a wildcard
address the token is required anyway (see the LAN notes in the root README).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check + version + platform + uptime + totals (no auth) |
| GET | `/lan` | Phone pairing: bind state, ranked LAN IPv4 addresses (interface, virtual-flag, default-route), the short-lived `pair_code`, the credential-free `/m` URLs and the HTTPS state (`tls`, `tls_port`, `tls_error`). Never contains the auth token |
| GET | `/scope-ca.crt` | The local CA that signs the phone-facing certificate, for the phone to trust once (no auth: a certificate is public, and the phone needs it before it can talk to this server cleanly). 404 when TLS is off or a certificate is supplied |
| GET | `/manifest.webmanifest` | PWA manifest for the phone layout (no auth: the browser fetches it itself) |
| GET | `/sw.js` | Service worker behind installability — pass-through plus one cached offline card (no auth, `no-cache`) |
| GET | `/mobile-offline.html` | The offline card `sw.js` serves when a launch cannot reach the server (no auth) |
| POST | `/pair` | Exchange a `pair_code` for a mobile credential pair (JWT access token + rotating refresh token) — six digits, single use, two-minute life (unauthenticated, same-origin, rate-limited). Never returns the master token |
| POST | `/pair/refresh` | Rotate a refresh token into a new access/refresh pair; the presented token is spent (unauthenticated, same-origin) |
| POST | `/pair/revoke` | Forget a phone's refresh token (unauthenticated, same-origin, idempotent) |
| POST | `/shutdown` | Graceful server shutdown (loopback-trusted) |
| GET | `/` | Scope UI (no auth) |
| POST | `/events` | Ingest single event or array (loopback-trusted) |
| GET | `/models` | List distinct models seen |
| GET | `/sessions` | List sessions (pool/tag/since/limit) |
| DELETE | `/sessions` | Delete ALL sessions + events (destructive) |
| DELETE | `/sessions/:id` | Delete one session + events |
| GET | `/sessions/:id/events` | Replay events (limit/before_seq/since_seq/type) |
| GET | `/sessions/:id/stats` | Per-session stats (tokens/cost/models) |
| GET | `/sessions/stats?ids=` | Batch stats for multiple sessions |
| GET | `/events/stream` | SSE stream (pool/tag/session_id/?token=) |
| GET | `/files/modified` | Git status (porcelain) for a cwd |
| GET | `/files/diff` | HEAD vs working-tree diff for one file |
| GET | `/files/graph` | File/module dependency graph + change overlay for a cwd |
| POST | `/files/save` | Write a working-tree file |
| POST | `/checkpoints/create` | Git-backed working-tree snapshot |
| GET | `/checkpoints/list` | List checkpoints for a cwd |
| POST | `/checkpoints/restore` | Hard reset to a checkpoint |
| GET | `/checkpoints/branches` | List branches for checkpoint merge |
| POST | `/checkpoints/merge` | Merge a checkpoint into a branch |
| POST | `/checkpoints/delete` | Delete a checkpoint ref (+ optional branch) |
| GET | `/git/status` | Full git status (branch, upstream, ahead/behind, files) |
| POST | `/git/stage` | Stage files (paths or all) |
| POST | `/git/unstage` | Unstage files |
| POST | `/git/discard` | Revert changes / delete untracked |
| GET | `/git/diff` | Unified diff (cached or worktree) |
| GET | `/git/log` | Commit history with parents |
| GET | `/git/show` | One commit detail + diff |
| GET | `/git/compare` | Diff between two SHAs |
| GET | `/git/cat` | File content at a commit |
| POST | `/git/action` | Graph context menu (checkout/cherry-pick/revert/rebase/reset/branch/tag) |
| POST | `/git/commit` | Create commit (with amend support) |
| POST | `/git/branch` | Create/switch/delete branch (checkout-remote checks out a tracking branch) |
| GET | `/git/branches` | List local and remote-tracking branches |
| GET | `/git/remotes` | List remotes |
| POST | `/git/remote` | Add/remove a remote |
| POST | `/git/push` | Push (auto set-upstream) |
| POST | `/git/pull` | Pull |
| POST | `/git/fetch` | Fetch |
| GET | `/git/stash` | List stashes |
| POST | `/git/stash` | Push/pop/drop a stash |
| GET | `/git/submodules` | List submodules |
| POST | `/git/submodule` | Add/remove/update/init/deinit/sync a submodule |
| GET | `/pi-update` | Compare the bundled Pi coding agent against the npm latest, plus `modelCatalog` (pi's model store + release cache; `cacheModels`/`cacheProviders` describe models.dev's whole release catalogue, not the providers the cost table lists) and `update` (live install state for the agent and its optional `extensions` step, so a reloaded page restores both) |
| POST | `/pi-update` | `{ action: "check"|"update"|"refresh-models" }` — check, install the newest bundled agent, or fetch the model catalogs. `update` accepts `extensions: true` to also run `pi update --extensions` for the packages in `settings.json`; the step's own outcome comes back as `extensions` without failing a successful agent install. `refresh-models` (Settings → Models → Refresh all models) also re-reads the runtime's provider catalogue and re-asks every installed harness for its model list (`harnessModels` in the response) |
| GET | `/harness-update` | Installed external coding harnesses (Claude Code, Codex, Gemini, opencode, …) with the version each reports, its registry's latest release and the install state (`update`) |
| POST | `/harness-update` | `{ action: "check"|"update"|"update-all", id? }` — re-check every harness, update one through its own updater, or update every harness with a pending release |
| GET | `/auth/providers` | Provider catalogue (methods + status) and stored credentials, read live from the bundled agent |
| POST | `/auth/login` | `{ providerId, type }` to start, `{ id, promptId, value }` to answer a prompt, `{ id, cancel: true }` to abort |
| GET | `/auth/login?id=` | Current login session state (pending prompt + event log) |
| POST | `/auth/logout` | `{ providerId }` — remove a stored credential (pi's `/logout`) |
