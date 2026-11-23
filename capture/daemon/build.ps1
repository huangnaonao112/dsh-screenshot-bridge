# Build the resident capture daemon (dshshotd.exe).
param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bin = Join-Path $here 'bin'
$obj = Join-Path $here 'obj'
if ($Clean) { Remove-Item $bin, $obj -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $bin, $obj | Out-Null

$vcvars = @(
  'C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat',
  'C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vcvars) { throw 'vcvars64.bat not found' }

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('@echo off')
$lines.Add(('call "{0}" >nul' -f $vcvars))
$lines.Add(('cl /nologo /std:c++17 /EHsc /O2 /MT /W4 /wd4100 /wd4244 /wd4459 /DUNICODE /D_UNICODE /Fo{0}\ /Fe:"{1}" "{2}" /link /SUBSYSTEM:CONSOLE d3d11.lib dxgi.lib windowscodecs.lib ole32.lib user32.lib gdi32.lib dwmapi.lib' -f $obj, (Join-Path $bin 'dshshotd.exe'), (Join-Path $here 'dshshotd.cpp')))
$lines.Add('exit /b 0')
$bat = Join-Path $obj 'build.bat'
Set-Content -Path $bat -Value $lines -Encoding OEM
& cmd.exe /c $bat
if (-not (Test-Path (Join-Path $bin 'dshshotd.exe'))) { throw 'dshshotd.exe not produced' }
Write-Host ("built " + (Join-Path $bin 'dshshotd.exe'))