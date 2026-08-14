# dsh-wending-git-workbench

外部 dsh Web GUI 插件：在官方输入选择器行提供分支入口，并打开 Codex 风格 Git 工作台。工作台覆盖更改列表、文本 diff、暂存/取消暂存、提交、`fetch`、`pull --ff-only`、`push`、分支切换与提交图谱。入口优先挂在 `conversation.input.selector.context`；若运行 shell 未声明该槽位，等待 `CONTEXT_FALLBACK_MS` 后回退到 `conversation.input.dock`。所有 Git 操作仅能作用于 DSH 已注册工作区，参数通过 argv 数组执行，不修改 Harness 源码。

行为对齐 ZCode 的 `GitBranchSwitcher`：可搜索弹层、当前项打勾、「创建并检出新分支… / Git 图谱」底部操作、切换守卫（未解决冲突 / 进行中操作 / 目标分支被其他 worktree 检出）与可读报错。

## 仓库布局与构建

本插件仅依赖 npm 发布的 `@deepseek-ai/*` 官方 SDK，不要求 DeepSeek Harness 源码 checkout，也不会向官方仓库写入任何产物。类型门是 `pnpm run typecheck`。

```sh
pnpm install
pnpm run typecheck   # tsc -b（含 sibling 引用项目）
pnpm test            # vitest（core 纯函数 / 真实 git 服务 / jsdom 组件）
pnpm run build       # tsc -b && tsdown（lib/index.js + lib/invariant.js + lib/client.js）
```

`lib/client.js` 是浏览器 bundle，由 host 的 client-modules 伺服；浏览器构建统一复用仓库根部 `shared/tsdown.client.ts`。

独立包的 Git 安装可走 `prepare` 脚本：`tsdown --config tsdown.prepare.config.ts` 从 src 直接 transpile，不做类型检查（`tsconfig.prepare.json` 自包含）。本 monorepo 子包安装使用下文的 `link:` 机制。

## 激活

本包是 dsh profile bundle（`package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`）。激活后重启对应 profile，bundle patch 会装入 host Git 服务、`/git/*` 路由和浏览器入口；进入已有会话后，可在输入框工具栏看到分支按钮。

### 当前分支安装

当前硬化版尚未发布到 npm，使用官方 `link:` 插件机制安装：

```sh
git clone https://github.com/dd2673/dsh-web-ui.git
cd dsh-web-ui
pnpm install && pnpm -r build
dsh plugin --profile <独立测试 profile> add link:$(pwd)/packages/dsh-git-graph
```

> `github:` 安装方式适用于包位于仓库根部的独立仓库（`prepare` 脚本自包含构建；pnpm ≥10 首次会被拒绝，需按报错提示把包 key 加进 profile 的 `pnpm-workspace.yaml` `allowBuilds` 后重试）。monorepo 内的子包请用上面的 `link:` 方式。

### 本地开发循环（本仓库 checkout）

```sh
dsh plugin --profile <name> add link:/absolute/path/to/dsh-git-graph
```

`link:` 安装直接引用本地目录，重建后立即生效、无需重装（改完 `pnpm run build` 后刷新页面即可）。注意 `link:` 后跟的是绝对路径（`~` 由 shell 展开，不是 pnpm 语义）。

## 卸载

```sh
dsh plugin --profile <profile> remove dsh-wending-git-workbench
```

## 设计要点

- 边界与加载链调研、关键决策见 [docs/ADR-001-plugin-boundary.md](docs/ADR-001-plugin-boundary.md)。
- host half 的 `/git/*` 只接受已注册 workspace 的路径（realpath 校验），浏览器无法对任意目录执行 git。
- 切换语义是工作区级：`git switch --no-guess <branch>` 作用于 repoRoot 磁盘树，影响该工作区所有会话；项目切换 = 激活目标工作区并打开其（复用或新建的）空白会话，不给既有会话换 cwd。
- 挂载 seam：`conversation.input.selector.context`（官方声明的 session-maybe list 槽位）——输入选择器行的 context 洞，与官方工作区胶囊并排；hero（空白会话）与 active 会话相位都有分支胶囊；无会话 cwd 或非 git 工作区时分支 chip 自行隐藏。声明感知 + 回退：等待该槽位声明 `CONTEXT_FALLBACK_MS`（npm SDK rc.6 的 shell 已删除此声明），超时未声明则改挂 `conversation.input.dock`（session 相位才挂载，hero 无座位——rc.6 上接受的降级）；只挂一个座位，回退后迟到的 context 声明被忽略。
- 工作区选择不在此插件内：官方工作区胶囊（`conversation.input.selector.workspace`）是唯一入口，本插件只提供 git 分支上下文。
- 分支状态刷新：挂载/弹层打开/切换成功后拉取 + host SSE（`/git/events`，订阅期间每 2s 轮询 workspace 状态）推送外部变更 + window focus 刷新。

## 检查链

```sh
pnpm run typecheck
pnpm test
pnpm run build
```
