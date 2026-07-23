# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# UCLI — 多 CLI 编排工作台

Windows 桌面 GUI，把多个 AI 编码 CLI（Claude Code、Codex）作为子进程统一编排。
卡片工作台布局，三档权限管控（一直同意 / 安全规则 / 逐次确认），token 与费用统计。

## 技术栈

- **主进程**：Electron + Node（`electron/`）。负责子进程生命周期、CLI 适配器、权限引擎、IPC。
- **渲染进程**：Vue 3 + Ant Design Vue + Pinia + Vue Router（`src/`）。
- **构建**：electron-vite（main/preload/renderer 三目标）+ electron-builder（NSIS）。

## 目录结构

```
electron/
  main.js              主进程入口（窗口、单例、IPC 装配）
  preload.js           contextBridge，暴露 window.ucli
  orchestrator.js      会话生命周期、IPC handler、配置持久化、统计
  adapters/
    cliAdapter.js      BaseAdapter + TIER 枚举 + 归一化事件契约
    claudeAdapter.js   claude --output-format stream-json --input-format stream-json --verbose
    codexAdapter.js    codex app-server --listen stdio://（JSON-RPC 2.0）
  permission/
    engine.js          三档决策 + ask-user 流程（onApprovalRequest/respondApproval）
    classifier.js      规则模式解析与匹配（Bash(prefix)/re/glob/host）
    blacklist.js       硬黑名单（不可绕过）
    hookServer.js      本地 HTTP 服务，接收 Claude PreToolUse hook 回调
resources/
  claudeHook.runner.mjs  随包分发的 hook 运行器（无依赖，被 `claude` 调用）
src/
  main.js / App.vue / router.js   渲染层入口与布局
  ipc.js                          window.ucli 的薄封装
  stores/{sessions,rules,stats,settings}.js   Pinia
  views/{Workbench,SessionDetail,Stats,Rules,Settings}.vue
  components/{SessionCard,ApprovalPanel}.vue
  components/activity/ActivityItem.vue   活动流渲染器
docs/protocol-reference.md   Claude / Codex 协议事实（验证自本机）
test/
  headless-claude.mjs              单轮 claude + PreToolUse hook 验证
  headless-claude-multiturn.mjs    单进程多轮验证
  headless-codex.mjs               codex JSON-RPC 审批验证
```

## 路由

Hash history，5 个页面：`/`（Workbench）`/session/:id`（SessionDetail）`/stats`（Stats）`/rules`（Rules）`/settings`（Settings）。

## 架构要点

- **统一适配器接口**：每个 CLI 实现一个 `BaseAdapter`，把原生消息归一成 `{type, ...}` 事件流。新增 CLI 只加一个适配器文件和对应的 `AdapterDescriptor`。事件类型：`init` `message` `reasoning` `tool_call` `tool_result` `command_output` `file_diff` `token_usage` `turn_complete` `error` `exit` `ready`。
- **IPC 桥**：`preload.js` 通过 `contextBridge` 暴露 `window.ucli`；`src/ipc.js` 做薄封装。所有 renderer→main 调用走 `ipcRenderer.invoke`；main→renderer 推送走 `webContents.send` 事件流。
- **权限拦截**：
  - Claude：通过 `--settings <临时文件>` 注入 `PreToolUse` hook → hook 运行器 POST 到本地 hookServer → 引擎决策 → 返回 allow/deny。headless 下 `ask` 不可靠，故 hook 永远返回 allow/deny，"弹窗"语义在引擎内实现。
  - Codex：`approvalsReviewer:"user"` + `approvalPolicy:"untrusted"`，收到 `item/*/requestApproval` ServerRequest → 引擎决策 → 回 accept/decline。
  - 硬黑名单在所有档位都强制 deny。
- **三档**：`always-agree`（除黑名单全 allow）/ `safety-rules`（deny 拦、high-risk 问、其余 allow）/ `ask-everything`（除黑名单全问）。
- **Token**：Claude 取 `result.usage` + `total_cost_usd`；Codex 取 `thread/tokenUsage/updated` 的 `total`（累计）。
- **配置持久化**：`{userData}/ucli-config.json`，存 `rulesets` 和 `settings`。orchestrator 启动时加载，每次修改时全量写入。

## 规则模式语法

规则在 `classifier.js` 中解析，支持：

```
Bash(rm:*)                        前缀匹配（命令以 rm 开头）
Bash(git push --force:*)          前缀匹配（含参数）
Bash(re:git\s+push.*--force)      正则匹配命令全文
Edit(src/**)                       glob 匹配文件路径
Write(~/.ssh/**)                   glob（支持 ~ 展开）
Read(/etc/**)                     glob 匹配路径
WebFetch(github.com)              host 后缀匹配
re:<regex>                        裸正则（任意工具）
<glob>                            裸 glob（任意文件工具）
```

## 开发

```powershell
npm install
npm run dev            # electron-vite dev，热重载
npm run build          # 构建到 out/
npm run dist           # 构建并打包 Windows NSIS 安装包到 dist/
npm run smoke:claude   # 验证 claude 能否正常输出
npm run smoke:codex    # 验证 codex 能否正常输出
npm run schema:codex   # 生成 codex JSON-RPC schema 到 .codex-schema/
```

### 运行测试

```powershell
node test/headless-claude.mjs           # 单轮 + hook 链验证
node test/headless-claude-multiturn.mjs # 单进程多轮验证
node test/headless-codex.mjs            # codex JSON-RPC 审批验证
```

### 安装与打包注意事项

- **Electron 二进制**：`npm install` 后若 `node_modules/electron/dist/electron.exe` 不存在（postinstall 未下到），运行：
  `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js`
- **NSIS 安装包**：`npm run dist` 需要**管理员权限**——electron-builder 的 winCodeSign 缓存包含 macOS 符号链接，非管理员无法解压。普通权限可用 `npx electron-builder --win --dir` 产出 `dist/win-unpacked/` 直接运行。打包前设：
  `$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"`
- 打包后 hook 运行器位于 `resources/resources/claudeHook.runner.mjs`（`process.resourcesPath + '/resources/...'`），需系统 `node` 可执行。

## 验证（已通过）

- `test/headless-claude.mjs`：claude stream-json + PreToolUse hook → 引擎 → allow/deny → 工具执行 → result（含 usage/cost）。PASS
- `test/headless-claude-multiturn.mjs`：单进程多轮（`--print --input-format stream-json` 在 result 后保持存活，可发第二轮）。PASS
- `test/headless-codex.mjs`：codex app-server JSON-RPC（initialize/thread/turn/tokenUsage/turnCompleted）+ `item/fileChange/requestApproval` 审批 → accept。PASS
- `npm run build` 三目标均通过；`npm run dev` 启动无错；`npx electron-builder --win --dir` 产出可运行 `dist/win-unpacked/UCLI.exe`。

## 关键依赖

- `claude` 与 `codex` 需在 PATH 中可用（本机已装 claude 2.1.198 / codex 0.142.0）。
- 打包后 hook 运行器位于 `resources/claudeHook.runner.mjs`，需被系统 `node` 执行（Windows 自带或随 Node 安装）。

## 验证

详见 `docs/protocol-reference.md` 的协议事实与计划文件中的验证方案。

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues for this repository. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository using the root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
