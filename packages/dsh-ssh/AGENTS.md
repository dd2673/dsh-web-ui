# dsh-wending-ssh-manager 开发合约

- 只使用 DeepSeek Harness 公开插件 SDK 与 Cordis patch，不修改 Harness 源码。
- 首次连接必须扫描并显式固定 SSH Host Key；密钥变化必须阻断连接。
- 密码和 passphrase 不得出现在日志、测试快照、Git 历史或浏览器 API 响应中；Windows 落盘使用 CurrentUser DPAPI。
- 多 profile 验收使用独立 `storeFile`，不读写默认 profile 的主机库。
- 远程命令开始后不得自动重放；连接建立阶段最多有界重试。
- 文件上传、PTY 帧和隧道均需资源上限与独立生命周期；一个隧道关闭不得中断其他隧道。
- 真实服务器验收默认只运行 `whoami` / `hostname` 等只读命令，不部署、不上传、不修改远程状态。
