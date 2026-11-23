# Build every native helper and stage the binaries inside the plugin's bin/.
#   .\build-all.ps1            build + copy
#   .\build-all.ps1 -NoKernel  skip the kernel driver (already the default unless -Kernel)
param([switch]$Kernel)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$bin = Join-Path $root 'bin'
New-Item -ItemType Directory -Force -Path $bin | Out-Null

& pwsh -NoProfile -File (Join-Path $here 'shotcap\build.ps1')
& pwsh -NoProfile -File (Join-Path $here 'daemon\build.ps1')
& pwsh -NoProfile -File (Join-Path $here 'wda\build.ps1')

Copy-Item (Join-Path $here 'shotcap\bin\shotcap.exe') $bin -Force
Copy-Item (Join-Path $here 'daemon\bin\dshshotd.exe') $bin -Force
Copy-Item (Join-Path $here 'wda\bin\wdaclear.exe') $bin -Force
$payload = Get-ChildItem (Join-Path $here 'wda\bin') -Filter 'wdapay*.dll' |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $payload) { throw 'payload dll missing' }
Copy-Item $payload.FullName $bin -Force

if ($Kernel) {
  & pwsh -NoProfile -File (Join-Path $here 'kdrv\build.ps1')
  Copy-Item (Join-Path $here 'kdrv\bin\dshshot.sys') $bin -Force
  Copy-Item (Join-Path $here 'kdrv\bin\dshcapctl.exe') $bin -Force
}

Get-ChildItem $bin | Select-Object Name, Length
