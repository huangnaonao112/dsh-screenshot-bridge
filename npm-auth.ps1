# npm-auth.ps1 — keep this machine's npm publish token in the plugin folder,
# encrypted with Windows DPAPI (current user), and use it for publishing.
#
#   pwsh -File npm-auth.ps1 save "npm_xxx"   # encrypt into .npm-token.dpapi
#   pwsh -File npm-auth.ps1 save             # ...or take it from %USERPROFILE%\.npmrc
#   pwsh -File npm-auth.ps1 status           # masked token + npm whoami
#   pwsh -File npm-auth.ps1 restore          # write it back into .npmrc
#   pwsh -File npm-auth.ps1 publish          # restore + npm publish --access public
#
# The ciphertext is bound to this Windows user on this machine (DPAPI), so copying
# the file to another account or PC is useless. Both files are ignored by git and
# by npm packaging.
param(
  [ValidateSet('save', 'status', 'restore', 'publish', 'forget')]
  [string]$Action = 'status',
  [string]$Token = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$secretFile = Join-Path $here '.npm-token.dpapi'
$npmrc = Join-Path $env:USERPROFILE '.npmrc'
$node = 'C:\SKD\lunwen\tools\nodejs\node-v24.18.0-win-x64\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node).Source }
$npm = Join-Path $here '.toolchain\npm\package\bin\npm-cli.js'
if (-not (Test-Path $npm)) { throw 'npm toolchain missing: .toolchain\npm' }

function Read-Secret {
  if (-not (Test-Path $secretFile)) { throw "no saved token ($secretFile)" }
  $cipher = ([IO.File]::ReadAllText($secretFile)).Trim()
  if ($cipher -eq '') { throw "saved token file is empty ($secretFile)" }
  $secure = ConvertTo-SecureString $cipher
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

function Write-Npmrc([string]$plain) {
  if (Test-Path $npmrc) {
    Copy-Item $npmrc "$npmrc.before-restore" -Force
  }
  Set-Content -Path $npmrc -Value "//registry.npmjs.org/:_authToken=$plain" -Encoding UTF8
  # make the file user-only (inheritance off)
  & icacls $npmrc /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}

switch ($Action) {
  'save' {
    if ($Token -eq '') {
      if (-not (Test-Path $npmrc)) { throw 'no --Token and no .npmrc to read from' }
      $line = Get-Content $npmrc | Where-Object { $_ -match '_authToken=' } | Select-Object -First 1
      if ($null -eq $line) { throw '.npmrc has no _authToken line' }
      $Token = ($line -replace '.*_authToken=', '').Trim()
    }
    if ($Token.Length -lt 20) { throw 'that does not look like an npm token' }
    $secure = ConvertTo-SecureString $Token -AsPlainText -Force
    $cipher = ConvertFrom-SecureString $secure
    # no BOM, no trailing newline: ConvertTo-SecureString rejects whitespace
    [IO.File]::WriteAllText($secretFile, $cipher, (New-Object System.Text.UTF8Encoding($false)))
    & icacls $secretFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
    Write-Host "saved (DPAPI, current user): $secretFile"
  }
  'status' {
    $plain = Read-Secret
    $masked = $plain.Substring(0, 8) + '…' + $plain.Substring($plain.Length - 4)
    Write-Host "token: $masked (len=$($plain.Length))"
    Write-Host "current npmrc token matches: $((Get-Content $npmrc -Raw) -match [regex]::Escape($plain))"
    & $node $npm whoami 2>&1 | Select-Object -First 1
  }
  'restore' {
    $plain = Read-Secret
    Write-Npmrc $plain
    Write-Host "written to $npmrc"
  }
  'publish' {
    $plain = Read-Secret
    Write-Npmrc $plain
    Push-Location $here
    try {
      & $node $npm publish --access public
      $code = $LASTEXITCODE
      & $node $npm view dsh-screenshot-bridge version --prefer-online
      exit $code
    } finally {
      Pop-Location
    }
  }
  'forget' {
    if (Test-Path $secretFile) { Remove-Item $secretFile -Force; Write-Host 'saved token removed' }
    else { Write-Host 'nothing saved' }
  }
}