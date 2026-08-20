param(
  [ValidateSet('Debug', 'E2E', 'Release')]
  [string]$Variant = 'Debug',
  [string]$AndroidSdk = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { 'D:\Android\Sdk' }),
  [string]$JavaHome = $(if ($env:JAVA_HOME) { $env:JAVA_HOME } else { Split-Path -Parent (Split-Path -Parent (Get-Command javac).Source) }),
  [string]$AppLinkHost = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$packageRoot = Join-Path $repoRoot 'packages\dsh-android'
$profilePath = Join-Path $repoRoot 'android-build-profile.json'
$profile = Get-Content -LiteralPath $profilePath -Raw | ConvertFrom-Json
$debugManifest = Get-Content -LiteralPath (Join-Path $packageRoot 'app\src\main\AndroidManifest.xml') -Raw
$releaseManifest = Get-Content -LiteralPath (Join-Path $packageRoot 'app\src\main\AndroidManifest.release.xml') -Raw
$activity = Get-Content -LiteralPath (Join-Path $packageRoot 'app\src\main\java\org\dshcommunity\remote\MainActivity.java') -Raw

function Assert-Identity([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw "Android build identity mismatch: $Message" }
}

function Get-NormalizedTextSha256([string]$Path) {
  $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n").Replace("`r", "`n")
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    return -join ($sha256.ComputeHash($bytes) | ForEach-Object { $_.ToString('X2') })
  } finally {
    $sha256.Dispose()
  }
}

function Remove-CanonicalPath([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($attempt -eq 5) {
        throw "Unable to overwrite canonical Android output '$Path': $($_.Exception.Message)"
      }
      Start-Sleep -Milliseconds (200 * $attempt)
    }
  }
}

function Clear-CanonicalDirectory([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory)) {
    $null = New-Item -ItemType Directory -Path $Directory -Force
    return
  }
  foreach ($entry in @(Get-ChildItem -LiteralPath $Directory -Force)) {
    Remove-CanonicalPath $entry.FullName
  }
}

Assert-Identity ($profile.schemaVersion -eq 1) 'unsupported profile schema'
Assert-Identity ($debugManifest -match ('package="' + [regex]::Escape($profile.packageName) + '"')) 'debug package name changed'
Assert-Identity ($releaseManifest -match ('package="' + [regex]::Escape($profile.packageName) + '"')) 'release package name changed'
Assert-Identity ($debugManifest -match ('android:label="' + [regex]::Escape($profile.applicationLabel) + '"')) 'debug app label changed'
Assert-Identity ($releaseManifest -match ('android:label="' + [regex]::Escape($profile.applicationLabel) + '"')) 'release app label changed'
Assert-Identity ($activity -match ('package ' + [regex]::Escape($profile.mainActivityPackage) + ';')) 'MainActivity package changed'
foreach ($resource in $profile.brandResources) {
  $resourcePath = Join-Path $repoRoot ($resource.path -replace '/', '\')
  Assert-Identity (Test-Path -LiteralPath $resourcePath) "brand resource is missing: $($resource.path)"
  # Git may materialize these text assets with CRLF or LF. Brand identity is
  # the normalized UTF-8 content, not the checkout's line-ending policy.
  Assert-Identity ((Get-NormalizedTextSha256 $resourcePath) -eq $resource.sha256) "brand resource changed: $($resource.path)"
}

$artifactName = [string]$profile.artifacts.$Variant
Assert-Identity ($artifactName -match '^[a-z0-9][a-z0-9.-]+\.apk$') 'invalid artifact filename'
$distRoot = [IO.Path]::GetFullPath((Join-Path $packageRoot 'dist'))
$packageBoundary = [IO.Path]::GetFullPath($packageRoot).TrimEnd('\') + '\'
Assert-Identity ($distRoot.StartsWith($packageBoundary, [StringComparison]::OrdinalIgnoreCase)) 'artifact cleanup escaped the Android package'
Clear-CanonicalDirectory $distRoot
$buildType = if ($Variant -eq 'Release') { 'Release' } else { 'Debug' }
$engineArgs = @{
  AndroidSdk = $AndroidSdk
  JavaHome = $JavaHome
  BuildType = $buildType
  VersionName = [string]$profile.versionName
  VersionCode = [int]$profile.versionCode
  ArtifactFileName = $artifactName
}
if ($Variant -eq 'E2E') { $engineArgs.EnableWebViewDebugging = $true }
if ($Variant -eq 'Release') { $engineArgs.AppLinkHost = $AppLinkHost }

$previousGuard = $env:DSH_ANDROID_CANONICAL_BUILD
$env:DSH_ANDROID_CANONICAL_BUILD = 'build-android.ps1'
try {
  $buildOutput = & (Join-Path $packageRoot 'build.ps1') @engineArgs
  if ($LASTEXITCODE -ne 0) { throw 'Android build engine failed' }
} finally {
  $env:DSH_ANDROID_CANONICAL_BUILD = $previousGuard
}

$artifact = [string]($buildOutput | Select-Object -Last 1)
Assert-Identity ((Split-Path -Leaf $artifact) -eq $artifactName) 'build engine returned an unexpected artifact'
Assert-Identity (Test-Path -LiteralPath $artifact) 'signed APK is missing'

$tools = Join-Path $AndroidSdk 'build-tools\35.0.0'
$badging = (& (Join-Path $tools 'aapt2.exe') dump badging $artifact) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect built APK identity' }
Assert-Identity ($badging -match ("package: name='" + [regex]::Escape($profile.packageName) + "'")) 'built APK package name is wrong'
Assert-Identity ($badging -match ("versionCode='" + [regex]::Escape([string]$profile.versionCode) + "'")) 'built APK versionCode is wrong'
Assert-Identity ($badging -match ("versionName='" + [regex]::Escape([string]$profile.versionName) + "'")) 'built APK versionName is wrong'
Assert-Identity ($badging -match ("application-label:'" + [regex]::Escape($profile.applicationLabel) + "'")) 'built APK label is wrong'

$certOutput = (& (Join-Path $tools 'apksigner.bat') verify --print-certs $artifact) -join "`n"
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect built APK certificate' }
$certMatch = [regex]::Match($certOutput, 'certificate SHA-256 digest:\s*([0-9a-fA-F]+)')
Assert-Identity $certMatch.Success 'built APK certificate digest is missing'
$actualCert = $certMatch.Groups[1].Value.ToUpperInvariant()
$expectedCert = if ($Variant -eq 'Release') { $env:DSH_ANDROID_RELEASE_CERT_SHA256 } else { [string]$profile.debugCertificateSha256 }
if ($Variant -eq 'Release' -and [string]::IsNullOrWhiteSpace($expectedCert)) {
  throw 'Release builds require DSH_ANDROID_RELEASE_CERT_SHA256 to pin the release signing identity'
}
$expectedCert = $expectedCert.Replace(':', '').ToUpperInvariant()
Assert-Identity ($actualCert -eq $expectedCert) 'built APK signing certificate changed'

$apkSha256 = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash
$distEntries = @(Get-ChildItem -LiteralPath $distRoot -Force)
Assert-Identity ($distEntries.Count -eq 1 -and $distEntries[0].Name -eq $artifactName) 'canonical dist must contain exactly one APK'
$intermediateRoot = [IO.Path]::GetFullPath((Join-Path $packageRoot 'build'))
Assert-Identity ($intermediateRoot.StartsWith($packageBoundary, [StringComparison]::OrdinalIgnoreCase)) 'intermediate cleanup escaped the Android package'
Remove-CanonicalPath $intermediateRoot
Write-Output "APK: $artifact"
Write-Output "Package: $($profile.packageName)"
Write-Output "Label: $($profile.applicationLabel)"
Write-Output "Version: $($profile.versionName) ($($profile.versionCode))"
Write-Output "Certificate SHA256: $actualCert"
Write-Output "APK SHA256: $apkSha256"
