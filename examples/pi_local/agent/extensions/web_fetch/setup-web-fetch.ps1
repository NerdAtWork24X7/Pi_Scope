# Standalone setup for the web-fetch extension package (native Windows).
# Installs Python deps into the shared venv beside the `pi` agent dir (under Pi
# Scope: %USERPROFILE%\.pi-scope\.venv; under a global pi: %USERPROFILE%\.pi\.venv)
# and ensures the Chromium browser binary is available - no package-local .venv.
#
# Normally the launcher builds the shared venv (pi-python-install.mjs); this is
# the manual / fallback path. Windows counterpart of setup-web-fetch.sh.
#   powershell -ExecutionPolicy Bypass -File .\setup-web-fetch.ps1
$ErrorActionPreference = "Stop"

powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

Set-Location -LiteralPath $PSScriptRoot   # this package directory

# The one venv every Python-dependent element shares. Derive its base from the
# agent dir so the same script works under Pi Scope and a global pi.
$AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } elseif ($env:SCOPE_AGENT_DIR) { $env:SCOPE_AGENT_DIR } else { Join-Path $env:USERPROFILE ".pi\agent" }
$BaseDir = Split-Path -Parent $AgentDir
$Venv = if ($env:SCOPE_PYTHON_VENV) { $env:SCOPE_PYTHON_VENV } else { Join-Path $BaseDir ".venv" }
if (-not $env:PLAYWRIGHT_BROWSERS_PATH) { $env:PLAYWRIGHT_BROWSERS_PATH = Join-Path $BaseDir "playwright-browsers" }
$Py = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $Py)) {
    Write-Host "Creating shared venv at $Venv ..."
    uv venv --python 3.12 $Venv
}

if (-not (Test-Path -LiteralPath $Py)) {
    Write-Error "error: no interpreter produced at $Py"
}

Write-Host "Installing Python dependencies into $Venv ..."
uv pip install --python $Py -r requirements.txt

Write-Host "Ensuring Chromium browser is installed ..."
& $Py -m playwright install chromium

Write-Host "Done. The web-fetch extension now runs from the shared venv at $Venv."
