# publish-npm.ps1 — finish the npm release with as little human input as possible.
#
#   $env:NPM_OTP = "123456"      # 6-digit code from the authenticator (publish-time)
#   pwsh -File publish-npm.ps1
#
#   $env:NPM_TOKEN = "npm_..."   # optional: a token with "Bypass 2FA"
#   pwsh -File publish-npm.ps1
#
# Without either, npm stages the version and the registry `latest` does not move;
# this script then prints the exact staged id and the one command left to run.
param(
  [string]$Otp = $env:NPM_OTP,
  [string]$Token = $env:NPM_TOKEN,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = 'C:\SKD\lunwen\tools\nodejs\node-v24.18.0-win-x64\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }
$npm = Join-Path $here '.toolchain\npm\package\bin\npm-cli.js'
if (-not (Test-Path $npm)) { throw 'npm toolchain missing: .toolchain\npm' }

$version = (Get-Content (Join-Path $here 'package.json') -Raw | ConvertFrom-Json).version

function Invoke-Npm([string[]]$args) {
  & $node $npm @args
  return $LASTEXITCODE
}

if ($Token -ne '') {
  $npmrc = Join-Path $env:USERPROFILE '.npmrc'
  $lines = @()
  if (Test-Path $npmrc) { $lines = Get-Content $npmrc | Where-Object { $_ -notmatch '_authToken=' } }
  $lines += "//registry.npmjs.org/:_authToken=$Token"
  Set-Content -Path $npmrc -Value $lines -Encoding UTF8
  Write-Host 'npm token installed in %USERPROFILE%\.npmrc'
}

if ($DryRun) {
  Write-Host "would publish dsh-screenshot-bridge@$version (otp=$(if ($Otp) {'set'} else {'missing'}))"
  exit 0
}

$args = @('publish', '--access', 'public')
if ($Otp -ne '') { $args += "--otp=$Otp" }
$code = Invoke-Npm $args
if ($code -eq 0) {
  Write-Host "published dsh-screenshot-bridge@$version"
  exit 0
}

# publish staged the version: approve it with the same code if we have one
$list = & $node $npm stage list --json 2>$null | Out-String
$staged = $null
try {
  $staged = ($list | ConvertFrom-Json) | Where-Object { $_.packageName -eq 'dsh-screenshot-bridge' -and $_.version -eq $version }
} catch {
  $staged = $null
}
if ($staged -ne $null -and $Otp -ne '') {
  $approve = @('stage', 'approve', $staged.id, "--otp=$Otp")
  $code = Invoke-Npm $approve
  if ($code -eq 0) { Write-Host "approved staged $version"; exit 0 }
}

Write-Host ''
Write-Host "npm did not complete. Registry still reports:" -ForegroundColor Yellow
& $node $npm view dsh-screenshot-bridge version 2>$null
Write-Host ''
Write-Host 'Staged versions:' -ForegroundColor Yellow
& $node $npm stage list 2>$null
Write-Host ''
Write-Host 'Retry with:' -ForegroundColor Yellow
Write-Host '  $env:NPM_OTP = "<6 digits>"; pwsh -File publish-npm.ps1'
Write-Host '  # or a token with Bypass 2FA:'
Write-Host '  $env:NPM_TOKEN = "npm_..."; pwsh -File publish-npm.ps1'
exit 1