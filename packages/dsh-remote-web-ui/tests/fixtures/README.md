# Live compatibility fixture

Use an isolated DSH_HOME with DSH 0.1.2-rc.1 and the built remote-web-ui/browser bridge packages. Never apply the fixture overlay to a user's active profile. The overlay uses loopback ports 3088 (Host), 3090 (model fixture) and 3091 (optional test relay).

Run `node tests/fixtures/compat-provider.mjs` from the remote-web-ui package. Supply `DSH_COMPAT_TEST_KEY=fixture-no-secret` to the isolated Host, and apply `compat-profile.patch.yml`. For the optional relay, use host id `compat-fixture` and `DSH_COMPAT_HOST_TOKEN` matching that relay's dedicated test host token. These values belong only to a disposable fixture.

Set `DSH_COMPAT_WORKSPACE` to an existing isolated test directory whose path contains `dsh-api-migration`, then run `node tests/host-compat.live.mjs`. The test refuses a non-loopback Host or a missing fixture provider, creates only fixture sessions, and checks the pairing fence, model selection, history fidelity and SSE.

For emulator tests, build through the repository-root `build-android.ps1 -Variant E2E`. Use a fresh test emulator and reverse port 3091 before pairing it to the isolated relay. The queue fixture keeps requests containing `1200` open for 30 seconds so editing/reordering/steering can be exercised against the real Host queue. Restore the canonical Debug APK after testing.
