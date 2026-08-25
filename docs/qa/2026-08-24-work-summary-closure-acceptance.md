# 0.11.6 工作总结闭环验收记录

日期：2026-08-25
版本：`0.11.6`
状态：**PASS — 工作总结可靠生成与响应式布局验收范围已闭环。**

本记录不包含提示词、转录、Provider 输出、凭据或绝对工作区路径。

本次闭环范围为工作总结的可靠生成、桌面/窄态响应式布局，以及 Setup/Portable 的相关安装态操作。历史记录中未执行的 Codex、OpenCode、U-Code 受控流程不属于本次授权范围；其未执行状态不构成本次范围的阻断，也不表示这些流程已获验收。

## 自动化准备与 TDD 证据

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| DSH 输出隔离 RED | `node --test test/dsh-bridge-package.test.mjs` | exit 1；新测试在隔离输出根读取 tgz 时得到 `ENOENT`，证明脚本尚未读取 `UCLI_DSH_BRIDGE_OUTPUT_ROOT`。 |
| DSH 输出隔离 GREEN | `node --test test/dsh-bridge-package.test.mjs` | exit 0；6 pass、0 fail、0 skip。隔离根内生成 `ucli-dsh-bridge-0.11.0.tgz`，生产 artifact 未被测试删除或替换。 |
| symlink helper RED | `node --test test/fs-capabilities.test.mjs` | exit 1；`ERR_MODULE_NOT_FOUND`，缺少 helper。 |
| symlink helper GREEN | `node --test test/fs-capabilities.test.mjs` | exit 0；2 pass、0 fail、0 skip。创建成功后断言真实链接；`ENOENT` 不被转换为 skip。 |
| Skills 回归 | `node --test test/fs-capabilities.test.mjs test/skills-audit.test.mjs test/skills-service.test.mjs` | exit 0；69 pass、0 fail、0 skip。 |
| 版本契约 RED | `node --test test/app-version.test.mjs test/release-verification.test.mjs` | exit 1；25 pass、2 fail、0 skip。两个断言仍期望 `0.11.5`，实际 package version 为 `0.11.6`。 |
| 版本/打包/legacy GREEN | `node --test test/app-version.test.mjs test/release-verification.test.mjs test/dsh-bridge-package.test.mjs test/fs-capabilities.test.mjs test/legacy-worklogs-import.test.mjs` | exit 0；50 pass、0 fail、0 skip。 |

Windows 符号链接能力在上述实际测试中可用，未发生 capability skip。Node 记录了既有 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告；未记录 active-handle 或 timer warning。

## 自动化发布门禁

### Task 4 最终复核（2026-08-25）

| 命令 | exit | pass / fail / skip | 结果 |
| --- | ---: | --- | --- |
| Task 4 focused `node --test` | 0 | 173 / 0 / 0 | PASS。覆盖 canonicalizer、interactive artifact/job、task contracts、mounted/view、export。 |
| `npm test` | 0 | 1,649 / 0 / 11 | PASS；共 1,660 tests，11 个为明确平台 skip。 |
| `npm run build` | 0 | 不适用 | PASS；main、preload、renderer 三个目标完成。 |
| `npm run verify:release` | 0 | 不适用 | PASS；验证 v0.11.6 Windows Setup、Portable 和 packaged DSH bridge。 |
| `git diff --check` | 0 | 不适用 | PASS；无 whitespace error。 |

Node 仍记录既有 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告，未造成测试或构建失败。

### Task 7 集成复核（2026-08-25）

| 命令 | 起止（Asia/Shanghai） | exit | pass / fail / skip | 结果 |
| --- | --- | ---: | --- | --- |
| `node --test test/claude-gateway-capabilities.test.mjs test/claude-turn-delivery.test.mjs test/interactive-summary-contracts.test.mjs test/interactive-summary-session-runtime.test.mjs test/interactive-summary-job-service.test.mjs test/summary-task-contracts.test.mjs test/summary-db-migration.test.mjs test/usage-ledger-db.test.mjs test/summary-ipc.test.mjs test/summary-view.test.mjs test/summary-view-mounted.test.mjs` | `2026-08-25T14:22:01.4155065+08:00` — `2026-08-25T14:22:23.1677281+08:00` | 0 | 236 / 0 / 0 | PASS；仅有既有 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告。 |
| `npm test` | 2026-08-25（控制器独立完整复核；168,198.8903 ms） | 0 | 1,619 / 0 / 11 | PASS。此前本线程的执行封装在父 shell 返回前截断输出，未作为该结论的证据。 |
| `npm run build` | 2026-08-25（先前完整构建与随后获批重跑） | 0（获批环境） | 不适用 | PASS；main、preload、renderer 三个目标完成。普通 sandbox 的重跑在 DSH 临时 tgz 写入处报 `EPERM`；获批环境以相同命令通过，确认是环境写入限制。 |
| `npm run verify:release` | `2026-08-25T14:23:49.5336196+08:00` — `2026-08-25T14:23:50.5918359+08:00` | 0 | 不适用 | PASS；验证当前版本的 Setup、Portable 与 packaged DSH bridge。 |
| `git diff --check`; `git diff 5e35792 --check` | 2026-08-25 | 0 | 不适用 | PASS；无 whitespace error。 |

Task 7 只验证自动化契约和发布工件；它没有执行真实模型调用、真实 CLI 工作流或安装态工作流。

| 命令 | 日期 | exit | pass / fail / skip | 结果 |
| --- | --- | ---: | --- | --- |
| `node --test test/interactive-summary-contracts.test.mjs test/summary-db-migration.test.mjs test/interactive-summary-artifact.test.mjs test/interactive-summary-session-runtime.test.mjs test/interactive-summary-job-service.test.mjs test/legacy-worklogs-import.test.mjs test/summary-ipc.test.mjs test/summary-startup.test.mjs test/summary-scheduler.test.mjs test/summary-export.test.mjs test/summary-view-mounted.test.mjs test/summary-view.test.mjs` | 2026-08-25 | 0 | 246 / 0 / 0 | PASS；无 active-handle/timer warning。 |
| `npm test` | 2026-08-25 | 0 | 1589 / 0 / 11 | PASS；11 个明确平台 skip。 |
| `npm run build` | 2026-08-25 | 0 | 不适用 | PASS；main、preload、renderer 三个目标完成。普通 sandbox 的 DSH 临时写入 `EPERM` 仅为环境诊断；获批环境可完成正常预打包。 |
| `npm run dist:win` | 2026-08-25 | 0（获批环境） | 不适用 | PASS。普通 sandbox 首次因 DSH 临时 tgz 写入 `EPERM` 失败；获批/提升环境随后完成 Windows 打包。 |
| `npm run verify:release` | 2026-08-25 | 0 | 不适用 | PASS；验证 `UCLI-Setup-0.11.6-x64.exe`、`UCLI-Portable-0.11.6-x64.exe` 与 `resources/deepseek-harness/ucli-dsh-bridge-0.11.0.tgz`。 |
| `git diff --check` | 2026-08-25 | 0 | 不适用 | PASS；无 whitespace error。 |

Windows package artifacts:

- `UCLI-Setup-0.11.6-x64.exe` — 134,179,386 bytes
- `UCLI-Setup-0.11.6-x64.exe.blockmap` — 137,363 bytes
- `UCLI-Portable-0.11.6-x64.exe` — 133,925,168 bytes

`ucli-dsh-bridge-0.11.0.tgz` 是 quarantined legacy bridge 的包版本；应用和 Windows artifact 版本为 `0.11.6`。

## 真实 Claude 工作总结验收

此前两次 Claude 周总结在旧的 12 秒外层门禁下以 `SUMMARY_TURN_NOT_CONFIRMED` 结束；该历史失败已由延长确认窗口的修复及以下真实重跑取代。

| 项目 | 证据 | 结果 |
| --- | --- | --- |
| 真实 Claude 周总结 | reportId `e94c1405-b5dc-4ea9-92aa-45d83206743d` | PASS；报告为 `completed` 且为 `current`，关联 session 为 offline。 |
| canonical artifact 一致性 | DB Markdown 与 `output/report.md` 字节一致 | PASS；10,823 bytes，SHA-256 `bbc2a920a35b665950ebd496b483ed5a3bbdf3e93c76e3409f8701c0beaee3dc`，包含六个必需标题（摘要加五个二级章节）。 |

未在此记录提示词、转录、Provider 输出或本地路径。

## 响应式布局人工验收

| 视口与检查项 | 结果 |
| --- | --- |
| 桌面 1280px | PASS；outer / inner 分别为 1280 / 1264，grid 为 360px task rail + 657px detail。task rail 可独立滚动，detail 保持容器内。截图：`.superpowers/sdd/2026-08-25-work-summary-responsive-layout/desktop-1280-redacted.png`。 |
| 窄态 breakpoint | PASS；应用 outer 最小宽度为 960px，因此在 inner 944px（小于 960px breakpoint）验证。task rail 高度受限为 360px，detail 堆叠至下方。截图：`.superpowers/sdd/2026-08-25-work-summary-responsive-layout/narrow-944-redacted.png`。 |
| 宽 Markdown 表格 | PASS；detail 表格 client 宽 663px、scroll 宽 10,063px，`overflow: auto` 生效，页面无横向溢出。 |
| 管理操作 | PASS；More 菜单包含编辑、关联对话、删除；编辑与删除确认均可打开后取消，未修改数据。 |

## Windows 安装态验收

安装态 second-instance `ReferenceError` 已在提交 `d716bd1` 修复并重打包。

| 工件 / 操作 | 结果 |
| --- | --- |
| Setup | PASS；最终工件静默安装到既有安装路径后启动，首次启动 PID `24064` 正常；工作总结详情删除模态框可打开并取消；第二次启动 exit 0，原窗口保持。Markdown 和 HTML 导出均打开原生另存为对话框后取消。 |
| Portable | PASS；最终工件解包启动 PID `13068` 后正常加载工作总结；详情删除模态框可打开并触发取消，Markdown 和 HTML 导出按钮均可用。 |
| 操作安全性 | PASS；未编辑或删除报告；所有保存、删除与导出对话框均取消；最终已停止全部 UCLI 进程。 |

最终 Windows artifacts：

- `UCLI-Setup-0.11.6-x64.exe` — 134,185,643 bytes；2026-08-25 22:57:30；SHA-256 `5609D792A05D478506AE29F834B13510D10E93A9B247FECA0007B580A0FB2C16`
- `UCLI-Portable-0.11.6-x64.exe` — 133,931,364 bytes；2026-08-25 22:57:40；SHA-256 `CCD655B2230E733014527672F6AADE467BC860BA07FAAFBB82D0FE18BED4645B`

## Release decision

**PASS（限本次工作总结可靠生成与响应式布局范围）。** 自动化、真实 Claude canonical report、响应式桌面/窄态布局及 Setup/Portable 安装态验收均已记录为 PASS。历史文档中的四 CLI 全覆盖目标未在本次范围内执行，故不作为本次 release closure 的阻断项；任何未来扩展验收应单独记录其范围和结果。
