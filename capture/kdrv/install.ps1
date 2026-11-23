# Install / remove the dshshot kernel driver.
#
#   .\install.ps1              copy, register, try to start
#   .\install.ps1 -Uninstall   stop, delete the service, delete the file
#
# The driver is not signed by a Microsoft-trusted certificate. Windows only
# loads it when driver signature enforcement is relaxed:
#   bcdedit /set testsigning on      (needs one reboot)
# or when you sign it yourself:
#   signtool sign /fd SHA256 /a /ac <cross-cert> /s My dshshot.sys
# This script turns test signing on when it has to, and tells you whether a
# reboot is still pending instead of pretending the driver is live.
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'bin\dshshot.sys'
$target = Join-Path $env:SystemRoot 'System32\drivers\dshshot.sys'
$service = 'dshshot'

function Assert-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'run this script from an elevated PowerShell window'
  }
}
Assert-Admin

function Get-LoadState {
  & sc.exe query $service 2>$null | Out-String
}

if ($Uninstall) {
  & sc.exe stop $service 2>$null | Out-Null
  & sc.exe delete $service 2>$null | Out-Null
  Start-Sleep -Milliseconds 300
  if (Test-Path $target) { Remove-Item $target -Force }
  Write-Host 'dshshot service and driver file removed'
  return
}

if (-not (Test-Path $source)) { throw "build first: $source is missing" }
Copy-Item $source $target -Force

$existing = Get-LoadState
if ($existing -match 'SERVICE_NAME') {
  & sc.exe stop $service 2>$null | Out-Null
  & sc.exe delete $service 2>$null | Out-Null
}
& sc.exe create $service type= kernel start= demand binPath= $target DisplayName= "DSH screenshot capture bridge" | Out-Null

$signing = (& bcdedit /enum '{current}' | Select-String -Pattern 'testsigning' | Out-String)
$testSigningOn = $signing -match 'testsigning\s+Yes'
if (-not $testSigningOn) {
  & bcdedit /set testsigning on | Out-Null
  Write-Host 'test signing was off: enabled it. A reboot is required before the driver can load.'
}

$start = & sc.exe start $service 2>&1 | Out-String
Write-Host $start.Trim()

$query = Get-LoadState
if ($query -match 'RUNNING') {
  $status = & (Join-Path $here 'bin\dshcapctl.exe') --status
  Write-Host $status
} else {
  Write-Host ''
  Write-Host 'Driver registered but not running yet. Typical reasons:'
  Write-Host '  * test signing was just enabled and the machine has not rebooted'
  Write-Host '  * the driver is unsigned and signature enforcement is still on (error 577)'
  Write-Host 'After the reboot run: sc start dshshot ; dshcapctl --status'
}