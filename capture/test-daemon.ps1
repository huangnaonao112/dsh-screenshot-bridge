# Regression test for the resident daemon (dshshotd.exe).
#
#   pwsh -File .\test-daemon.ps1
#
# Asserts: the frame ring is used, a press produces a PNG, and end-to-end
# latency stays far below the old one-second chain.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$bin = Join-Path $root 'bin'
$out = Join-Path $here 'out\daemon'

New-Item -ItemType Directory -Force -Path $out | Out-Null
Get-ChildItem $out -Filter '*.png' | Remove-Item -Force -ErrorAction SilentlyContinue

$raw = & (Join-Path $bin 'dshshotd.exe') --bench 5 --outdir $out --clear --prebuffer 600 --prelag 250 2>$null
$lines = @($raw | ForEach-Object { $_.ToString() } | Where-Object { $_ -and $_.TrimStart().StartsWith('{') })
$captures = @($lines | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.kind -eq 'capture' })
$bench = $lines | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.kind -eq 'bench' } | Select-Object -Last 1
$files = @(Get-ChildItem $out -Filter '*.png')

$ringUsed = @($captures | Where-Object { $_.backend -like 'ring*' }).Count
$pass = ($captures.Count -ge 1) -and ($files.Count -ge 1) -and ($bench.avgMs -lt 150) -and ($ringUsed -ge 1)

[ordered]@{
  kind      = 'daemon-regression'
  pass      = $pass
  captures  = $captures.Count
  files     = $files.Count
  ringUsed  = $ringUsed
  avgMs     = $bench.avgMs
  minMs     = $bench.minMs
  backends  = @($captures | ForEach-Object { $_.backend })
  lagMs     = @($captures | ForEach-Object { $_.lag })
} | ConvertTo-Json -Compress

if ($pass) { exit 0 } else { exit 1 }