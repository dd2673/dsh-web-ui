# Android 版 DSH Remote Companion

[English](README.md) | 中文

DSH Remote Companion 是 DeepSeek Harness 的社区维护第三方 Android 配套客户端，不是 DeepSeek 官方 App 或 DeepSeek 托管服务。

## 能力

- 在本地 Android WebView 壳中打开远程 DeepSeek Harness 会话。
- 保持队列紧凑：每条可见项目只占一行短文本和图标操作，展开的队列可滚动并显示完整列表。
- composer 空白时保持一行，随输入最多扩展到五行，以保留更多对话上下文空间。
- 从工作区或受限的主机目录选择器创建会话，并在已配对设备上记住工作区折叠和置顶状态。

## 安装

仅为本地开发或受控模拟器验证构建和安装 Debug APK。

```powershell
.\build.ps1
```

不得公开分发 Debug APK。

## 配置

通过扫描桌面插件的二维码进行配对。Android 设置页没有手工凭据输入表单。

```text
dshremote://pair?relay=https%3A%2F%2Frelay.example.com&host=<host>&token=<single-use-token>
```

自定义 scheme 仅用于 Debug。Release 构建只接受同域 HTTPS Android App Link。

## 安全模型

WebView UI 和固定版本的 `jsQR` 解码器均随 APK 打包，不加载远程页面。一次性配对 token 在兑换前会过期，兑换后的设备 token 使用 Android Keystore 的 AES-GCM 密钥加密。二维码图像和配对 token 不会发送给第三方识别服务。

## 构建与测试

使用模拟器流程前先运行本地 Android 单元测试。

```powershell
pnpm --filter @linxin666/dsh-android test
pnpm --filter @linxin666/dsh-android e2e:emulator -- http://127.0.0.1:9223
```

模拟器流程仅用于本地验证，不构成 Release APK 验收。

## 配对契约

Debug 和 loopback E2E 可以使用 `dshremote://pair`。Release APK 必须使用 `https://<app-link-host>/dsh-remote/pair?...`，App Link host 必须与 relay 域名相同，并且该域名必须为 release 签名证书提供有效的 `/.well-known/assetlinks.json`。

## 公开演示素材

以下 360 x 640 截图只使用合成 fixtures，不包含真实主机路径、凭据、token、二维码或对话内容。

![状态页](../../docs/public-assets/android-status-demo-360x640.png)

![新建会话页](../../docs/public-assets/android-new-session-demo-360x640.png)

![紧凑 composer 和队列](../../docs/public-assets/android-composer-queue-demo-360x640.png)

## 发布要求

只有提供真实 App Link 域名、受保护的 release keystore，以及该域名上匹配的 `assetlinks.json` 后，才能创建 Release APK。Release 凭据必须通过环境变量提供，不能出现在源码、命令、截图或公开文档中。

```powershell
$env:DSH_ANDROID_RELEASE_KEYSTORE = 'D:\secure\dsh-remote-release.jks'
$env:DSH_ANDROID_RELEASE_KEY_ALIAS = 'dsh-remote-companion-v1'
$env:DSH_ANDROID_RELEASE_STORE_PASSWORD = '<store-password>'
$env:DSH_ANDROID_RELEASE_KEY_PASSWORD = '<key-password>'
.\build.ps1 -BuildType Release -VersionName 1.0.0 -VersionCode 1 -AppLinkHost relay.example.com
```

## 已知限制

- Git 和 SSH 控制不属于首个公开版本。
- lifecycle 控制依赖外部兼容 agent；没有该 agent 时不可用。
- Android 客户端仅显示 Host 提供的上下文压力和明细数据，不在本地估算上下文占用。

代码维护和缺陷统一提交到[维护者自己的 Issue tracker](https://github.com/dd2673/dsh-web-ui/issues/1)。
