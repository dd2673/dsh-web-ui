# DSH Remote Companion for Android

English | [中文](README.zh.md)

DSH Remote Companion is a community-maintained third-party Android companion for DeepSeek Harness. It is not an official DeepSeek App or hosted DeepSeek service.

## What it does

- Opens remote DeepSeek Harness sessions in a local Android WebView shell.
- Keeps the queue compact: each visible item is one short line with icon actions, while the expanded queue is scrollable and reveals the full list.
- Keeps the composer to one line when empty and grows with input up to five lines, preserving conversation context space.
- Creates a session from a workspace or a bounded host directory picker, and remembers workspace collapse and pin state on the paired device.

## Install

Build and install a Debug APK only for local development or controlled emulator validation.

```powershell
.\build.ps1
```

Do not publicly distribute a Debug APK.

## Config

Pair from the desktop plugin by scanning its QR code. The Android settings screen has no manual credential form.

```text
dshremote://pair?relay=https%3A%2F%2Frelay.example.com&host=<host>&token=<single-use-token>
```

The custom scheme is Debug-only. A Release build accepts only a same-domain HTTPS Android App Link.

## Security model

The WebView UI and the pinned `jsQR` decoder are bundled in the APK and do not load a remote page. A one-time pairing token expires before exchange, and the exchanged device token is encrypted with an Android Keystore AES-GCM key. QR images and pairing tokens are not sent to a third-party recognition service.

## Build and test

Run the local Android unit tests before using emulator flows.

```powershell
pnpm --filter @linxin666/dsh-android test
pnpm --filter @linxin666/dsh-android e2e:emulator -- http://127.0.0.1:9223
```

The emulator flow is a local validation aid and does not establish Release APK acceptance.

## Pairing contract

Debug and loopback E2E may use `dshremote://pair`. A Release APK requires `https://<app-link-host>/dsh-remote/pair?...`, an App Link host matching the relay domain, and a valid `/.well-known/assetlinks.json` for the release signing certificate.

## Public demo media

The following 360 x 640 captures use synthetic fixtures only and contain no real host path, credential, token, QR code, or conversation content.

![Status screen](../../docs/public-assets/android-status-demo-360x640.png)

![New session screen](../../docs/public-assets/android-new-session-demo-360x640.png)

![Compact composer and queue](../../docs/public-assets/android-composer-queue-demo-360x640.png)

## Release requirements

Create a Release APK only after providing a real App Link domain, a protected release keystore, and the matching `assetlinks.json` on that domain. Release credentials must be supplied through environment variables and must not appear in source, commands, screenshots, or public documentation.

```powershell
$env:DSH_ANDROID_RELEASE_KEYSTORE = 'D:\secure\dsh-remote-release.jks'
$env:DSH_ANDROID_RELEASE_KEY_ALIAS = 'dsh-remote-companion-v1'
$env:DSH_ANDROID_RELEASE_STORE_PASSWORD = '<store-password>'
$env:DSH_ANDROID_RELEASE_KEY_PASSWORD = '<key-password>'
.\build.ps1 -BuildType Release -VersionName 1.0.0 -VersionCode 1 -AppLinkHost relay.example.com
```

## Known limitations

- Git and SSH controls are not part of the initial public release.
- Lifecycle controls require an external compatible agent and are unavailable without one.
- The Android client displays host-provided context pressure and breakdown data; it does not estimate context usage locally.
