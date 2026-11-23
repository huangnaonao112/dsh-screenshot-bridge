# Regression test for window-level capture + JPEG encode.
#
#   pwsh -File .\test-modes.ps1
#
# Opens a gradient window in another process, presses the daemon's hotkey, and
# asserts that the capture is the window itself (520x340, not the whole screen)
# and that the JPEG path stays fast.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$bin = Join-Path $root 'bin'
$out = Join-Path $here 'out\modes'
New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-ChildItem $out -Filter '*.jpg' | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $out -Filter '*.png' | Remove-Item -Force -ErrorAction SilentlyContinue
$holdFile = Join-Path $out 'hold.json'
if (Test-Path $holdFile) { Remove-Item $holdFile -Force }

$hold = Start-Process -FilePath (Join-Path $bin 'shotcap.exe') `
  -ArgumentList '--hold', '25', '--wda', 'none' `
  -RedirectStandardOutput $holdFile -PassThru
Start-Sleep -Milliseconds 1200
$info = Get-Content $holdFile | ConvertFrom-Json
if (-not $info.hwnd) { throw 'held window did not start' }

$log = Join-Path $out 'daemon.out'
if (Test-Path $log) { Remove-Item $log -Force }
$daemon = Start-Process -FilePath (Join-Path $bin 'dshshotd.exe') `
  -ArgumentList '--hotkey', 'Alt+Shift+F9', '--outdir', $out, '--target', 'window', '--format', 'jpg', '--prebuffer', '600', '--hwnd', $info.hwnd `
  -RedirectStandardOutput $log -PassThru
Start-Sleep -Milliseconds 2400

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('%+{F9}')
Start-Sleep -Milliseconds 1500

$lines = @(Get-Content $log | Where-Object { $_ -and $_.TrimStart().StartsWith('{') } |
  ForEach-Object { $_ | ConvertFrom-Json })
$capture = $lines | Where-Object { $_.kind -eq 'capture' } | Select-Object -Last 1
$ready = $lines | Where-Object { $_.kind -eq 'ready' } | Select-Object -Last 1
$file = Get-ChildItem $out -Filter '*.jpg' | Select-Object -First 1

$pass = ($null -ne $ready) -and ($null -ne $capture) -and ($null -ne $file) -and
  ($capture.backend -eq 'printwindow') -and ($capture.target -eq 'window') -and
  ([math]::Abs($capture.width - $info.rect[2]) -le 4) -and ($capture.ms -lt 150)

[ordered]@{
  kind     = 'modes-regression'
  pass     = $pass
  backend  = $capture.backend
  target   = $capture.target
  format   = $capture.format
  width    = $capture.width
  height   = $capture.height
  expect   = @($info.rect[2], $info.rect[3])
  mean     = [math]::Round($capture.mean, 1)
  ms       = $capture.ms
  fileSize = if ($file) { $file.Length } else { 0 }
} | ConvertTo-Json -Compress

if ($daemon -and -not $daemon.HasExited) { $daemon.Kill() }
if ($hold -and -not $hold.HasExited) { $hold.Kill() }
if ($pass) { exit 0 } else { exit 1 }
