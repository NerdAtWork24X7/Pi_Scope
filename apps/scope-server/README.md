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
| `SCOPE_HOST` | `127.0.0.1` | Bind address |
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
which publishes neither, shows its documented aliases. The list is cached for
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
session is open yet, the same list is discovered over a short-lived ACP session
(as the table describes) and cached for five minutes.

The ACP harnesses (Gemini CLI, opencode, Kilo Code, Cline) are driven as **live
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
(`createAcpSession` through the plugin kit); because a run is unattended, it
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
| GET | `/pi-update` | Compare the bundled Pi coding agent against the npm latest, plus `modelCatalog` (pi's model store + release cache; `cacheModels`/`cacheProviders` describe models.dev's whole release catalogue, not the providers the cost table lists) |
| POST | `/pi-update` | `{ action: "check"|"update"|"refresh-models" }` — check, install the newest bundled agent, or fetch the model catalogs. `refresh-models` (Settings → Models → Refresh all models) also re-reads the runtime's provider catalogue and re-asks every installed harness for its model list (`harnessModels` in the response) |
| GET | `/harness-update` | Installed external coding harnesses (Claude Code, Codex, Gemini, opencode, …) with the version each reports, its registry's latest release and the install state (`update`) |
| POST | `/harness-update` | `{ action: "check"|"update"|"update-all", id? }` — re-check every harness, update one through its own updater, or update every harness with a pending release |
| GET | `/auth/providers` | Provider catalogue (methods + status) and stored credentials, read live from the bundled agent |
| POST | `/auth/login` | `{ providerId, type }` to start, `{ id, promptId, value }` to answer a prompt, `{ id, cancel: true }` to abort |
| GET | `/auth/login?id=` | Current login session state (pending prompt + event log) |
| POST | `/auth/logout` | `{ providerId }` — remove a stored credential (pi's `/logout`) |
