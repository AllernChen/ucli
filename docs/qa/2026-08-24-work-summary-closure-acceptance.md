# 0.11.6 工作总结闭环验收记录

日期：2026-08-25
版本：`0.11.6`
状态：**BLOCKED — Task 7 automated verification passes. Controlled real-CLI and installed-app acceptance remains unexecuted.**

本记录不包含提示词、转录、Provider 输出、凭据或绝对工作区路径。

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

## CLI 可用性与人工验收

非凭据命令检查发现四个 PowerShell shim；Claude 为 `2.1.220`，OpenCode 为 `1.18.18`。Codex 与 U-Code 的 `--version` 未在最初的有界检查内返回。随后在 dev 应用中用 Claude system selection 连续执行两次周总结步骤 1；两次均未出现可确认的 `turn_started`，以安全码 `SUMMARY_TURN_NOT_CONFIRMED` 结束。诊断确认主状态机的 12 秒外层门禁短于 Claude 冷启动最多两轮、每轮 8 秒的 transcript 投递确认周期；修复后的自动化门禁现为 30 秒，但真实模型流程尚未重跑。

| CLI | CLI version | profile / model | reportId / sessionId | start / end | 受控人工验收 |
| --- | --- | --- | --- | --- | --- |
| Claude | `2.1.220` | system selection / model not persisted before confirmation | v1 `38d1c0b7-5ce1-42dd-a32e-431f7d1d3426` / `61bac628-68dc-4b95-9e15-c7a8acc71ec7`; v2 `1715f699-ea9a-4da5-83b7-82aeb5acf0d3` / `a5568d4e-774e-4b81-8a7e-1eb6181cf989` | v1 `2026-08-25T01:13:25.038Z` / `2026-08-25T01:14:24.064Z`; v2 `2026-08-25T01:14:41.599Z` / `2026-08-25T01:15:06.497Z` | **FAIL** — both weekly attempts ended `SUMMARY_TURN_NOT_CONFIRMED`; no Markdown was produced. Timeout remediation is automated but not yet verified with a real rerun. Remaining concurrency, interruption/restart, export, and scheduler steps were not executed. |
| Codex | PENDING — `--version` did not return in bounded read-only check | PENDING — not executed: no controlled application profile/model session | PENDING — not executed | PENDING — not executed | PENDING — not executed: no manual CLI workflow observed. |
| OpenCode | `1.18.18` | PENDING — not executed: no controlled application profile/model session | PENDING — not executed | PENDING — not executed | PENDING — not executed: no manual CLI workflow observed. |
| U-Code | PENDING — `--version` did not return in bounded read-only check | PENDING — not executed: no controlled application profile/model session | PENDING — not executed | PENDING — not executed | PENDING — not executed: no manual CLI workflow observed. |

## Windows 安装态验收

PENDING — not executed. A verified installer exists, but it was not installed or exercised. Claude/Codex generation, existing-target export, restart recovery, old-DB migration, and one-time legacy import while preserving original `workLogs` remain unobserved.

## Release decision

The final release commit is forbidden until all four controlled CLI workflows and the installed Windows workflow are observed and recorded as PASS.
