# Installing Pi Scope

Two channels — curl on Linux/macOS, PowerShell on Windows — download the app (a
GitHub **tarball**, so `git` is not required), check for **Node.js 24+**, and
install its dependencies. Which package manager installs the dependencies is a
flag: `--pm` on the curl side, `-Pm` on the PowerShell side (npm, pnpm or Bun).

**Linux & macOS (curl):**

```bash
# curl channel — npm by default
curl -fsSL https://raw.githubusercontent.com/NerdAtWork24X7/Pi_Scope/main/install/install.sh | sh
# choose the dependency installer
curl -fsSL https://raw.githubusercontent.com/NerdAtWork24X7/Pi_Scope/main/install/install.sh | sh -s -- --pm pnpm
```

**Windows (PowerShell):**

```powershell
# PowerShell channel — npm by default (-UseBasicParsing is required, see below)
irm https://raw.githubusercontent.com/NerdAtWork24X7/Pi_Scope/main/install/install.ps1 -UseBasicParsing | iex
# choose the dependency installer (piped `iex` takes no parameters, so set PISC_PM)
$env:PISC_PM = 'pnpm'; irm https://raw.githubusercontent.com/NerdAtWork24X7/Pi_Scope/main/install/install.ps1 -UseBasicParsing | iex
```

`-UseBasicParsing` is not decoration. PowerShell 5.1 patched for CVE-2025-54100
pops an interactive "Script Execution Risk" prompt before it will fetch anything;
a piped run hangs there forever.

The file form is friendlier to Windows Defender and SmartScreen, and it is the
only form that can take arguments:

```powershell
irm https://raw.githubusercontent.com/NerdAtWork24X7/Pi_Scope/main/install/install.ps1 -UseBasicParsing -OutFile install.ps1
Unblock-File .\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Pm pnpm
```

Then start it — `pi-scope` is the launcher on all three platforms (`pi-scope.mjs`
plus a shim each), so the modes and flags are the same everywhere:

```bash
cd Pi_Scope
./pi-scope          # desktop window (--web opens the browser, --server runs headless)
```

```powershell
cd Pi_Scope
.\pi-scope.cmd      # same modes
```

## Windows Defender and SmartScreen

`install.ps1` is an unsigned script that downloads a release and unpacks it — the
shape Defender's heuristics exist to catch — so it is sometimes flagged as a
trojan. It is a false positive. The file form above is the least suspicious way to
run it, and the script is written to avoid that shape:

- it downloads the GitHub **tarball** and unpacks it with `tar.exe` (part of
  Windows since 10 1803), so there is no download-a-zip-then-execute chain, which
  is what the heuristic reacts to;
- it prefers `curl.exe` for the download and falls back to `Invoke-WebRequest
  -UseBasicParsing`, the invocation Microsoft documents as safe;
- it clears the mark-of-the-web — the scripted form of the *Unblock* checkbox in a
  file's Properties — on the files it just downloaded, so Windows stops treating
  the app's own files as untrusted web content. Nothing else on disk is touched.

If Defender quarantines the file anyway, read it (it is a few hundred lines of
plain PowerShell, no obfuscation, no encoded blob) and as a last resort allow that
one file: `Add-MpPreference -ExclusionPath .\install.ps1`. Prefer that to
excluding the install directory — what runs there afterwards is ordinary `npm`
output and will change on every update.

## What the installers refuse to do

Both channels are meant to be auditable in one sitting, and neither needs
administrator rights:

- **https only.** `--url` / `-Url` must be an `https://` URL, and a redirect is
  held to https too. There is deliberately no plain-HTTP escape hatch: the
  archive is unpacked and then executed, so an on-path attacker who could swap it
  would be choosing the code you run.
- **No path escape.** The archive listing is checked before extraction, and an
  archive with absolute member names or `..` segments is rejected rather than
  unpacked (a "zip-slip" archive could otherwise write anywhere you can).
- **No clobbering.** A `--dir` / `-Dir` that already exists, is not empty and
  does not look like Pi Scope is refused instead of overwritten. Re-running an
  install over a previous Pi Scope works.
- **No silent privilege change.** Neither script elevates. Running one as root
  (a container) or from an elevated PowerShell only prints a warning that the
  tree will be owned by that account.
- **No hidden dependency trust beyond the install itself.** `npm install` runs
  the packages' own install scripts, which `node-pty`, `esbuild` and
  `ffmpeg-static` need — that is why pnpm gets `--no-ignore-scripts` and Bun
  `bun pm trust --all`. If vendored build scripts are not acceptable, pass
  `--no-deps` / `-NoDeps` and install the dependencies yourself after reading
  `package.json`.

Neither installer writes outside the install directory and, on a fresh machine,
`~/.pi-scope/` — the agent dir (`~/.pi-scope/agent`, see below) and the bundled
`pi` coding agent (`~/.pi-scope/pi`). Nothing is added to `PATH`, no registry keys are
touched and no Defender exclusions are created.

## From a checkout

Cloned the repo already? Run an installer in place — it detects the surrounding
project and skips the download:

```bash
./install/install.sh              # curl channel, npm by default
./install/install.sh --pm pnpm    # or --pm bun
```

```powershell
.\install\install.ps1             # PowerShell channel, npm by default
.\install\install.ps1 -Pm bun     # or -Pm pnpm
```

Add `-ExecutionPolicy Bypass` if PowerShell blocks the file.

## Options

`install.sh`:

| Flag | Meaning | Environment |
|---|---|---|
| `--dir <path>` | where to install | `PISC_DIR` (default `./Pi_Scope`) |
| `--pm <name>` | `npm`, `pnpm` or `bun` | `PISC_PM` (default `npm`) |
| `--ref <name>` | branch or tag to fetch | `PISC_REF` (default `main`) |
| `--url <url>` | override the download URL (https only) | `PISC_URL` |
| `--no-deps` | skip the dependency install | `PISC_SKIP_DEPS=1` |

`install.ps1` takes the same settings as parameters: `-Dir`, `-Pm`, `-Ref`,
`-Url`, `-NoDeps` (and honors `PISC_PM`). Piped into `iex` the parameters cannot
be passed, so the defaults apply; run the file to customize.

## Package managers

`--pm` / `-Pm` selects which package manager installs the dependencies. Inside a
checkout you can equally run the command yourself:

| Manager | Command | Notes |
|---|---|---|
| **npm** | `npm install` | the default |
| **pnpm** | `pnpm install --no-ignore-scripts` | runs the dependency build scripts pnpm blocks by default (`node-pty`, `esbuild`, `ffmpeg-static`) |
| **Bun** | `bun install` then `bun pm trust --all` | runs the same blocked scripts; trusting them may add a `trustedDependencies` field to `package.json` |

Each channel also installs the bundled Pi coding agent — into the user's own
data directory (`~/.pi-scope/pi`), not into the checkout, so Settings → Update
can replace it and an update of the app never re-downloads it. An older release's
install under `apps/scope-desktop/pi-bundle` is migrated instead of fetched
again.

Node.js 24+ is required regardless of package manager — the server runs its
`.ts` sources directly and the bundled Pi agent runs on Node.

## Initial agent template

Pi Scope runs its bundled `pi` in its own agent dir (`~/.pi-scope/agent`, see
`SCOPE_AGENT_DIR`). On a fresh machine that dir is empty, so the installer seeds
it from `examples/pi_local/agent` — settings, skills, extensions, agents and
themes — giving the app a working starting point. An **existing agent dir is
never touched**.

The skills' Python `.venv` and the obscura `*.tar.gz` bundles are skipped (large
and platform-specific), as are `sessions/` and `__pycache__`.

> The template ships inside the repo at `examples/pi_local/agent`, so it is only
> available once that folder is committed to the branch the installers fetch.

## Requirements

- **Node.js 24+** — the installer checks and fails with a link if it is missing.
  Windows: `winget install OpenJS.NodeJS.LTS`.
- **curl** or **wget** — to fetch the download over https (the PowerShell channel
  prefers `curl.exe`, shipped with Windows 10 1803+, and otherwise uses
  `Invoke-WebRequest`).
- **tar** — to unpack the download (`bsdtar` ships with macOS and Linux;
  `tar.exe` with Windows 10 1803+).

## Uninstalling

Pi Scope is self-contained: delete the install directory (`Pi_Scope/`). Its data
lives in `db/scope.db` in a checkout, or `~/.pi-scope/` when packaged — the
database, the agent dir and the bundled `pi` (~/.pi-scope/pi) all live there, so
remove that too if you want a clean slate.
