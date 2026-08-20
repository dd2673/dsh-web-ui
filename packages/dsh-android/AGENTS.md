# dsh-android 构建规则

本目录补充遵循根 [AGENTS.md](../../AGENTS.md) 与 [packages/AGENTS.md](../AGENTS.md)。

- 只允许从仓库根运行 `build-android.ps1`。禁止复制工程、临时改 Manifest 或直接
  调用包内 `build.ps1`。
- 包名、名称、品牌资源、版本、产物名和证书指纹以根目录
  `android-build-profile.json` 为唯一事实源；身份调整必须显式评审。
- debug keystore 丢失或证书不符时必须失败，禁止自动生成新签名身份。
- MuMu Relay 配对验收使用 `tests/emulator-relay-pairing.mjs`，且必须显式设置
  `DSH_CONFIRM_RELAY_ROTATION=1`。该验收会轮换单设备绑定 epoch、使旧设备凭据失效，
  只能在已确认允许重新配对时运行；完成后必须重新安装正式 Debug APK。
