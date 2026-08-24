# 0.11.6 工作总结闭环验收记录

日期：2026-08-25
版本：`0.11.6`
状态：**BLOCKED — automated preparation is recorded; package and manual acceptance are incomplete.**

本记录不包含提示词、转录、Provider 输出、凭据或绝对工作区路径。

## 自动化准备与 TDD 证据

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| DSH 输出隔离 RED | `node --test test/dsh-bridge-package.test.mjs` | exit 1；新测试在隔离输出根读取 tgz 时得到 `ENOENT`，证明脚本尚未读取 `UCLI_DSH_BRIDGE_OUTPUT_ROOT`。 |
| DSH 输出隔离 GREEN | `node --test test/dsh-bridge-package.test.mjs` | exit 0；6 pass、0 fail、0 skip。隔离根内生成 `ucli-dsh-bridge-0.11.0.tgz`，生产 artifact 未被测试删除或替换。 |
| symlink helper RED | `node --test test/fs-capabilities.test.mjs` | exit 1；`ERR_MODULE_NOT_FOUND`，缺少 helper。 |
| symlink helper GREEN | `node --test test/fs-capabilities.test.mjs` | exit 0；2 pass、0 fail、0 skip。创建成功后断言真实链接；`ENOENT` 不被转换为 skip。 |
| Skills 回归 | `node --test test/fs-capabilities.test.mjs test/skills-audit.test.mjs test/skills-service.test.mjs` | exit 0；69 pass、0 fail、0 skip。 |

Windows 符号链接能力在上述实际测试中可用，未发生 capability skip。Node 记录了既有 `MODULE_TYPELESS_PACKAGE_JSON` 性能警告；未记录 active-handle 或 timer warning。

## 自动化发布门禁

| 命令 | 日期 | exit | pass / fail / skip | 结果 |
| --- | --- | ---: | --- | --- |
| `node --test test/interactive-summary-contracts.test.mjs test/summary-db-migration.test.mjs test/interactive-summary-artifact.test.mjs test/interactive-summary-session-runtime.test.mjs test/interactive-summary-job-service.test.mjs test/legacy-worklogs-import.test.mjs test/summary-ipc.test.mjs test/summary-startup.test.mjs test/summary-scheduler.test.mjs test/summary-export.test.mjs test/summary-view-mounted.test.mjs test/summary-view.test.mjs` | 2026-08-25 | 0 | 246 / 0 / 0 | PASS；无 active-handle/timer warning。 |
| `npm test` | 2026-08-25 | 0 | 两个顺序批次均为 0 fail；pretest 为 112 / 0 / 0；完整汇总计数待保留的 runner 输出复核 | PASS；不以截断的控制台输出猜测总数。 |
| `npm run build` | 2026-08-25 | 0 | 不适用 | PASS；main、preload、renderer 三个目标均完成。 |
| `npm run dist:win` | 2026-08-25 | 1 | 不适用 | 首次普通 sandbox 运行在预打包 DSH bridge 创建临时 tgz 时得到 `EPERM`。提升 sandbox 后 bridge 和三项编译完成，但没有写出 `dist/` 安装包；因此没有可验证的 Windows artifact。 |
| `npm run verify:release` | 2026-08-25 | 1 | 不适用 | **预期失败**：`dist:win` 未产生发行物，验证器准确报告缺少 `UCLI-Portable-0.11.6-x64.exe`。 |
| `git diff --check` | 2026-08-25 | 0 | 不适用 | PASS；无 whitespace error。 |

构建时正常生成的 DSH bridge 包为 `ucli-dsh-bridge-0.11.0.tgz`（legacy bridge package version）；由于 Windows 打包未生成安装包，没有可验证的 `0.11.6` 安装包元数据或版本化产物。

## CLI 可用性与人工验收

只做了非凭据、非交互的命令可用性/版本检查。四个 PowerShell shim 均可发现；Claude 为 `2.1.220`，OpenCode 为 `1.18.18`。Codex 与 U-Code 的 `--version` 未在有界检查内返回，因此版本保持 PENDING。没有执行配置档案、模型调用、受控应用、安装态或人工生成流程。

| CLI | CLI version | profile / model | reportId / sessionId | start / end | 受控人工验收 |
| --- | --- | --- | --- | --- | --- |
| Claude | `2.1.220` | PENDING — not executed: no controlled application profile/model session | PENDING — not executed | PENDING — not executed | PENDING — not executed: weekly `turn_started`, v2 isolation, concurrent report, interruption/restart, existing-target export, and scheduler restart were not observed. |
| Codex | PENDING — `--version` did not return in bounded read-only check | PENDING — not executed: no controlled application profile/model session | PENDING — not executed | PENDING — not executed | PENDING — not executed: no manual CLI workflow observed. |
| OpenCode | `1.18.18` | PENDING — not executed: no controlled application profile/model session | PENDING — not executed | PENDING — not executed | PENDING — not executed: no manual CLI workflow observed. |
| U-Code | PENDING — `--version` did not return in bounded read-only check | PENDING — not executed: no controlled application profile/model session | PENDING — not executed | PENDING — not executed | PENDING — not executed: no manual CLI workflow observed. |

## Windows 安装态验收

PENDING — not executed. `dist:win` did not produce an installer. Consequently there is no installed `0.11.6` application to validate Claude/Codex generation, existing-target export, restart recovery, old-DB migration, or one-time legacy import while preserving original `workLogs`.

## Release decision

The final release commit is forbidden. Resolve the package-artifact failure, produce and verify the `0.11.6` Windows artifacts, then execute and record all four controlled CLI workflows and the installed Windows workflow before changing this status.
