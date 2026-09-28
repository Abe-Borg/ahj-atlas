param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Create', 'Verify')]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [string]$Directory
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'The package version is not a numeric release version.' }
$name = "AHJ-Atlas-$version-Windows-x64-Setup.exe"
$installer = Join-Path $Directory $name
$sums = Join-Path $Directory 'SHA256SUMS.txt'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Installer is missing: $installer" }
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()

if ($Mode -eq 'Create') {
  [System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($sums), "$hash  $name`n", [System.Text.Encoding]::ASCII)
} else {
  if (-not (Test-Path -LiteralPath $sums -PathType Leaf)) { throw "Checksum file is missing: $sums" }
  $lines = @(Get-Content -LiteralPath $sums | Where-Object { $_.Trim() })
  if ($lines.Count -ne 1 -or $lines[0] -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw 'Expected one SHA-256 checksum line.' }
  if ($Matches[2] -cne $name -or $Matches[1].ToLowerInvariant() -cne $hash) { throw 'Installer SHA-256 does not match SHA256SUMS.txt.' }
}

Write-Output "SHA-256 $($Mode.ToLowerInvariant()) passed: $hash  $name"
