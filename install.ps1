<#
  install.ps1 — install Pi Scope on Windows with one command:

    irm https://raw.githubusercontent.com/NerdAtWork24X7/Pi_Scope/main/install.ps1 | iex

  Downloads the app (a GitHub zip, so `git` is not required), checks for a
  Node.js 24+ runtime, and installs its dependencies into .\Pi_Scope. Run the
  file itself to pass arguments:

    .\install.ps1 -Dir C:\tools\Pi_Scope -Ref v1.2.0 -NoDeps

  (Piped into `iex` the parameters cannot be passed — the defaults below apply.)

  If PowerShell refuses to run the file ("running scripts is disabled on this
  system"), either use the one-liner above — `iex` is unaffected by the
  execution policy — or run:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1

  Running it from a checkout installs that checkout in place; naming -Dir
  installs the downloaded copy there instead.
#>
param(
  [string]$Dir = "",
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

# Older Windows PowerShell defaults to SSL3/TLS1.0, which GitHub refuses.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch { }

# A checkout (not a pipeline): install that directory in place — unless the
# caller named a directory, in which case that is where the copy goes.
$SelfDir = ""
if ($MyInvocation.MyCommand.Path) { $SelfDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$InPlace = $false
if (-not $Dir -and $SelfDir -and (Test-Path (Join-Path $SelfDir "package.json")) -and (Test-Path (Join-Path $SelfDir "apps\scope-server\server.ts"))) {
  $InPlace = $true
  $Dir = $SelfDir
}
if (-not $Dir) { $Dir = Join-Path (Get-Location).Path "Pi_Scope" }
if (-not $Url) { $Url = "https://codeload.github.com/$Slug/zip/refs/heads/$Ref" }

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
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("piscope-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $zip = Join-Path $tmp "app.zip"
    Info "downloading $Slug ($Ref)..."
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $zip
    } catch {
      Die "download failed: $Url ($($_.Exception.Message))"
    }

    Info "unpacking into $Dir..."
    Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp "x") -Force
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
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Die "npm is required to install dependencies (it ships with Node.js)"
  }
  Info "installing dependencies in $Dir (this can take a minute)..."
  Push-Location $Dir
  try {
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Die "npm install failed - run it manually in $Dir" }
  } finally { Pop-Location }

  # The bundled Pi coding agent keeps its own npm project, so Chat works with no
  # global `pi` install. A failure here is not fatal: Chat falls back to a `pi`
  # on PATH, and the server says which one it chose at boot.
  $bundle = Join-Path $Dir "apps\scope-desktop\pi-bundle"
  if (Test-Path (Join-Path $bundle "package.json")) {
    Info "installing the bundled Pi coding agent..."
    Push-Location $bundle
    try { & npm install --no-audit --no-fund } catch { }
    finally { Pop-Location }
  }
}

# ── Done ─────────────────────────────────────────────────────────────────────

Info "Pi Scope is installed in $Dir"
if ($NoDeps) {
  Write-Host "Next:"
  Write-Host "  cd `"$Dir`"; npm install; .\Start.ps1"
} else {
  if ($InPlace) {
    Write-Host "Next:  .\Start.ps1        (desktop window; -Web opens the browser, -Server runs headless)"
  } else {
    Write-Host "Next:"
    Write-Host "  cd `"$Dir`""
    Write-Host "  .\Start.ps1              (desktop window; -Web opens the browser, -Server runs headless)"
  }
}
