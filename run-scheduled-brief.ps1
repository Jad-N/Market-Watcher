<#
  run-scheduled-brief.ps1 — the scheduled entry point for the morning brief / evening recap.

  What it does, in order:
    1. Starts TradingView in controllable mode (so the brief's price pulls work) and waits briefly.
    2. Runs Claude Code headless against the matching skill (/morning-brief or /evening-recap).
    3. Opens the brief HTML it produced in the default browser.

  Usage:
    powershell -ExecutionPolicy Bypass -File ".\run-scheduled-brief.ps1" -Mode morning
    powershell -ExecutionPolicy Bypass -File ".\run-scheduled-brief.ps1" -Mode evening

  Registered by install-schedule.ps1 as two weekday tasks (pre-market + post-close).
  A run log is written to "Briefs\<date>\scheduled run (<mode>).log".
#>

param(
  [ValidateSet('morning','evening')]
  [string]$Mode = 'morning'
)

$ErrorActionPreference = 'Continue'

# --- resolve paths (this script lives in "Knowledge Base\Market briefs") ---
$briefsDir  = $PSScriptRoot
$projectDir = (Resolve-Path (Join-Path $briefsDir '..\..')).Path   # TDV MCP root
$date       = Get-Date -Format 'yyyy-MM-dd'
$outDir     = Join-Path $briefsDir "Briefs\$date"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$log        = Join-Path $outDir "scheduled run ($Mode).log"

function Log($msg) {
  $line = "$(Get-Date -Format 'HH:mm:ss')  $msg"
  $line | Tee-Object -FilePath $log -Append | Out-Null
}

Log "=== $Mode run starting ==="

# --- 1. start TradingView controllable ---
# Soft-start: TradingView is ONLY used to refresh the watchlist now (prices come from
# Yahoo via the fetcher). If it can't come up, the skill falls back to the cached
# symbol map.json and the brief still runs — so this never blocks the run.
$starter = Join-Path $projectDir 'start-tradingview-controllable.ps1'
if (Test-Path $starter) {
  Log "Soft-starting TradingView (watchlist refresh only; not required)..."
  try { & powershell -ExecutionPolicy Bypass -File $starter *>> $log } catch { Log "starter note: $($_.Exception.Message) — proceeding from cache" }
} else {
  Log "Note: starter script not found — proceeding from cached symbol map."
}
Start-Sleep -Seconds 15

# --- 2. run Claude Code headless against the skill ---
$skillCmd = if ($Mode -eq 'evening') { '/evening-recap' } else { '/morning-brief' }
$mcp = Join-Path $projectDir '.mcp.json'
Log "Running Claude headless: $skillCmd"

Push-Location $projectDir
try {
  # bypassPermissions so the unattended run never stalls on a prompt; project-scoped MCP loaded explicitly.
  & claude -p $skillCmd --permission-mode bypassPermissions --mcp-config $mcp *>> $log
  Log "Claude exited with code $LASTEXITCODE"
} catch {
  Log "Claude run error: $($_.Exception.Message)"
} finally {
  Pop-Location
}

# --- 3. open the produced brief ---
$fileName = if ($Mode -eq 'evening') { 'evening recap.html' } else { 'morning brief.html' }
$briefPath = Join-Path $outDir $fileName
if (Test-Path $briefPath) {
  Log "Opening $briefPath"
  Start-Process $briefPath
} else {
  Log "WARN: expected brief not found at $briefPath — check the log above for what Claude did."
}

Log "=== $Mode run done ==="
