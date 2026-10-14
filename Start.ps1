<#
  Start.ps1 — one command to bring up Pi Scope on Windows.

    .\Start.ps1                  desktop app (Electron window, default)
    .\Start.ps1 -Web             headless server + open the WebUI in your browser
    .\Start.ps1 -Server          headless server only, stays in the foreground

  Extra flags: -Dev (server with --watch), -KeepServer (leave the server running
  after this script exits), -Port/-BindHost/-DbPath/-Token.

  `-DbPath`, not `-Db`: PowerShell's common parameters claim `-db` as a prefix of
  `-Debug`, and a parameter that conflicts with a built-in one is rejected.

  The server is started at most once: if one is already healthy on the target
  port its token is adopted instead of a second instance being spawned. Ctrl-C
  shuts down only a server this script started. `Start.cmd` is the double-click
  friendly wrapper (it bypasses the PowerShell execution policy for you).

  This is the Windows counterpart of Start.sh — same modes, same env vars, same
  `apps/scope-desktop/scope.env` file (real environment variables always win).
#>
[CmdletBinding()]
param(
  [switch]$Web,
  [switch]$Server,
  [switch]$Dev,
  [switch]$KeepServer,
  [int]$Port = 0,
  [string]$BindHost = "",
  # Named `-DbPath` rather than `-Db`: with [CmdletBinding()] PowerShell's own
  # `-Debug` claims the `db` prefix, and PowerShell refuses a parameter that
  # conflicts with a common one ("The parameter 'Db' cannot be specified because
  # it conflicts with the parameter alias of the same name for parameter
  # 'Debug'"). Start.sh's `--db` has no such problem.
  [string]$DbPath = "",
  [string]$Token = ""
)

$ErrorActionPreference = "Stop"

$Root = $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }
$ServerDir = Join-Path $Root "apps\scope-server"
$DesktopDir = Join-Path $Root "apps\scope-desktop"
$RunDir = Join-Path $Root "tmp"                     # git-ignored: pid/log/token
$LogFile = Join-Path $RunDir "scope-server.log"
$ErrFile = Join-Path $RunDir "scope-server.err.log"
$EnvFile = Join-Path $DesktopDir "scope.env"        # optional per-machine settings

function Die($Message) {
  Write-Host "Start.ps1: $Message" -ForegroundColor Red
  exit 1
}
function Info($Message) {
  Write-Host "==> $Message" -ForegroundColor Cyan
}

if (-not (Test-Path (Join-Path $ServerDir "server.ts"))) {
  Die "server.ts not found under $ServerDir"
}

# ── Config: real env > scope.env file > defaults ─────────────────────────────
# Mirrors Start.sh (and scope-control.js) so the desktop icon and this script
# agree on host, port and token. File values are only defaults: they never
# override something already set.
if (Test-Path $EnvFile) {
  foreach ($line in Get-Content -LiteralPath $EnvFile) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $eq = $t.IndexOf("=")
    if ($eq -lt 1) { continue }
    $key = $t.Substring(0, $eq).Trim()
    $val = $t.Substring($eq + 1).Trim()
    if ($val.Length -ge 2 -and (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'")))) {
      $val = $val.Substring(1, $val.Length - 2)
    }
    switch ($key) {
      "SCOPE_PORT"       { if (-not $env:SCOPE_PORT)       { $env:SCOPE_PORT = $val } }
      "SCOPE_HOST"       { if (-not $env:SCOPE_HOST)       { $env:SCOPE_HOST = $val } }
      "SCOPE_DB_PATH"    { if (-not $env:SCOPE_DB_PATH)    { $env:SCOPE_DB_PATH = $val } }
      "SCOPE_AUTH_TOKEN" { if (-not $env:SCOPE_AUTH_TOKEN) { $env:SCOPE_AUTH_TOKEN = $val } }
    }
  }
}

$ScopePort = if ($Port -gt 0) { $Port } elseif ($env:SCOPE_PORT) { [int]$env:SCOPE_PORT } else { 43190 }
$ScopeHost = if ($BindHost) { $BindHost } elseif ($env:SCOPE_HOST) { $env:SCOPE_HOST } else { "127.0.0.1" }
$ScopeDb = if ($DbPath) { $DbPath } elseif ($env:SCOPE_DB_PATH) { $env:SCOPE_DB_PATH } else { Join-Path $Root "db\scope.db" }
$TokenFile = if ($env:SCOPE_TOKEN_FILE) { $env:SCOPE_TOKEN_FILE } else { Join-Path $RunDir "scope_token" }

# A wildcard bind is not a usable browser target; the boot banner prints the LAN
# URL for phones.
$DisplayHost = $ScopeHost
if ($ScopeHost -eq "0.0.0.0" -or $ScopeHost -eq "::" -or $ScopeHost -eq "[::]") { $DisplayHost = "127.0.0.1" }
$HealthUrl = "http://${DisplayHost}:${ScopePort}/health"

# ── Node (24+; the server runs its .ts sources directly) ─────────────────────

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
  Die "node not found on PATH - install Node.js 24+ (https://nodejs.org, or: winget install OpenJS.NodeJS.LTS) and open a new terminal"
}
$NodeBin = $NodeCmd.Source
$NodeMajor = 0
try { $NodeMajor = [int](& $NodeBin -p "process.versions.node.split('.')[0]") } catch { $NodeMajor = 0 }
if ($NodeMajor -lt 24) {
  Die "Node.js 24+ required (found $(& $NodeBin -v)); the server runs .ts sources directly"
}

New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

# ── Helpers ──────────────────────────────────────────────────────────────────

function Test-Health([string]$Url, [string]$Bearer = "", [int]$TimeoutSec = 2) {
  try {
    if ($Bearer) {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec -Headers @{ Authorization = "Bearer $Bearer" }
    } else {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec
    }
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Test-PortBusy([int]$P, [string]$Host_) {
  # Something is listening there, whether or not it answers /health.
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $client.Connect($Host_, $P)
    $client.Close()
    return $true
  } catch { return $false }
}

function New-Token {
  ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")).Substring(0, 32)
}

# The server runs in its own hidden console window. `-WindowStyle` only exists on
# Windows (Windows PowerShell has no `$IsWindows` at all, and it is Windows-only,
# so "no variable" means Windows); the option is simply omitted elsewhere so the
# script still runs under PowerShell on Linux/macOS, where it is a handy smoke
# test.
$HiddenWindow = @{}
if (-not (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) -or $IsWindows) {
  $HiddenWindow = @{ WindowStyle = "Hidden" }
}

function Stop-ScopeServer {
  if (-not $script:ServerProc) { return }
  Info "stopping server (pid $($script:ServerProc.Id))..."
  try {
    # Graceful first: /shutdown closes the DB, kills terminals, removes the token.
    Invoke-WebRequest -UseBasicParsing -Method POST -Uri "http://${DisplayHost}:${ScopePort}/shutdown" `
      -TimeoutSec 4 -Headers @{ Authorization = "Bearer $script:ScopeToken" } | Out-Null
  } catch { }
  try { $script:ServerProc.WaitForExit(8000) | Out-Null } catch { }
  if (-not $script:ServerProc.HasExited) {
    try { Stop-Process -Id $script:ServerProc.Id -Force } catch { }
  }
  $script:ServerProc = $null
  Info "server stopped."
}

# ── Boot the server (at most one) ────────────────────────────────────────────

$ServerProc = $null
$Adopted = $false

if (Test-Health $HealthUrl) {
  Info "reusing the Pi Scope server already listening on ${ScopeHost}:${ScopePort}."
  $Adopted = $true
  if (-not $Token -and (Test-Path $TokenFile)) {
    $Token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
  }
} else {
  if (Test-PortBusy $ScopePort $DisplayHost) {
    Die "port $ScopePort is already taken by another process.`n     Stop it, or pick another port:  .\Start.ps1 -Port $($ScopePort + 1)"
  }
  if (-not $Token) { $Token = New-Token }
  $ScopeToken = $Token
  $env:SCOPE_PORT = "$ScopePort"
  $env:SCOPE_HOST = $ScopeHost
  $env:SCOPE_DB_PATH = $ScopeDb
  $env:SCOPE_AUTH_TOKEN = $Token
  $env:SCOPE_TOKEN_FILE = $TokenFile

  $serverArgs = @()
  if ($Dev) { $serverArgs += "--watch" }
  $serverArgs += "server.ts"

  Info "starting Pi Scope server on ${ScopeHost}:${ScopePort}..."
  $ServerProc = Start-Process -FilePath $NodeBin -ArgumentList $serverArgs -WorkingDirectory $ServerDir `
    -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile @HiddenWindow

  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    if ($ServerProc.HasExited) {
      if (Test-Path $LogFile) { Get-Content -LiteralPath $LogFile -Tail 30 | Write-Host }
      if (Test-Path $ErrFile) { Get-Content -LiteralPath $ErrFile -Tail 30 | Write-Host }
      Die "server exited during startup (log: $LogFile)"
    }
    if (Test-Health $HealthUrl) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { Die "server did not become healthy within 30s (see $LogFile)" }
  Info "server healthy."
}

$ScopeToken = $Token
$UiUrl = "http://${DisplayHost}:${ScopePort}/?token=$([Uri]::EscapeDataString($Token))"

# ── Launch ───────────────────────────────────────────────────────────────────

try {
  if ($Server) {
    Info "Pi Scope is ready -> $UiUrl"
    Info "Press Ctrl-C to stop it. Log: $LogFile"
    if ($Adopted) {
      # Nothing to wait on (we did not spawn it): block until Ctrl-C.
      while ($true) { Start-Sleep -Seconds 1 }
    } else {
      Wait-Process -Id $ServerProc.Id
      Info "server stopped responding."
    }
  } elseif ($Web) {
    Info "Pi Scope is ready -> $UiUrl"
    Start-Process $UiUrl | Out-Null
    if ($Adopted) { while ($true) { Start-Sleep -Seconds 1 } }
    else {
      Wait-Process -Id $ServerProc.Id
      Info "server stopped responding."
    }
  } else {
    # Desktop: the Electron window owns the app from here (main.js attaches to
    # the server that is already up).
    $Electron = Join-Path $Root "node_modules\.bin\electron.cmd"
    if (-not (Test-Path $Electron)) {
      Info "installing dependencies (first run only)..."
      Push-Location $Root
      & npm install --no-audit --no-fund
      Pop-Location
    }
    if (-not (Test-Path $Electron)) { Die "electron is missing - run: npm install" }
    $env:ELECTRON_DISABLE_SANDBOX = "1"
    Info "opening the Pi Scope desktop app..."
    $proc = Start-Process -FilePath $Electron -ArgumentList "." -WorkingDirectory $DesktopDir -PassThru
    Wait-Process -Id $proc.Id
    if ($proc.ExitCode -ne 0) { Info "desktop app exited with status $($proc.ExitCode) (log: $(Join-Path $DesktopDir 'launcher.log'))." }
  }
} finally {
  if ($KeepServer -and $ServerProc) {
    Info "leaving the server running (pid $($ServerProc.Id), log: $LogFile)."
  } else {
    Stop-ScopeServer
  }
}
