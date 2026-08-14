# dsh-web-ui — 仓库规则

## 本分支开发合约

- 本分支聚焦 `packages/dsh-git-graph` 与 `packages/dsh-ssh` 两个独立官方插件；不得把能力补丁写入 DeepSeek Harness 源码。
- 新插件需求先检索官方社区与 `dsh-plugin` 主题：优先直接采用，其次基于许可证允许的相似插件二次修改，最后才从零开发。
- Git 工作台只操作 DSH `workspaceRegistry` 已登记的工作区；所有 Git 参数使用 argv 数组，不拼 shell 字符串。`pull` 固定 `--ff-only`，破坏性操作必须显式确认。
- SSH 支持同一主机多账号（以 alias 区分）。真实密码、私钥、口令、服务器清单不得进入源码、fixture、日志或提交；Windows 持久密码使用 CurrentUser DPAPI，连接必须固定 Host Key。
- 已开始的远程命令禁止自动重放。隧道按实例隔离，停止一个隧道不得中断同一主机的其他连接。
- 开发与验证使用独立 DSH profile，不安装到默认 `web` profile；先通过安全审计、测试、构建，再做浏览器与真实服务器只读烟测。
- 每个文件修改任务完成后提交并推送当前分支；若没有可写远端，必须明确报告，不得伪造已推送状态。
- 适配 Harness 快速迭代时，只升级插件自己的 SDK 依赖和接缝；不直接修改 Harness checkout。

## 插件只能基于官方 NPM SDK 开发（禁止改 DSH 源码）

- 本仓库所有插件**禁止修改 DeepSeek Harness (DSH) 源码**（对官方源码 checkout 零写入），
  挂载只走 `cordis.patch.yml` + profile 机制。
- 开发**只能基于官方 NPM SDK**：`@deepseek-ai/*` 官方 NPM SDK 包（scope registry 为
  registry.npmjs.org，内测已结束），类型来源是各包 `devDependencies` 中的 SDK 包（node_modules 解析）。
- **禁止** tsconfig `extends` / `paths` / `references` 指向任何 DSH 源码 checkout
  （`test-zhu1090093659`、`~/.dsh/source/current` 等引用一律不得新增）。
- 构建预设统一用仓库内单一共享副本 `shared/tsdown.client.ts`，禁止在包内复制。
- 环境：若仍使用私有 scope 认证，需要 `NPM_TOKEN` 环境变量（真实令牌只放环境变量，勿提交）；
  当前 SDK 已结束内测，公开包通常可直接安装。
  认证配置：token 放**用户级 `~/.npmrc`**（`//registry.npmjs.org/:_authToken=${NPM_TOKEN}`，
  由 pnpm 展开环境变量）；**项目 `.npmrc` 只留 scope 映射**
  （`@deepseek-ai:registry=https://registry.npmjs.org/`）。注意：项目级 `.npmrc` 里的
  `${NPM_TOKEN}` 占位符在 pnpm 11 下不会被展开、被忽略，不承担认证职责，详见 `docs/plugins.md`。

## 新包命名统一 dsh- 前缀

**此后新建的插件包（`packages/` 下新目录）一律以 `dsh-` 开头**（如 `dsh-aionui-panel`、
`dsh-task-board`）。既有包已全部更名对齐，新包直接沿用，不允许再出现不带 `dsh-` 前缀的
包目录。npm 包名沿用 `@deepseek-ai/dsh-*`（UI 类插件按惯例用 `@deepseek-ai/dsh-client-ui-*`）。

## 禁止使用 emoji

本仓库**禁止出现任何 emoji 字符**（含 Emoji_Presentation、变化选择符 U+FE0F、ZWJ 序列、
区域指示符、Dingbats/杂项符号等 Unicode Emoji 属性字符），覆盖所有文件类型：
代码、注释、README / 文档、UI 文案、脚本输出、提交信息均不得使用 emoji。

- 需要装饰性符号时，改用非 emoji 的普通字符（如 `×`、`-`、`*`），或直接去掉。
- 新提交前先检查：`git diff` 或全局搜索 Unicode Emoji 范围字符。

