<#
  install.ps1 — install Pi Scope on Windows with one command (PowerShell channel):

    irm https://raw.githubusercontent.com/NerdAtWork24X7/Pi_Scope/main/install/install.ps1 -UseBasicParsing | iex

  Downloads the app (a GitHub tarball, so `git` is not required), checks for a
  Node.js 24+ runtime, and installs its dependencies into .\Pi_Scope. Run the
  file itself to pass arguments:

    .\install.ps1 -Dir C:\tools\Pi_Scope -Pm pnpm -Ref v1.2.0 -NoDeps

  (Piped into `iex` the parameters cannot be passed — the defaults below apply.)

  Note the -UseBasicParsing in the one-liner: it is what Microsoft's December
  2025 web-cmdlet hardening (CVE-2025-54100) requires. Without it, PowerShell
  5.1 pops an interactive "Script Execution Risk" prompt, and a piped run hangs
  waiting at it.

  If Windows Defender or SmartScreen warns about this script, that is a false
  positive: an unsigned script that downloads and unpacks a release looks, to a
  heuristic, like the dropper it is copied from. The file form trips the fewest
  of those heuristics — nothing is piped into `iex`, and the script is unblocked
  before it runs:

    irm https://raw.githubusercontent.com/NerdAtWork24X7/Pi_Scope/main/install/install.ps1 -UseBasicParsing -OutFile install.ps1
    Unblock-File .\install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

  If PowerShell refuses to run the file ("running scripts is disabled on this
  system"), either use the one-liner above — `iex` is unaffected by the
  execution policy — or run it with -ExecutionPolicy Bypass, as above.

  Running it from a checkout installs that checkout in place; naming -Dir
  installs the downloaded copy there instead. Other channels: install/README.md.
#>
#Requires -Version 5.1
param(
  [string]$Dir = "",
  [ValidateSet("npm", "pnpm", "bun")]
  [string]$Pm = "npm",
  [string]$Ref = "main",
  [string]$Url = "",
  [switch]$NoDeps
)

$ErrorActionPreference = "Stop"

$Slug = "NerdAtWork24X7/Pi_Scope"

function Die($Message) {
  Write-Host "install.ps1: $Message" -ForegroundColor Red
  exit 1
}
function Info($Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

# PISC_PM is how the piped one-liner picks a package manager, since it cannot
# pass -Pm. It is validated here rather than by assigning straight into $Pm: the
# parameter's ValidateSet makes such an assignment fail with a raw MetadataError,
# and an unusable value has to be reported before the install starts, not in the
# middle of it (this string is used as a command name below).
$PmOverride = $env:PISC_PM
if ($PmOverride) {
  if (@("npm", "pnpm", "bun") -notcontains $PmOverride) {
    Die "PISC_PM must be npm, pnpm or bun (got '$PmOverride')"
  }
  $Pm = $PmOverride
}

# Run the chosen package manager's install in one directory and fail loudly on a
# non-zero exit (ErrorActionPreference does not catch native exit codes).
function Invoke-PmInstall($Path) {
  Push-Location $Path
  try {
    switch ($Pm) {
      "npm"  { & npm install --no-audit --no-fund }
      # pnpm blocks dependency build scripts by default; node-pty, esbuild and
      # ffmpeg-static need them, so force them to run.
      "pnpm" { & pnpm install --no-ignore-scripts }
      # Bun also blocks those scripts until a package is trusted. Trusting them
      # may write a trustedDependencies field; it exits 1 when there is nothing
      # left to run, which is not a failure.
      "bun"  {
        & bun install
        if ($LASTEXITCODE -ne 0) { throw "bun install failed with exit code $LASTEXITCODE" }
        & bun pm trust --all
        $global:LASTEXITCODE = 0
      }
    }
    if ($LASTEXITCODE -ne 0) { throw "$Pm install failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

# Download one URL to a local file. curl.exe (shipped with Windows 10 1803 and
# later) is tried first: it is a plain file downloader, so it neither trips the
# PowerShell 5.1 web-cmdlet prompt nor buffers the whole response in memory. The
# fallback is Invoke-WebRequest with -UseBasicParsing, the invocation Microsoft
# documents as safe for exactly this reason.
# Throws when both fail, so the caller can report the URL.
function Get-RemoteFile($Source, $Dest) {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    # stderr is discarded and a throw is swallowed: under
    # $ErrorActionPreference = "Stop" a native command writing to stderr can abort
    # the script with a raw NativeCommandError, and any curl failure should just
    # fall through to the fallback below.
    try { & $curl.Source -fsSL --retry 3 -o $Dest $Source 2>$null } catch { }
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $Dest)) { return }
    Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
  }
  Invoke-WebRequest -UseBasicParsing -Uri $Source -OutFile $Dest
}

# Clear the "downloaded from the internet" mark (the Zone.Identifier stream)
# from an installed tree, so Windows stops treating the app's own files as
# untrusted web content and handing them to Defender/SmartScreen on every
# launch. This is the scripted equivalent of the Unblock checkbox in a file's
# Properties dialog — it changes no security setting and adds no exclusion.
function Unblock-Tree($Root) {
  # Only Windows marks downloads this way; on PowerShell 7 for Linux/macOS there
  # is nothing to clear and the cmdlet itself refuses to run.
  if ($env:OS -ne "Windows_NT") { return }
  Get-ChildItem -LiteralPath $Root -Recurse -Force -File -ErrorAction SilentlyContinue |
    ForEach-Object { Unblock-File -LiteralPath $_.FullName -ErrorAction SilentlyContinue }
}

# Copy the example agent into a fresh agent dir, skipping machine-specific
# artifacts: the skills' Python .venv and the obscura *.tar.gz bundles are large
# and platform-bound, and session logs are per-user.
function Copy-AgentTemplate($Template, $Target) {
  $skipDirs  = @('.venv', 'sessions', '__pycache__')
  $skipGlobs = @('*.tar.gz', '*.pyc')
  $base = (Resolve-Path -LiteralPath $Template).Path.TrimEnd('\', '/')
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  Get-ChildItem -LiteralPath $base -Recurse -Force -File | ForEach-Object {
    $rel = $_.FullName.Substring($base.Length).TrimStart('\', '/')
    $segments = $rel -split '[\\/]'
    foreach ($segment in $segments) { if ($skipDirs -contains $segment) { return } }
    foreach ($glob in $skipGlobs) { if ($_.Name -like $glob) { return } }
    $dest = Join-Path $Target $rel
    $destDir = Split-Path -Parent $dest
    if ($destDir -and -not (Test-Path -LiteralPath $destDir)) {
      New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    }
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
  }
}

# Older Windows PowerShell defaults to SSL3/TLS1.0, which GitHub refuses.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

# A checkout (not a pipeline): install that directory in place — unless the
# caller named a directory, in which case that is where the copy goes. The
# script lives in install\, so the project root is its own folder or its parent.
$SelfDir = ""
if ($MyInvocation.MyCommand.Path) { $SelfDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$InPlace = $false
if (-not $Dir -and $SelfDir) {
  foreach ($cand in @($SelfDir, (Split-Path -Parent $SelfDir))) {
    if ($cand -and (Test-Path (Join-Path $cand "package.json")) -and (Test-Path (Join-Path $cand "apps\scope-server\server.ts"))) {
      $InPlace = $true
      $Dir = $cand
      break
    }
  }
}
if (-not $Dir) { $Dir = Join-Path (Get-Location).Path "Pi_Scope" }
# A .tar.gz, deliberately: unpacking a ZIP into a directory and then running code
# from it is the shape Defender's heuristics flag, and tar.exe — part of Windows
# since 10 1803 — needs no extra software. The curl channel fetches the same
# tarball.
if (-not $Url) { $Url = "https://codeload.github.com/$Slug/tar.gz/refs/heads/$Ref" }
# https only: the archive is unpacked and then executed, so a plain-HTTP
# download is code an on-path attacker gets to choose. There is deliberately no
# http escape hatch here.
if ($Url -notmatch '^https://') { Die "-Url must be an https:// URL (got '$Url')" }

# Installing elevated leaves a tree this user cannot later write to. Warn rather
# than refuse: an admin console is a normal way to open PowerShell.
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Info "running elevated - $Dir will be owned by the administrator account"
  }
} catch { }

# Never unpack over a directory we do not recognise: a -Dir that points at an
# existing non-empty folder would otherwise have its contents overwritten. An
# update over a previous Pi Scope is fine - server.ts identifies one.
if (Test-Path -LiteralPath $Dir -PathType Leaf) { Die "$Dir exists and is not a directory" }
if ((Test-Path -LiteralPath $Dir) -and
    (Get-ChildItem -LiteralPath $Dir -Force | Select-Object -First 1) -and
    -not (Test-Path (Join-Path $Dir "apps\scope-server\server.ts"))) {
  Die "$Dir is not empty and does not look like Pi Scope - pass -Dir <new path> or empty it first"
}

# ── Node 24+ (the server runs its .ts sources directly) ──────────────────────

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Die "node not found on PATH - install Node.js 24+ (https://nodejs.org, or: winget install OpenJS.NodeJS.LTS) and open a new terminal"
}
$major = 0
try { $major = [int](& $node.Source -p "process.versions.node.split('.')[0]") } catch { $major = 0 }
if ($major -lt 24) {
  Die "Node.js 24+ required (found $(& $node.Source -v)) - the server runs .ts sources directly"
}

# ── Fetch the app (unless we are already inside one) ─────────────────────────

if (-not $InPlace) {
  if (-not (Get-Command tar -ErrorAction SilentlyContinue)) {
    Die "tar is required to unpack the download (tar.exe ships with Windows 10 1803 and later)"
  }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("piscope-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    Info "downloading $Slug ($Ref)..."
    # Work from the temp directory with relative names: PowerShell 5.1 does not
    # quote arguments it passes to native programs, so an absolute path holding a
    # space (a user name, say) would reach curl.exe or tar.exe as two arguments.
    Push-Location $tmp
    try {
      try {
        Get-RemoteFile $Url "app.tar.gz"
      } catch {
        Die "download failed: $Url ($($_.Exception.Message))"
      }

      Info "unpacking into $Dir..."
      # Reject absolute members and `..` traversal (a "zip-slip" archive) before
      # extracting: one that escapes the temp folder could drop files anywhere
      # the user can write. The listing also proves the download really is a
      # tarball.
      # 2>$null for the same reason as in Get-RemoteFile: tar's diagnostics must
      # not turn into a terminating error before the exit code is checked.
      $members = $null
      try { $members = & tar -t -f "app.tar.gz" 2>$null } catch { }
      if ($LASTEXITCODE -ne 0 -or -not $members) { Die "could not read the download - is $Url a .tar.gz?" }
      $unsafe = @($members | Where-Object { $_ -match '^[\\/]' -or $_ -match '(^|[\\/])\.\.([\\/]|$)' })
      if ($unsafe.Count) { Die "the archive contains unsafe paths (e.g. '$($unsafe[0])') - refusing to unpack it" }
      New-Item -ItemType Directory -Force -Path "x" | Out-Null
      try { & tar -x -z -f "app.tar.gz" -C "x" 2>$null } catch { }
      if ($LASTEXITCODE -ne 0) { Die "could not unpack the download: $Url" }
      # Clear the "downloaded from the internet" mark while the files are still
      # in the temp folder: the copy then carries none of it, and nothing
      # outside this install is touched.
      Unblock-Tree (Join-Path $tmp "x")
    } finally { Pop-Location }

    $src = Get-ChildItem -LiteralPath (Join-Path $tmp "x") -Directory | Select-Object -First 1
    if (-not $src) { Die "the archive did not contain the project directory" }
    New-Item -ItemType Directory -Force -Path $Dir | Out-Null
    # Copy the archive's contents into $Dir (the archive has one wrapper folder).
    Get-ChildItem -LiteralPath $src.FullName -Force | Copy-Item -Destination $Dir -Recurse -Force
    if (-not (Test-Path (Join-Path $Dir "apps\scope-server\server.ts"))) {
      Die "$Dir does not look like Pi Scope after unpacking"
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# ── Dependencies ─────────────────────────────────────────────────────────────

if ($NoDeps) {
  Info "skipping dependency install (-NoDeps)."
} else {
  if (-not (Get-Command $Pm -ErrorAction SilentlyContinue)) {
    Die "$Pm is required to install dependencies - install it and run this again"
  }
  Info "installing dependencies in $Dir with $Pm (this can take a minute)..."
  try { Invoke-PmInstall $Dir } catch { Die "$($_.Exception.Message) - run $Pm install manually in $Dir" }

  # The bundled Pi coding agent - and with it the server's own runtime packages
  # (node-pty, ws, see apps/scope-server/pi-deps.ts) - installs into the user's
  # own data dir (%USERPROFILE%\.pi-scope\pi) rather than into this checkout, so
  # Settings → Update can replace it and the tree survives re-installing the app.
  # `--move` migrates a bundle an older release left in
  # apps\scope-desktop\pi-bundle instead of fetching it again. A failure here is
  # not fatal: Chat falls back to a `pi` on PATH, and the server says which one it
  # chose at boot.
  $bundleInstaller = Join-Path $Dir "apps\scope-desktop\pi-bundle-install.mjs"
  if (Test-Path -LiteralPath $bundleInstaller) {
    Info "installing the bundled Pi coding agent and server packages with $Pm..."
    # LASTEXITCODE is reset first so a stale 0 cannot mask a failure, and stderr
    # is discarded: npm writes progress and warnings there, and under
    # $ErrorActionPreference = "Stop" a native command writing to stderr can abort
    # the script with a raw NativeCommandError.
    $global:LASTEXITCODE = 0
    try { & $node.Source $bundleInstaller --pm $Pm --move 2>$null } catch { }
    if ($LASTEXITCODE -ne 0) {
      Info "the bundled Pi agent could not be installed - Chat will fall back to a pi on PATH."
      $global:LASTEXITCODE = 0
    }
  }
}

# ── Seed the agent dir (first run only) ──────────────────────────────────────

# Pi Scope runs its bundled `pi` in its own agent dir (agent-dir.ts; default
# ~/.pi-scope/agent). Give a fresh machine a starting template — settings,
# skills and extensions — copied from the example agent. An existing agent dir
# is never touched.
$AgentDir = if ($env:SCOPE_AGENT_DIR) { $env:SCOPE_AGENT_DIR } else { Join-Path $HOME ".pi-scope\agent" }
$Template = Join-Path $Dir "examples\pi_local\agent"

if (Test-Path -LiteralPath $AgentDir) {
  Info "agent dir already exists at $AgentDir - leaving it untouched."
} elseif (-not (Test-Path -LiteralPath $Template)) {
  Info "no agent template at $Template - skipping the initial agent setup."
} else {
  Info "seeding the agent template into $AgentDir..."
  try {
    Copy-AgentTemplate $Template $AgentDir
    Info "agent template installed in $AgentDir."
  } catch {
    Info "could not seed the agent template - Pi Scope creates its agent dir on first run."
  }
}

# ── Extension dependencies ───────────────────────────────────────────────────

# pi discovers extensions in the agent dir (its extensions\ directory plus
# whatever settings.json adds or removes). A *local* extension's npm packages are
# nobody's job but ours - pi only installs dependencies for the packages it
# installed itself - so this walks every extension pi has available, reads the
# dependencies each one declares in a nearby package.json, and installs the
# missing ones into the bundled pi project (~/.pi-scope/pi), whose node_modules
# the app, the agent and every extension already share.
#
# Not fatal: an extension whose packages are missing reports that itself when it
# runs, so keep going and let the app start.
# The manifest lives in the agent template, so a fresh agent dir already has it;
# --seed-manifest covers a dir seeded by an older release, which is never
# re-seeded and would otherwise declare nothing.
$extInstaller = Join-Path $Dir "apps\scope-desktop\pi-extensions-install.mjs"
$extManifest = Join-Path $Dir "examples\pi_local\agent\extensions\package.json"
if (-not $NoDeps -and (Test-Path -LiteralPath $extInstaller)) {
  try {
    $global:LASTEXITCODE = 0
    & $node.Source $extInstaller --pm $Pm --agent $AgentDir --seed-manifest $extManifest
    if ($LASTEXITCODE -ne 0) {
      Info "some extension dependencies could not be installed - the extensions needing them will say so at run time."
      $global:LASTEXITCODE = 0
    }
  } catch {
    Info "could not install the extension dependencies - the extensions needing them will say so at run time."
  }
}

# ── Done ─────────────────────────────────────────────────────────────────────

Info "Pi Scope is installed in $Dir"
if ($NoDeps) {
  Write-Host "Next:"
  Write-Host "  cd `"$Dir`"; $Pm install; .\pi-scope.cmd"
} else {
  if ($InPlace) {
    Write-Host "Next:  .\pi-scope.cmd     (desktop window; --web opens the browser, --server runs headless)"
  } else {
    Write-Host "Next:"
    Write-Host "  cd `"$Dir`""
    Write-Host "  .\pi-scope.cmd           (desktop window; --web opens the browser, --server runs headless)"
  }
}
