# npm-auth.ps1 (plugin-local wrapper)
#
# The npm token belongs to the npm account, not to one plugin, so the real
# secret and the real helper live in the DSH home and are shared by every
# plugin on this machine:
#
#   %DSH_HOME%\npm-token.dpapi   (DPAPI, current Windows user only)
#   %DSH_HOME%\npm-auth.ps1      (save / status / restore / publish / forget)
#
# This file only forwards, so old instructions such as
#   pwsh -File npm-auth.ps1 publish
# keep working from inside the plugin folder.
param(
  [ValidateSet('save', 'status', 'restore', 'publish', 'forget', 'where')]
  [string]$Action = 'status',
  [string]$Token = ''
)

$dshHome = if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$shared = Join-Path $dshHome 'npm-auth.ps1'
if (-not (Test-Path $shared)) {
  throw "shared helper missing: $shared (expected %DSH_HOME%\npm-auth.ps1)"
}

if ($Token -ne '') { & $shared -Action $Action -Token $Token }
else { & $shared -Action $Action }