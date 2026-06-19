<#
  install-schedule.ps1 — registers (or removes) the Windows Task Scheduler tasks that
  run the briefs automatically on weekdays.

    Morning brief    8:00 AM            Mon-Fri
    Evening recap    5:00 PM            Mon-Fri
    Intraday watch   every 15 min, 7 AM-6 PM   Mon-Fri  (fires a desktop toast on a material change)

  The machine is on Eastern time, so these local times already equal ET.
  The brief tasks wake the computer; the intraday watch does NOT (no point waking the PC every
  15 min) and self-gates to market hours, so an off-hours fire is a fast no-op.

  Usage:
    powershell -ExecutionPolicy Bypass -File ".\install-schedule.ps1"            # install/update
    powershell -ExecutionPolicy Bypass -File ".\install-schedule.ps1" -Remove    # delete both tasks

  Re-running install is safe — it overwrites the existing tasks.
#>

param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$briefsDir   = $PSScriptRoot
$wrapper     = Join-Path $briefsDir 'run-scheduled-brief.ps1'
$intradayPs1 = Join-Path $briefsDir 'intraday-toast.ps1'
$intradayName = 'TDV Intraday Watch'

$tasks = @(
  @{ Name = 'TDV Morning Brief'; Mode = 'morning'; Time = '08:00' },
  @{ Name = 'TDV Evening Recap'; Mode = 'evening'; Time = '17:00' }
)

if ($Remove) {
  foreach ($name in (@($tasks.Name) + $intradayName)) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $name -Confirm:$false
      Write-Output "Removed: $name"
    } else {
      Write-Output "Not present: $name"
    }
  }
  return
}

if (-not (Test-Path $wrapper)) { throw "Wrapper not found: $wrapper" }

foreach ($t in $tasks) {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ("-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`" -Mode $($t.Mode)")

  $trigger = New-ScheduledTaskTrigger -Weekly `
    -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday `
    -At $t.Time

  $settings = New-ScheduledTaskSettingsSet `
    -WakeToRun `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

  # run as the logged-in user, only when logged on (needs the desktop session for TradingView + browser)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $t.Name `
    -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "Auto-generates the $($t.Mode) market brief and opens it in the browser." `
    -Force | Out-Null

  Write-Output "Installed: $($t.Name)  ($($t.Time) weekdays, $($t.Mode))"
}

# --- intraday watch: every 15 min, 7 AM-6 PM ET, weekdays, fires a desktop toast on a material change ---
if (Test-Path $intradayPs1) {
  $iAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument ("-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$intradayPs1`"")

  # weekly Mon-Fri at 7:00, repeating every 15 min for 11 hours (-> 6:00 PM)
  $iTrigger = New-ScheduledTaskTrigger -Weekly `
    -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At '07:00'
  $iTrigger.Repetition = (New-ScheduledTaskTrigger -Once -At '07:00' `
    -RepetitionInterval (New-TimeSpan -Minutes 15) `
    -RepetitionDuration (New-TimeSpan -Hours 11)).Repetition

  # NOT WakeToRun — don't wake the PC every 15 min; if it's asleep, the watch simply pauses.
  $iSettings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -DontStopOnIdleEnd `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

  $iPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $intradayName `
    -Action $iAction -Trigger $iTrigger -Settings $iSettings -Principal $iPrincipal `
    -Description "Polls the brief feeds every 15 min during market hours and fires a desktop toast on a material change (company X post, watchlist headline, fear-gauge flip, or a price move past the threshold in intraday-watch.json)." `
    -Force | Out-Null

  Write-Output "Installed: $intradayName  (every 15 min, 7 AM-6 PM ET weekdays, desktop toasts)"
} else {
  Write-Output "Skipped intraday watch: $intradayPs1 not found"
}

Write-Output ""
Write-Output "Done. Test a task now with:  Start-ScheduledTask -TaskName 'TDV Morning Brief'"
Write-Output "Test a toast now with:       intraday-toast.ps1 -Demo"
Write-Output "Remove later with:           install-schedule.ps1 -Remove"
