param(
  [switch]$Nightly,
  [string]$Repository = $(if ($env:TOKTRACKER_REPOSITORY) { $env:TOKTRACKER_REPOSITORY } else { "brrock/toktracker" })
)
$ErrorActionPreference = "Stop"
$Role = "client"
$Bun = Get-Command bun -ErrorAction SilentlyContinue
if (-not $Bun) { throw "Bun is required. Install it from https://bun.sh and run this installer again." }

$Headers = @{ "User-Agent" = "TokTracker installer" }
if ($Nightly) {
  $Releases = Invoke-RestMethod "https://api.github.com/repos/$Repository/releases?per_page=30" -Headers $Headers
  $Release = $Releases | Where-Object { $_.prerelease -and $_.tag_name.StartsWith("nightly-") } | Select-Object -First 1
} else {
  $Release = Invoke-RestMethod "https://api.github.com/repos/$Repository/releases/latest" -Headers $Headers
}
if (-not $Release) { throw "No matching release found." }
$AssetName = "toktracker-$Role-$($Release.tag_name).tgz"
$Asset = $Release.assets | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1
if (-not $Asset) { throw "Release archive not found." }

$Temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("toktracker-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $Temporary | Out-Null
try {
  $Archive = Join-Path $Temporary $AssetName
  Invoke-WebRequest $Asset.browser_download_url -OutFile $Archive -Headers $Headers
  # Bun cannot replace a globally installed local archive in place.
  & $Bun.Source remove --global "@toktracker/$Role-cli"
  & $Bun.Source add --global $Archive
  if ($LASTEXITCODE -ne 0) { throw "Bun could not install TokTracker client." }
} finally {
  Remove-Item -Recurse -Force $Temporary -ErrorAction SilentlyContinue
}
& toktracker-client setup
