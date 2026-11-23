# Build shotcap.exe with the MSVC toolset that ships with this machine.
#   .\build.ps1            -> bin\shotcap.exe
#   .\build.ps1 -Clean     -> wipe bin\ and obj\ first
param([switch]$Clean)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bin = Join-Path $here 'bin'
$obj = Join-Path $here 'obj'
if ($Clean) {
  Remove-Item $bin, $obj -Recurse -Force -ErrorAction SilentlyContinue
}
New-Item -ItemType Directory -Force -Path $bin, $obj | Out-Null

$vcvars = @(
  'C:\Program Files\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat',
  'C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat',
  'C:\Program Files (x86)\Microsoft Visual Studio\2019\Professional\VC\Auxiliary\Build\vcvars64.bat'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vcvars) { throw 'vcvars64.bat not found' }

$parts = @(
  'call "' + $vcvars + '" >nul & cl /nologo /std:c++17 /EHsc /O2 /MT /W4 /wd4100 /wd4244 /DUNICODE /D_UNICODE',
  ('/Fo' + $obj + '\'),
  ('/Fe:' + (Join-Path $bin 'shotcap.exe')),
  ('"' + (Join-Path $here 'shotcap.cpp') + '"'),
  '/link /SUBSYSTEM:CONSOLE d3d11.lib dxgi.lib windowscodecs.lib ole32.lib user32.lib gdi32.lib dwmapi.lib'
)
$cmd = ($parts -join ' ') + ' & exit /b %ERRORLEVEL%'
Write-Verbose $cmd

& cmd.exe /c $cmd
if ($LASTEXITCODE -ne 0) { throw "cl failed with $LASTEXITCODE" }
Write-Host ("built " + (Join-Path $bin 'shotcap.exe'))