<#
  stop.ps1 — stop a running Pi Scope server on Windows.

    .\stop.ps1

  First tries the /shutdown endpoint (clean: closes the DB, kills terminals,
  removes the token file). Falls back to stopping whatever is listening on the
  port. The Windows counterpart of stop.sh.

  Host, port and token come from the same places the launcher reads them: real
  environment variables first, then apps\scope-desktop\scope.env.
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [string]$BindHost = "",
  [string]$Token = ""
)

$Root = $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }
$EnvFile = Join-Path $Root "apps\scope-desktop\scope.env"

if (Test-Path $EnvFile) {
  foreach ($line in Get-Content -LiteralPath $EnvFile) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith("#")) { continue }
    $eq = $t.IndexOf("=")
    if ($eq -lt 1) { continue }
    $key = $t.Substring(0, $eq).Trim()
    $val = $t.Substring($eq + 1).Trim()
    switch ($key) {
      "SCOPE_PORT"       { if (-not $env:SCOPE_PORT)       { $env:SCOPE_PORT = $val } }
      "SCOPE_HOST"       { if (-not $env:SCOPE_HOST)       { $env:SCOPE_HOST = $val } }
      "SCOPE_AUTH_TOKEN" { if (-not $env:SCOPE_AUTH_TOKEN) { $env:SCOPE_AUTH_TOKEN = $val } }
    }
  }
}

$ScopePort = if ($Port -gt 0) { $Port } elseif ($env:SCOPE_PORT) { [int]$env:SCOPE_PORT } else { 43190 }
$ScopeHost = if ($BindHost) { $BindHost } elseif ($env:SCOPE_HOST) { $env:SCOPE_HOST } else { "127.0.0.1" }
$DisplayHost = $ScopeHost
if ($ScopeHost -eq "0.0.0.0" -or $ScopeHost -eq "::" -or $ScopeHost -eq "[::]") { $DisplayHost = "127.0.0.1" }
$TokenFile = if ($env:SCOPE_TOKEN_FILE) { $env:SCOPE_TOKEN_FILE } else { Join-Path $Root "tmp\scope_token" }

if (-not $Token -and (Test-Path $TokenFile)) {
  $Token = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
}

Write-Host "Stopping Pi Scope server on ${ScopeHost}:${ScopePort}..."

$headers = @{}
if ($Token) { $headers["Authorization"] = "Bearer $Token" }

$stopped = $false
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method POST -TimeoutSec 5 -Headers $headers `
    -Uri "http://${DisplayHost}:${ScopePort}/shutdown"
  if ($r.StatusCode -eq 200) {
    Write-Host "  Shutdown request accepted."
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      try {
        Invoke-WebRequest -UseBasicParsing -Uri "http://${DisplayHost}:${ScopePort}/health" -TimeoutSec 1 | Out-Null
      } catch { $stopped = $true; break }
    }
  }
} catch {
  Write-Host "  No server answered /shutdown."
}

if ($stopped) { Write-Host "  Server stopped."; exit 0 }

# Fallback: whatever holds the port. Get-NetTCPConnection ships with Windows 8+.
$conns = @()
try {
  $conns = Get-NetTCPConnection -LocalPort $ScopePort -State Listen -ErrorAction SilentlyContinue
} catch { $conns = @() }
if ($conns.Count -gt 0) {
  $pid_ = ($conns | Select-Object -First 1).OwningProcess
  Write-Host "  Stopping the process listening on $ScopePort (pid $pid_)..."
  try { Stop-Process -Id $pid_ -Force } catch { Write-Host "  Could not stop pid $pid_."; exit 1 }
  Write-Host "  Server stopped."
  exit 0
}

Write-Host "  No process found listening on ${ScopeHost}:${ScopePort}."
exit 0
