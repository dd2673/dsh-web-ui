# DSH 0.1.2 Android transport acceptance

The remote-control Host supports both the existing ApiProxy generation and DSH 0.1.2-rc.1's public Typert Gateway. The Android paired wire protocol is unchanged. The compatibility adapter preserves session history cursors, compact chunk rows, queue/projection events, and request-bound approval results. MIT upstream transport code and its license are retained together.

Validation completed on 2026-09-09:

- Remote plugin: build and typecheck pass; 210 tests pass, including Unicode/long-value transport, failure propagation and cross-session approval rejection.
- Real isolated DSH 0.1.2 Host: pairing fence, session/workspace creation, selected-model reread, rename, history and live SSE pass against a loopback fixture model provider.
- Android emulator: real isolated relay QR pairing, reconnect, workspace/history, directory browsing, 320x800 layout, composer, model/context panels, approval/question UI, queue edit/reorder/remove/steer/cancel pass. The UX script now reidentifies a row after roster rerender instead of dereferencing a detached test marker.
- Canonical Android build: 0.1.16, versionCode 19; original package name and signing certificate preserved. Formal Debug APK replaces the E2E artifact after validation. Debug builds are for controlled local use, not public distribution.
- Whole-workspace typecheck and documentation checks pass. Broader workspace tests retain pre-existing SSH Unix path/permission and /usr/sbin/sshd failures on Windows. Script checks retain generated community-index/shared-source drift. Assertions were not weakened to hide these unrelated failures.

The main Host was upgraded to 0.1.2-rc.1 after confirming no sessions were running. Its authenticated landing-page health check passes; the new local launch capability must be used for access. Browser automation rejected the existing launch tab under its URL security policy, so desktop visual acceptance is not claimed. The original MuMu installation was upgraded in place, but its existing relay credential is expired and requires owner-approved re-pairing. No physical Android phone was attached.
