param(
  [string]$AndroidSdk = $(if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { 'D:\Android\Sdk' }),
  [string]$JavaHome = $(if ($env:JAVA_HOME) { $env:JAVA_HOME } else { Split-Path -Parent (Split-Path -Parent (Get-Command javac).Source) }),
  [ValidateSet('Debug', 'Release')]
  [string]$BuildType = 'Debug',
  [string]$VersionName = '0.1.0',
  [ValidateRange(1, 2147483647)]
  [int]$VersionCode = 1,
  [string]$AppLinkHost = '',
  [string]$ReleaseKeystore = $env:DSH_ANDROID_RELEASE_KEYSTORE,
  [string]$ReleaseKeyAlias = $env:DSH_ANDROID_RELEASE_KEY_ALIAS,
  [switch]$EnableWebViewDebugging
)

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourceRoot = Join-Path $packageRoot 'app\src\main'
$buildRoot = Join-Path $packageRoot 'build'
$jsQrRoot = Join-Path $packageRoot 'node_modules\jsqr'
$jsQrBundle = Join-Path $jsQrRoot 'dist\jsQR.js'
$jsQrLicense = Join-Path $jsQrRoot 'LICENSE'
$jsQrSha256 = 'BC40C8A15196236B2314DB0856F72CA0B49980CD5413B8C852A7349F5FEE0859'
$tools = Join-Path $AndroidSdk 'build-tools\35.0.0'
$androidJar = Join-Path $AndroidSdk 'platforms\android-35\android.jar'
$aapt2 = Join-Path $tools 'aapt2.exe'
$d8 = Join-Path $tools 'd8.bat'
$zipalign = Join-Path $tools 'zipalign.exe'
$apksigner = Join-Path $tools 'apksigner.bat'
$javac = Join-Path $JavaHome 'bin\javac.exe'
$jar = Join-Path $JavaHome 'bin\jar.exe'
$keytool = Join-Path $JavaHome 'bin\keytool.exe'

foreach ($required in @($androidJar, $aapt2, $d8, $zipalign, $apksigner, $javac, $jar, $keytool)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Required Android build tool not found: $required" }
}
foreach ($required in @($jsQrBundle, $jsQrLicense)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Run pnpm install before building; required bundled dependency is missing: $required" }
}
$actualJsQrSha256 = (Get-FileHash -LiteralPath $jsQrBundle -Algorithm SHA256).Hash
if ($actualJsQrSha256 -ne $jsQrSha256) {
  throw "jsQR integrity check failed: expected $jsQrSha256, got $actualJsQrSha256"
}
if ($BuildType -eq 'Release') {
  if ($EnableWebViewDebugging) { throw 'Release builds cannot enable WebView debugging' }
  if ($AppLinkHost -notmatch '^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$' -or -not $AppLinkHost.Contains('.')) {
    throw 'Release builds require -AppLinkHost with a valid DNS hostname'
  }
  if ([string]::IsNullOrWhiteSpace($ReleaseKeystore) -or -not (Test-Path -LiteralPath $ReleaseKeystore)) {
    throw 'Release builds require DSH_ANDROID_RELEASE_KEYSTORE or -ReleaseKeystore'
  }
  if ([string]::IsNullOrWhiteSpace($ReleaseKeyAlias) -or [string]::IsNullOrWhiteSpace($env:DSH_ANDROID_RELEASE_STORE_PASSWORD) -or [string]::IsNullOrWhiteSpace($env:DSH_ANDROID_RELEASE_KEY_PASSWORD)) {
    throw 'Release builds require DSH_ANDROID_RELEASE_KEY_ALIAS, DSH_ANDROID_RELEASE_STORE_PASSWORD, and DSH_ANDROID_RELEASE_KEY_PASSWORD'
  }
}

if (Test-Path -LiteralPath $buildRoot) { Remove-Item -LiteralPath $buildRoot -Recurse -Force }
$resOut = New-Item -ItemType Directory -Path (Join-Path $buildRoot 'res') -Force
$genOut = New-Item -ItemType Directory -Path (Join-Path $buildRoot 'gen') -Force
$classOut = New-Item -ItemType Directory -Path (Join-Path $buildRoot 'classes') -Force
$dexOut = New-Item -ItemType Directory -Path (Join-Path $buildRoot 'dex') -Force
$apkOut = New-Item -ItemType Directory -Path (Join-Path $buildRoot 'apk') -Force
$assetsOut = New-Item -ItemType Directory -Path (Join-Path $buildRoot 'assets') -Force

Copy-Item -Path (Join-Path $sourceRoot 'assets\*') -Destination $assetsOut -Recurse -Force
# aapt2's direct -A input only packages files at this level in this minimal
# build, so keep the audited decoder and its notice as flat APK assets.
Copy-Item -LiteralPath $jsQrBundle -Destination (Join-Path $assetsOut 'jsQR.js')
Copy-Item -LiteralPath $jsQrLicense -Destination (Join-Path $assetsOut 'jsqr.LICENSE.txt')

$manifest = Join-Path $sourceRoot 'AndroidManifest.xml'
if ($BuildType -eq 'Release') {
  $manifest = Join-Path $buildRoot 'AndroidManifest.xml'
  $template = Get-Content -LiteralPath (Join-Path $sourceRoot 'AndroidManifest.release.xml') -Raw
  [IO.File]::WriteAllText($manifest, $template.Replace('__APP_LINK_HOST__', $AppLinkHost.ToLowerInvariant()), [Text.UTF8Encoding]::new($false))
}

& $aapt2 compile --dir (Join-Path $sourceRoot 'res') -o (Join-Path $resOut 'resources.zip')
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile failed' }

$unsigned = Join-Path $apkOut 'dsh-remote-unsigned.apk'
$linkArgs = @(
  'link', '-o', $unsigned, '-I', $androidJar,
  '--manifest', $manifest,
  '--java', $genOut,
  '-A', $assetsOut,
  '--min-sdk-version', '26',
  '--target-sdk-version', '35',
  '--version-code', $VersionCode,
  '--version-name', $VersionName
)
# Test builds may expose Chrome DevTools for deterministic emulator E2E. The
# default remains non-debuggable and is the only artifact suitable for release.
if ($EnableWebViewDebugging) { $linkArgs += '--debug-mode' }
$linkArgs += (Join-Path $resOut 'resources.zip')
& $aapt2 @linkArgs
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link failed' }

$javaSources = @(
  (Get-ChildItem -LiteralPath (Join-Path $sourceRoot 'java') -Recurse -Filter '*.java').FullName
  (Get-ChildItem -LiteralPath $genOut -Recurse -Filter '*.java').FullName
)
& $javac -encoding UTF-8 -source 8 -target 8 -classpath $androidJar -d $classOut $javaSources
if ($LASTEXITCODE -ne 0) { throw 'javac failed' }

$classFiles = (Get-ChildItem -LiteralPath $classOut -Recurse -Filter '*.class').FullName
& $d8 --lib $androidJar --min-api 26 --output $dexOut $classFiles
if ($LASTEXITCODE -ne 0) { throw 'd8 failed' }
& $jar uf $unsigned -C $dexOut 'classes.dex'
if ($LASTEXITCODE -ne 0) { throw 'adding classes.dex failed' }

$aligned = Join-Path $apkOut 'dsh-remote-aligned.apk'
& $zipalign -f 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign failed' }

$keystore = $ReleaseKeystore
$keyAlias = $ReleaseKeyAlias
$storePasswordSpec = 'env:DSH_ANDROID_RELEASE_STORE_PASSWORD'
$keyPasswordSpec = 'env:DSH_ANDROID_RELEASE_KEY_PASSWORD'
if ($BuildType -eq 'Debug') {
  $keystore = Join-Path $packageRoot '.debug\dsh-remote-debug.keystore'
  $keyAlias = 'dshremote'
  $storePasswordSpec = 'pass:android'
  $keyPasswordSpec = 'pass:android'
  if (-not (Test-Path -LiteralPath $keystore)) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $keystore) -Force | Out-Null
    & $keytool -genkeypair -keystore $keystore -storepass android -keypass android -alias $keyAlias -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=DSH Remote Debug,O=Development,C=XX'
    if ($LASTEXITCODE -ne 0) { throw 'debug keystore creation failed' }
  }
}

$suffix = if ($BuildType -eq 'Release') { $VersionName } else { 'debug' }
$final = Join-Path $apkOut "dsh-remote-$suffix.apk"
Copy-Item -LiteralPath $aligned -Destination $final
& $apksigner sign --ks $keystore --ks-pass $storePasswordSpec --key-pass $keyPasswordSpec --ks-key-alias $keyAlias $final
if ($LASTEXITCODE -ne 0) { throw 'APK signing failed' }
& $apksigner verify --verbose $final
if ($LASTEXITCODE -ne 0) { throw 'APK verification failed' }
Write-Output $final
