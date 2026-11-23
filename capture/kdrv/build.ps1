# Build dshshot.sys (WDM, x64) + dshcapctl.exe.
#
# The WDK headers/libs come from either an installed Windows Driver Kit or the
# Microsoft.Windows.WDK.x64 NuGet package unpacked under
# %USERPROFILE%\.dsh\kdrv-toolchain\wdk\c
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

$nuget = Join-Path $env:USERPROFILE '.dsh\kdrv-toolchain\wdk\c'
$installed = 'C:\Program Files (x86)\Windows Kits\10'
$km = $null
$shared = $null
$lib = $null

if (Test-Path (Join-Path $nuget 'Include\10.0.26100.0\km\wdm.h')) {
  $km = Join-Path $nuget 'Include\10.0.26100.0\km'
  $shared = Join-Path $nuget 'Include\10.0.26100.0\shared'
  $lib = Join-Path $nuget 'Lib\10.0.26100.0\km\x64'
} else {
  $versions = Get-ChildItem (Join-Path $installed 'Include') -Directory |
    Sort-Object Name -Descending | Where-Object { Test-Path (Join-Path $_.FullName 'km\wdm.h') }
  if (-not $versions) { throw 'no WDK headers found; unpack Microsoft.Windows.WDK.x64 first' }
  $version = $versions | Select-Object -First 1
  $km = Join-Path $version.FullName 'km'
  $shared = Join-Path $version.FullName 'shared'
  $lib = Join-Path $installed ('Lib\' + $version.Name + '\km\x64')
}
if (-not (Test-Path (Join-Path $lib 'ntoskrnl.lib'))) { throw "ntoskrnl.lib missing under $lib" }

$kernelFlags = '/nologo /c /kernel /GS- /GR- /EHs-c- /Zl /W4 /D_AMD64_ /DAMD64 /D_WIN64 /DUNICODE /D_UNICODE /DPOOL_NX_OPTIN=1'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('@echo off')
$lines.Add(('call "{0}" >nul' -f $vcvars))
$lines.Add(('cl {0} /Fo{1}\ /I"{2}" /I"{3}" "{4}"' -f $kernelFlags, $obj, $km, $shared, (Join-Path $here 'dshshot.c')))
$lines.Add(('link /nologo /DRIVER /SUBSYSTEM:NATIVE /ENTRY:DriverEntry /MACHINE:X64 /LIBPATH:"{2}" /OUT:"{0}" "{1}" ntoskrnl.lib hal.lib' -f (Join-Path $bin 'dshshot.sys'), (Join-Path $obj 'dshshot.obj'), $lib))
$lines.Add(('cl /nologo /std:c++17 /EHsc /O2 /MT /DUNICODE /D_UNICODE /Fo{0}\ /Fe:"{1}" "{2}" /link user32.lib' -f $obj, (Join-Path $bin 'dshcapctl.exe'), (Join-Path $here 'dshcapctl.cpp')))
$lines.Add('exit /b 0')
$bat = Join-Path $obj 'build.bat'
Set-Content -Path $bat -Value $lines -Encoding OEM

& cmd.exe /c $bat
if (-not (Test-Path (Join-Path $bin 'dshshot.sys'))) { throw 'dshshot.sys not produced' }
if (-not (Test-Path (Join-Path $bin 'dshcapctl.exe'))) { throw 'dshcapctl.exe not produced' }
Write-Host ("built " + $bin)