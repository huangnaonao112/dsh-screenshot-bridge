# Regression test for the capture-protection bypass.
#
#   pwsh -File .\test-wda.ps1
#
# 1. opens a window that sets WDA_EXCLUDEFROMCAPTURE in its own process
# 2. captures the region twice with the GDI backend (protected / cleared)
# 3. asserts the region changed, i.e. the payload really un-hid the window
#
# Exit code 0 = bypass works on this machine.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$bin = Join-Path $root 'bin'

function Invoke-Json($file, $arguments) {
  $text = & $file @arguments 2>$null | Out-String
  $line = ($text -split "`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
  if (-not $line) { throw "no json from $file $arguments" }
  return $line.Trim() | ConvertFrom-Json
}

function Measure-Crop($png, $rect) {
  Add-Type -AssemblyName System.Drawing
  $bitmap = [System.Drawing.Bitmap]::FromFile($png)
  try {
    $crop = $bitmap.Clone(
      (New-Object System.Drawing.Rectangle $rect[0], $rect[1], $rect[2], $rect[3]),
      $bitmap.PixelFormat)
    try {
      $sum = 0.0
      $count = 0
      for ($x = 0; $x -lt $crop.Width; $x += 11) {
        for ($y = 0; $y -lt $crop.Height; $y += 11) {
          $p = $crop.GetPixel($x, $y)
          $sum += ($p.R + $p.G + $p.B) / 3
          $count += 1
        }
      }
      return [math]::Round($sum / $count, 2)
    } finally { $crop.Dispose() }
  } finally { $bitmap.Dispose() }
}

New-Item -ItemType Directory -Force -Path (Join-Path $here 'out') | Out-Null
$holdFile = Join-Path $here 'out\hold.json'
if (Test-Path $holdFile) { Remove-Item $holdFile -Force }

$hold = Start-Process -FilePath (Join-Path $bin 'shotcap.exe') `
  -ArgumentList '--hold', '40', '--wda', 'exclude' `
  -RedirectStandardOutput $holdFile -PassThru
Start-Sleep -Seconds 2
$info = Get-Content $holdFile | ConvertFrom-Json
if (-not $info.hwnd) { throw 'held window did not report' }

$before = Invoke-Json (Join-Path $bin 'shotcap.exe') @('--out', (Join-Path $here 'out\before.png'), '--mode', 'screen', '--backend', 'gdi', '--json')
$beforeMean = Measure-Crop (Join-Path $here 'out\before.png') $info.rect

$clear = Invoke-Json (Join-Path $bin 'wdaclear.exe') @('--clear', '--target', ("pid:" + $info.pid))
Start-Sleep -Milliseconds 700

$after = Invoke-Json (Join-Path $bin 'shotcap.exe') @('--out', (Join-Path $here 'out\after.png'), '--mode', 'screen', '--backend', 'gdi', '--json')
$afterMean = Measure-Crop (Join-Path $here 'out\after.png') $info.rect

$delta = [math]::Abs($afterMean - $beforeMean)
$pass = ($clear.cleared -ge 1) -and ($delta -ge 25)

$result = [ordered]@{
  kind      = 'capture-regression'
  pass      = $pass
  hwnd      = $info.hwnd
  pid       = $info.pid
  affinity  = $info.wda
  cleared   = $clear.cleared
  before    = $beforeMean
  after     = $afterMean
  delta     = $delta
  backend   = $after.backend
}
$result | ConvertTo-Json -Compress

if ($hold -and -not $hold.HasExited) { $hold.Kill() }
if ($pass) { exit 0 } else { exit 1 }