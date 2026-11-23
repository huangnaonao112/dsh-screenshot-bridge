# Build wdaclear.exe + wdapay.dll (x64) via a generated .bat (no quoting games).
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

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$common = '/nologo /std:c++17 /EHsc /O2 /MT /W4 /wd4100 /DUNICODE /D_UNICODE'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('@echo off')
$lines.Add(('call "{0}" >nul' -f $vcvars))
$lines.Add(('cl {0} /Fo{1}\ /c "{2}"' -f $common, $obj, (Join-Path $here 'wdapay.cpp')))
$lines.Add(('cl {0} /Fo{1}\ /c "{2}"' -f $common, $obj, (Join-Path $here 'wdaclear.cpp')))
$lines.Add(('link /nologo /DLL /SUBSYSTEM:WINDOWS /OUT:"{0}" "{1}" kernel32.lib user32.lib' -f (Join-Path $bin "wdapay-$stamp.dll"), (Join-Path $obj 'wdapay.obj')))
$lines.Add(('link /nologo /SUBSYSTEM:CONSOLE /OUT:"{0}" "{1}" kernel32.lib user32.lib' -f (Join-Path $bin 'wdaclear.exe'), (Join-Path $obj 'wdaclear.obj')))
$lines.Add('exit /b 0')
$bat = Join-Path $obj 'build.bat'
Set-Content -Path $bat -Value $lines -Encoding OEM

& cmd.exe /c $bat
# A previous run may have injected an older payload into a live process, which
# keeps that file mapped. Each build gets a stamped name; wdaclear picks the
# newest one, so a locked older copy never blocks a rebuild.
if (-not (Test-Path (Join-Path $bin 'wdaclear.exe'))) { throw 'wdaclear.exe not produced' }
if (-not (Get-ChildItem $bin -Filter 'wdapay*.dll')) { throw 'wdapay payload not produced' }
Write-Host ("built " + $bin)