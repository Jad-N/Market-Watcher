param(
  [string]$Src,
  [string]$Out,
  [int]$W = 1760,
  [int]$H = 1400,
  [switch]$DumpDom
)
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$tmp = Join-Path $env:TEMP ("brief_" + [guid]::NewGuid().ToString("N") + ".html")
Copy-Item -LiteralPath $Src -Destination $tmp -Force
$prof = Join-Path $env:TEMP ("cdp_" + [guid]::NewGuid().ToString("N"))
$page = "file:///" + (($tmp -replace '\\','/'))
if ($DumpDom) {
  $domOut = $Out
  Start-Process -FilePath $chrome -ArgumentList @("--headless=new","--disable-gpu","--dump-dom","--virtual-time-budget=2500","--user-data-dir=$prof",$page) -Wait -WindowStyle Hidden -RedirectStandardOutput $domOut
} else {
  Start-Process -FilePath $chrome -ArgumentList @("--headless=new","--disable-gpu","--hide-scrollbars","--force-device-scale-factor=2","--screenshot=$Out","--window-size=$W,$H","--virtual-time-budget=2500","--user-data-dir=$prof",$page) -Wait -WindowStyle Hidden
}
if (Test-Path $Out) { "OK $Out ($((Get-Item $Out).Length) bytes)" } else { "FAILED no output" }
