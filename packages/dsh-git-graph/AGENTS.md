# AGENTS.md — dsh-wending-git-workbench

dsh Web GUI 的外部 Git 工作台插件（更改、diff、暂存、提交、同步、分支与图谱）。DeepSeek Harness 源码零改动；本包通过官方 npm SDK 与 profile bundle 激活。

## 仓库规则

- **遵循 turtle-ui 规范**：独立 pnpm 包（`"type": "module"`，node `^22.19 || >=24`，packageManager pnpm），peer APIs 走 `@deepseek-ai/dsh-*` peerDependencies + `autoInstallPeers: false`，`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` 声明 bundle 激活。
- **tsconfig 分层**：`tsconfig.json` 是 solution（`files: []`），`tsconfig.host.json`（host half）与 `tsconfig.client.json`（browser half）各自成 program——host 侧 `sessions: SessionStore` merge 与浏览器侧 `sessions: ISessions` merge 不得同 program（主仓 one-program-per-side 规则）。`tsconfig.vitest.json` 为测试 program（排除 `src/index.ts`/`src/invariant.ts`，它们只由 host project 检查）。
- **浏览器 bundle 纪律**：`@deepseek-ai/*` 只能 type-only 导入（构建期纯度门）；值导入只允许平台种子表成员（react / cordis / ui-slots / web-react / ui-primitives / schema-form）。跨插件协作走 cordis 服务（`ctx.slots` / `ctx.sessions` / `ctx.workspaces`）。
- **build 预设统一复用**：浏览器构建只使用仓库根部 `shared/tsdown.client.ts`，不得复制官方源码构建文件。
- **git 能力不进模型可见面**：git switch/create 是 UI 触发的宿主操作，不写 session log、不产生模型输入。
- **文案中英双语**：词典在 `src/client/locales.ts`（`zh` 为 key 源，`en` 键集完整对照），错误文案对照 ZCode branchSwitcher 词汇。
- **新增源码文件必须可被 host/client program 覆盖**：host 侧进 `src/host/`，浏览器侧进 `src/client/`，纯逻辑进 `src/core/`（两侧共享，双 program 都会编译）。

## 提交前检查

```sh
pnpm run typecheck
pnpm test
pnpm run build
```
