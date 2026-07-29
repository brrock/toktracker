param(
  [switch]$Nightly,
  [string]$Repository = $(if ($env:TOKTRACKER_REPOSITORY) { $env:TOKTRACKER_REPOSITORY } else { "brrock/toktracker" })
)
$ErrorActionPreference = "Stop"
$Role = "gateway"
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
$ChecksumAsset = $Release.assets | Where-Object { $_.name -eq "$AssetName.sha256" } | Select-Object -First 1
if (-not $Asset -or -not $ChecksumAsset) { throw "Release archive or checksum not found." }

$Temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("toktracker-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force $Temporary | Out-Null
try {
  $Archive = Join-Path $Temporary $AssetName
  $ChecksumFile = "$Archive.sha256"
  Invoke-WebRequest $Asset.browser_download_url -OutFile $Archive -Headers $Headers
  Invoke-WebRequest $ChecksumAsset.browser_download_url -OutFile $ChecksumFile -Headers $Headers
  $ExpectedChecksum = ((Get-Content $ChecksumFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
  $ActualChecksum = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ExpectedChecksum -ne $ActualChecksum) { throw "Release checksum verification failed." }
  $Version = [string]$Release.tag_name
  if ($Version -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*$') { throw "Invalid release version." }
  $ConfigRoot = if ($env:TOKTRACKER_CONFIG_ROOT) { $env:TOKTRACKER_CONFIG_ROOT } else { Join-Path $env:APPDATA "TokTracker" }
  $Versions = Join-Path $ConfigRoot "installs\$Role\versions"
  $Destination = Join-Path $Versions $Version
  if (-not (Test-Path (Join-Path $Destination "release.json"))) {
    $Entries = & tar.exe -tzf $Archive
    if ($LASTEXITCODE -ne 0) { throw "Could not inspect the release archive." }
    foreach ($Entry in $Entries) {
      $Normalized = $Entry.TrimEnd('/')
      $Parts = $Normalized -split '/'
      if ($Parts[0] -ne "package" -or $Parts -contains "." -or $Parts -contains ".." -or $Normalized.Contains('\')) {
        throw "Unsafe path in release archive: $Entry"
      }
    }
    New-Item -ItemType Directory -Force $Versions | Out-Null
    $Staging = Join-Path $Versions (".staging-$Version-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Force $Staging | Out-Null
    & tar.exe -xzf $Archive -C $Staging --strip-components=1
    if ($LASTEXITCODE -ne 0) { Remove-Item -Recurse -Force $Staging; throw "Could not extract the release archive." }
    $Manifest = Get-Content (Join-Path $Staging "release.json") -Raw | ConvertFrom-Json
    $CliPath = Join-Path $Staging "apps\$Role\dist\cli.js"
    if ($Manifest.role -ne $Role -or $Manifest.version -ne $Version -or -not (Test-Path $CliPath)) {
      Remove-Item -Recurse -Force $Staging
      throw "Release contents do not match."
    }
    Move-Item $Staging $Destination
  }
  $InstalledManifest = Get-Content (Join-Path $Destination "release.json") -Raw | ConvertFrom-Json
  $CliPath = Join-Path $Destination "apps\$Role\dist\cli.js"
  $ServicePath = Join-Path $Destination "apps\$Role\dist\index.js"
  if ($InstalledManifest.role -ne $Role -or $InstalledManifest.version -ne $Version -or -not (Test-Path $CliPath) -or -not (Test-Path $ServicePath)) {
    throw "Installed release contents do not match."
  }
  $ActivePath = Join-Path $ConfigRoot "installs\$Role\active.json"
  $PreviousVersion = $null
  if (Test-Path $ActivePath) {
    $PreviousVersion = (Get-Content $ActivePath -Raw | ConvertFrom-Json).version
  }
  New-Item -ItemType Directory -Force (Split-Path $ActivePath) | Out-Null
  $TemporaryActive = "$ActivePath.$([guid]::NewGuid())"
  $Active = @{ version = $Version }
  if ($PreviousVersion) { $Active.previousVersion = $PreviousVersion }
  $Active | ConvertTo-Json | Set-Content $TemporaryActive
  Move-Item -Force $TemporaryActive $ActivePath
  $CliPath = Join-Path $Destination "apps\$Role\dist\cli.js"
} finally {
  Remove-Item -Recurse -Force $Temporary -ErrorAction SilentlyContinue
}
& $Bun.Source $CliPath complete-install
if ($LASTEXITCODE -ne 0) { throw "TokTracker gateway installation failed." }
