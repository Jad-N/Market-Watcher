<#
  intraday-toast.ps1 — the unattended half of the intraday watch.

  Runs intraday-watch.js once, and fires a Windows desktop toast for each material event it
  reports (company post, news on a watchlist name, fear-gauge zone flip, price move past your
  threshold). No Claude session needed; no software installed — uses the built-in Windows
  toast API. Reaches you when Claude is closed but the PC is on and you're logged in.

  Registered by install-schedule.ps1 as "TDV Intraday Watch" — fires every 15 min on weekdays
  during market hours. The watcher self-gates to market hours, so off-hours runs do nothing.
  It shares "intraday state.json" with the in-session watcher, so the same event never toasts twice.

  Test now:  powershell -ExecutionPolicy Bypass -File ".\intraday-toast.ps1"
  Test a sample toast:  powershell -ExecutionPolicy Bypass -File ".\intraday-toast.ps1" -Demo
  Test the event->toast path:  powershell -ExecutionPolicy Bypass -File ".\intraday-toast.ps1" -FakeEvent "FILING IREN deal/capacity 10:00 | 8-K item 1.01"
#>

param([switch]$Demo, [string]$FakeEvent)

$ErrorActionPreference = 'Continue'
$dir = $PSScriptRoot
$log = Join-Path $dir 'intraday-watch.log'

function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Out-File -FilePath $log -Append -Encoding utf8 }

# Fire one Windows toast (built-in WinRT; rides PowerShell's app identity so no install/registration).
function Show-Toast($title, $body) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.ToastNotification,        Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument,                  Windows.Data.Xml.Dom,    ContentType = WindowsRuntime] | Out-Null
    $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $nodes = $tpl.GetElementsByTagName('text')
    $nodes.Item(0).AppendChild($tpl.CreateTextNode($title)) | Out-Null
    $nodes.Item(1).AppendChild($tpl.CreateTextNode($body))  | Out-Null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
    return $true
  } catch {
    Log "toast failed: $($_.Exception.Message)"
    return $false
  }
}

# Route one event line through the toast dispatch. Returns $true if it toasted, $false if quiet.
function Dispatch-Line($line) {
  if (-not $line) { return $false }
  $parts = $line -split ' ', 2
  $kind = $parts[0]
  $rest = if ($parts.Count -gt 1) { $parts[1] } else { '' }

  switch -Regex ($kind) {
    '^POST$'  { Show-Toast 'Company posted on X' $rest | Out-Null; Log "toast: $line"; return $true }
    '^NEWS$'  { Show-Toast 'Watchlist headline'  $rest | Out-Null; Log "toast: $line"; return $true }
    '^THEME$' { Show-Toast 'Theme headline'      $rest | Out-Null; Log "toast: $line"; return $true }
    '^FILING$' { Show-Toast 'Sector SEC filing'  $rest | Out-Null; Log "toast: $line"; return $true }
    '^GAUGE$' { Show-Toast 'Market mood shifted' $rest | Out-Null; Log "toast: $line"; return $true }
    '^MOVE$'  { Show-Toast 'Watchlist mover'     $rest | Out-Null; Log "toast: $line"; return $true }
    '^REGIME-FLIP$' { Show-Toast 'Market regime flipped' $rest | Out-Null; Log "toast: $line"; return $true }
    '^STRESS$' { Show-Toast 'Market stress flag'  $rest | Out-Null; Log "toast: $line"; return $true }
    '^MACRO$' { Show-Toast 'Macro print'          $rest | Out-Null; Log "toast: $line"; return $true }
    '^WATCHER-DEGRADED$' { Show-Toast 'Intraday watch — gap' $rest | Out-Null; Log "toast: $line"; return $true }
    default   { Log "info: $line"; return $false }   # WATCHER-READY / SLEEPING / RECOVERED / REGIME (quiet) — no toast
  }
}

if ($Demo) {
  $ok = Show-Toast 'Market Brief — intraday' 'Test toast: if you can see this, notifications work.'
  Write-Output "Demo toast sent: $ok"
  return
}

if ($FakeEvent) {
  $toasted = Dispatch-Line $FakeEvent
  Write-Output "Fake event dispatched (toasted=$toasted): $FakeEvent"
  return
}

# Run one poll. stdout = event lines; stderr (e.g. node cert warning) is left alone.
Push-Location $dir
try {
  $lines = & node 'intraday-watch.js' --once
} catch {
  Log "watcher run error: $($_.Exception.Message)"
  Pop-Location; return
}
Pop-Location

foreach ($line in $lines) {
  Dispatch-Line $line | Out-Null
}
