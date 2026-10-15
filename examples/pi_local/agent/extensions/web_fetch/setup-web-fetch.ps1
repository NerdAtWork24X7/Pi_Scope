# Standalone setup for the web-fetch extension package (native Windows).
# Installs Python deps into this package's local .venv and ensures the
# Chromium browser binary is available - no global `crwl`/venv required.
#
# Windows counterpart of setup-web-fetch.sh. Requires `uv` on PATH.
#   powershell -ExecutionPolicy Bypass -File .\setup-web-fetch.ps1
$ErrorActionPreference = "Stop"

powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

Set-Location -LiteralPath $PSScriptRoot   # this package directory

$Venv = ".venv"
# The venv interpreter lives in Scripts\ on Windows (bin/ on POSIX).
$Py = Join-Path $Venv "Scripts\python.exe"

if (-not (Test-Path -LiteralPath $Py)) {
    Write-Host "Creating venv at $Venv ..."
    uv venv --python 3.12
}

if (-not (Test-Path -LiteralPath $Py)) {
    Write-Error "error: no interpreter produced at $Py"
}

Write-Host "Installing Python dependencies ..."
uv pip install --upgrade pip
uv pip install -r requirements.txt

Write-Host "Ensuring Chromium browser is installed ..."
& $Py -m playwright install chromium

Write-Host "Done. The web-fetch extension now runs from this package's .venv."
