# Windows 发布验收清单

本清单用于 UCLI Windows x64 发布前和 GitHub Release 发布后的人工验收。自动化 `npm run verify:release` 只验证构建产物和更新元数据的一致性；以下交互行为必须在实际 Windows 环境中验证。

## 0. 0.12.3 发布证据

| 项目 | 当前证据 / 状态 |
| --- | --- |
| 发布候选源码 | PASS：服务档案同步入口实现基线为 `26dc9f8`，npm 11.16 锁文件兼容与 `0.12.3` 发布准备基线为 `9d14d9b348a3fd7dd0301317ceb429f59e768a22`；`package.json`、lockfile、侧栏版本与安装产物版本均为 `0.12.3`。设备注册线缆继续使用 `clientVersion: 0.12.0` 协议合同，不将桌面补丁版本误作协议版本。 |
| 服务档案与 Skills 同步 | PASS：2026-09-03（Asia/Shanghai）在 UCLI DEV 验证配置档案页“同步服务档案”可独立刷新连接与模型目录，`qwen3.8-27b` 显示 `OpenAI Responses`、可用、上下文 32768；同步过程中按钮禁用并显示加载态，完成后无新增错误。Skills 页面保留独立“同步组织目录”，执行成功并更新最近同步时间；服务档案同步不隐式同步 Skills。 |
| 干净依赖与审计 | PASS：Node.js `24.9.0` 下使用 GitHub Actions 同代 npm `11.16.0` 从 lockfile 执行真实 `npm ci --registry=https://registry.npmjs.org`，安装 533 个包、审计 534 个包；`npm audit --registry=https://registry.npmjs.org` 为 0 vulnerabilities。锁文件显式保留 npm 11.16 所需的 `@electron/windows-sign@1.2.2`、`cross-dirname@0.1.0` 与 `fs-extra@11.4.0` optional peer 记录；受测精确 override 固定已知漏洞依赖到修复版本。 |
| 自动化与构建门 | PASS：上述干净依赖树上 `npm test` 共 2092 项，2080 通过、0 失败、12 个平台条件跳过；`npm run build`、`npm run dist:win`、`npm run verify:release -- --platform win32 --arch x64` 和 `git diff --check` 均通过。现存 `MODULE_TYPELESS_PACKAGE_JSON`、废弃传递包及 `asar: false` 输出为既有非阻断提示。 |
| Windows 本地产物 | PASS：同一次 Windows x64 构建生成 Setup `UCLI-Setup-0.12.3-x64.exe`（134,254,203 bytes，SHA-256 `4425F8AC8DBD02434AC6FEB5806341FBB3DBAC2EE3633FC658B2082F4313E004`）；blockmap（137,381 bytes，SHA-256 `215DB9148D81ACA1B844269D3C3842E419BA8D68CE381BE7FFC9117B5A84A269`）；Portable `UCLI-Portable-0.12.3-x64.exe`（133,998,770 bytes，SHA-256 `55C95A27D67664F187B9AAB1F09B5E7D0144938A659C0927630EB4D48264ACB5`）；`latest.yml`（348 bytes，SHA-256 `C8469968B2C52CA79036F4AD2738386563DD7AE8E1732759427C0C5D068BB52C`）。证据文档不属于 `electron-builder.yml` 的打包输入。 |
| GitHub 发布 | PENDING：候选证据提交完成后创建不可变标签 `v0.12.3` 并由 `.github/workflows/release.yml` 执行远端 Windows 门、资产上传和 GitHub Release；发布完成前不将本行标为 PASS。 |

## 0. 0.12.2 未发布候选证据

| 项目 | 当前证据 / 状态 |
| --- | --- |
| 发布候选源码 | PASS：服务档案同步入口实现基线为 `26dc9f8`，发布准备基线为 `a936de78e0039a82a3d7e3c0588c114220fae4d6`；`package.json`、lockfile、侧栏版本与安装产物版本均为 `0.12.2`。设备注册线缆继续使用 `clientVersion: 0.12.0` 协议合同，不将桌面补丁版本误作协议版本。 |
| 服务档案与 Skills 同步 | PASS：2026-09-03（Asia/Shanghai）在 UCLI DEV 验证配置档案页“同步服务档案”可独立刷新连接与模型目录，`qwen3.8-27b` 显示 `OpenAI Responses`、可用、上下文 32768；同步过程中按钮禁用并显示加载态，完成后无新增错误。Skills 页面保留独立“同步组织目录”，执行成功并更新最近同步时间；服务档案同步不隐式同步 Skills。 |
| 干净依赖与审计 | PASS：Node.js `24.9.0` / npm `11.6.0` 下从 lockfile 执行 `npm ci --registry=https://registry.npmjs.org`，安装 605 个包、审计 606 个包；`npm audit --registry=https://registry.npmjs.org` 为 0 vulnerabilities。构建链的 `@xmldom/xmldom`、`fast-uri` 与运行时传递依赖 `qs` 已由受测精确 override 固定到修复版本。 |
| 自动化与构建门 | PASS：干净依赖树上 `npm test` 共 2092 项，2080 通过、0 失败、12 个平台条件跳过；`npm run build`、`npm run dist:win`、`npm run verify:release -- --platform win32 --arch x64` 和 `git diff --check` 均通过。现存 `MODULE_TYPELESS_PACKAGE_JSON`、废弃传递包及 `asar: false` 输出为既有非阻断提示。 |
| Windows 本地产物 | PASS：同一次 Windows x64 构建生成 Setup `UCLI-Setup-0.12.2-x64.exe`（134,254,336 bytes，SHA-256 `60293FD360181D58AD5265A14239AF98358D4B1D7A7301DF89FBCA78193686D7`）；blockmap（137,298 bytes，SHA-256 `6750CFD47519BEB199420B1CC9DD457F2AB630DDD9DADE95CB27468202C40E0D`）；Portable `UCLI-Portable-0.12.2-x64.exe`（133,998,847 bytes，SHA-256 `99134A76ED48B6D12E25915154871BB6260ABAE30D89E86FA684A734387F8F2B`）；`latest.yml`（348 bytes，SHA-256 `B5DDA60C74ADC23206E1E554C988CDFDBDD58D603D6B27BE44193FADE1C27672`）。证据文档不属于 `electron-builder.yml` 的打包输入。 |
| GitHub 发布 | FAIL / 未发布：不可变标签 `v0.12.2` 指向 `7fafa1cf29c2efa552b29a4f8ce0aff71dea9da4`；GitHub Actions run `33712452896` 的 Windows 与 macOS job 均在 `npm ci` 前置门失败，因为本地 npm 11.6 生成的锁文件缺少 npm 11.16 仍要求的 `@electron/windows-sign@1.2.2`、`cross-dirname@0.1.0` 和 `fs-extra@11.4.0` optional peer 记录。CI 未执行测试、构建、产物上传或发布，GitHub Release 与远端发布资产均不存在；该标签不移动，由修复后的 `0.12.3` 取代。 |

## 0. 0.12.1 发布证据

| 项目 | 当前证据 / 状态 |
| --- | --- |
| 发布候选源码 | PASS：应用、协议能力和 Skills 管理实现基线为 `d0f64c682af621a061b255f256f47d2840171d31`；`package.json`、lockfile、侧栏版本与安装产物版本均为 `0.12.1`。设备注册线缆继续使用已部署的 `clientVersion: 0.12.0` 协议合同，不将桌面补丁版本误作协议版本。 |
| 干净依赖与审计 | PASS：2026-09-01（Asia/Shanghai）执行 `npm ci --registry=https://registry.npmjs.org`，安装 608 个包；`npm audit --registry=https://registry.npmjs.org` 为 0 vulnerabilities。构建依赖链中的 `glob@10.4.5` 已由受测 override 固定到 `10.5.0`。 |
| 自动化与构建门 | PASS：干净依赖树上 `npm test` 共 2090 项，2078 通过、0 失败、12 个平台条件跳过；`npm run build`、`npm run dist:win`、`npm run verify:release` 和 `git diff --check` 均通过。 |
| Windows 本地产物 | PASS：同一次 Windows x64 构建生成 Setup `UCLI-Setup-0.12.1-x64.exe`（134,253,682 bytes，SHA-256 `24842A2A62C670715E4ECA61FD067C90063FA0DE2B52D56C1205B3CA20D35846`）；blockmap（137,319 bytes，SHA-256 `6FB08D1EC5EF447BDE5718B464C269D93B198A5F9DFB8AD316C803EF8DE92570`）；Portable `UCLI-Portable-0.12.1-x64.exe`（133,998,192 bytes，SHA-256 `2B5131D4197CB1B1A282C10D34432A03D1ABDF107AE1329842CF3054E2C6027D`）；`latest.yml`（348 bytes，SHA-256 `D7807E7C72632BF21F643F4812FCC606A8AE6A1A8AF92397377E4C41E41033DF`）。证据文档不属于 `electron-builder.yml` 的打包输入。 |
| GitHub 发布 | WINDOWS PASS / macOS 未发布：不可变标签 `v0.12.1` 指向 `7a67323866f7479c1b912b0298d2e6ff13c72e9e`；GitHub Actions run `33529185806` 于 2026-09-02 00:06（Asia/Shanghai）成功完成 Windows 全量测试、构建、打包、产物校验和发布。正式 Release 为 `https://github.com/AllernChen/ucli/releases/tag/v0.12.1`：Setup 134,253,609 bytes，SHA-256 `F264951C61CC2A79FC1089D82A2FF653114954566694E3C8A1524C97EEA4B1C0`；Portable 133,998,192 bytes，SHA-256 `F1B5E72AC8E4A0C0128B0E63EF31CD1DCD34CECA4CB7C2CC47DC25BF8728C80A`；blockmap 137,337 bytes，SHA-256 `7ABFDA2A51549A20E20123AD8D69F5D1A501424347D2C5A4FD48A8803CCE4519`；`latest.yml` 348 bytes，SHA-256 `A50023923F80608A520F4C5693ED51D760E8C7A82ADDD8642382D71F934A6A03`；`SHA256SUMS.txt` 365 bytes，SHA-256 `1E44FB8376F15F43C81BEF51F8DECD4C257A72AECD7A5F1693EDF1E82DF762C8`。macOS 允许失败支线在全量测试中出现 24 个独立失败（集中于 Skills 删除/恢复的 POSIX 路径语义，另含 CLI inventory 与 Skills IPC），因此未生成 DMG/ZIP；本记录不将其标为通过。发布任务另报告 `download-artifact` 的无效 `if-no-files-found` 输入警告，但实际 Windows 五项资产均已逐项核对为 uploaded。 |

## 0. 0.12.0 服务端接入发布矩阵

本节记录 Task 11 的本地合同门与待完成的外部发布门。固定 fixtures、静态安装器检查和本机构建都不能替代原生平台、真实服务或旧二进制验证。

| 项目 | 当前证据 / 状态 |
| --- | --- |
| 正式服务端基线 | PASS：UCLI Server `0.3.1`，发布提交 `1cd51df59d06ae0e8ab9c60cb6fea9e0d9f6a0c5`，当前生产运行时镜像 `sha256:daedf2b364c94aa6a1b1cfc6ed6f91350f98ac248f0a79767e87271c25e28c9b`，2026-08-30 已验证部署。下方真实 smoke 行保留其实际运行时证据，不改写为后续发布镜像。 |
| 本地协议合同 | PASS：Tasks 1–5 后四文件客户端/服务端合同门 48/48 通过。该门只覆盖固定 fixtures 的协议/目录与稳定 503 合同：`openai_responses`、`openai_chat`、`anthropic_messages`、固定端点、Bootstrap/Gateway 双目录协议一致性、无 `models[0]` 推断，以及 `no-store`/request ID/retryable。Codex/Claude 投影、Chat-only 无托管档案、透明 503 代理、凭证/本地能力保留和非 live smoke 请求由下列更广的九套实现门单独验证。 |
| 本地实现门 | PASS：声明的九套实现测试覆盖模型投影、透明 503 代理、凭证和本地能力保留、协议专属 smoke 请求与默认跳过的真实 smoke；它不是四文件 48-test 合同门的一部分。 |
| 统一服务档案多模型客户端改造 | 本地验收覆盖每个规范化 server origin/organization 一项服务档案、嵌套声明模型/协议、Codex→`openai_responses` 与 Claude→`anthropic_messages` 的显式兼容性、`openai_chat` 保持可见但不可托管启动、精确 `(serviceProfileId, modelId)` 默认/会话绑定、无模型/供应商/目录顺序/协议推断、按模型隔离的 Codex artifact，以及 fail-closed 选择与迁移来源回填。该改造仅修改客户端；不需要服务端变更或新的服务授权。 |
| Task 9 本地接受门 | PASS：最终 HEAD 固定服务端合同门 58/58、计划聚焦实现门（含 `session-profile-binding`）159/159；再加入 projection lifecycle 与 renderer-safe model IPC 回归后，扩展聚焦门为 179/179。完整 `npm test` 共 1944 项：1932 通过、0 失败、12 跳过；文档/固定合同复合门 31/31、`git diff --check` 与 `npm run verify:release` 均以 exit 0 完成。 |
| 本次文档与本地验证边界 | 此次真实 smoke 之后的客户端域重构没有消耗另一份授权，也没有运行新的 live smoke。下方 2026-08-30T16:10:42+08:00 的记录及其现有证据保持为唯一的最终 live-smoke 记录。 |
| 本地回滚兼容性 | 已做静态命名空间证明：当前版本的 `ucli-server-*` 文件不属于旧 `ucli-<32hex>` 所有权规则；这不是 0.11.6 二进制降级实证。 |
| 合并提交 Windows 产物 | PASS：2026-08-30 18:16（Asia/Shanghai）从 PR #26 合并提交 `17683491cb7e1d57d0775f3fe76351d21077f146` 构建 Windows x64 产物。Setup `UCLI-Setup-0.12.0-x64.exe`（134,216,193 bytes，SHA-256 `90D4827280C7142AD346766DCCAF4A903E9827458A4F3E2748C770334E4A5EE7`）；blockmap（137,325 bytes，SHA-256 `B90E289F78F536ACA8EE2F6E9224EB3632907D20B5420C7C7824C314F37F0419`）；Portable `UCLI-Portable-0.12.0-x64.exe`（133,961,402 bytes，SHA-256 `1878F2BDF386B8E55CB64DF41E1FC17FE93A557309A35230361A0722C86D6F04`）；`latest.yml`（348 bytes，SHA-256 `E303668E6F165680BB063F90FB8E697441B35B156DB36138DBC478A12E940A6B`）。四者由同一次 `npm run dist:win` 生成，`npm run verify:release` 已通过。其后的证据文档提交不属于 `electron-builder.yml` 的打包输入。 |
| Windows 最终修复候选 | PASS：2026-08-31 00:15（Asia/Shanghai）在 Windows x64 上从最终修复源码构建。Setup `UCLI-Setup-0.12.0-x64.exe`（134,216,932 bytes，SHA-256 `A0EE73F5F9FE77A41C90F1D80E81C55E19E3D2929E0827E09F6FC98205B91E0C`）；Portable `UCLI-Portable-0.12.0-x64.exe`（133,961,537 bytes，SHA-256 `F2F7049D79387E721FB2D2C5989728B6D37CFC357910C3A1933FD721FA20B35B`）。`npm run verify:release` 通过；全量测试 1881 项、1869 通过、12 跳过、0 失败，NSIS 条件卸载目标测试 7/7 通过。此前 22:12 构建被本候选取代。 |
| 合并后 Windows 服务档案候选 | PASS：2026-09-01 01:01（Asia/Shanghai）从合并基线 `1074fe079e79573384617a77ae00d6852a29fd19` 加入 clean-install Electron runtime 修复 `7c507ad` 与 Codex 固定 `/v1` 服务网关前缀修复 `894ac8a`。干净依赖树安装已验证 Electron runtime 可用，且外部环境不能替换可执行 installer 目录；全量测试 1950 项、1938 通过、12 个平台条件跳过、0 失败，`git diff --check`、`npm run build`、`npm run dist:win` 与 `npm run verify:release` 均通过。安装版 `0.12.0` 保留已连接服务和三模型目录；新建独立 Codex 会话时仅显示兼容的 Responses 模型，显式选择非首个 `deepseek-v4-pro` 后请求模型、运行时模型一致，最小非敏感请求返回非空 `OK`，未再出现本地网关 404。Setup `UCLI-Setup-0.12.0-x64.exe`（134,227,333 bytes，SHA-256 `668DBE2DDA9A74CCD810247D50563E3AA64A543428EA6F480989CB65622E6B5E`）；blockmap（137,399 bytes，SHA-256 `10F2666DFD63078C5E97804706A7D548A6BFE9A3F6B165D418E5E82FEF808D68`）；Portable `UCLI-Portable-0.12.0-x64.exe`（133,971,864 bytes，SHA-256 `52ED1A428949F8EF700C55DFE6849C85236498E8DF5077539355230A2F7CBB36`）；`latest.yml`（348 bytes，SHA-256 `FF28759C7F4AA241114BFC6E1B7156DB2E1FCBA57BFEE3E8DAC48DA08B73A972`）。本行不包含授权链接、token、响应正文或完整 headers。 |
| Windows 原生人工检查 | PASS：在已运行的安装版 `0.12.0` 上覆盖安装；点击进入安装阶段后 5 秒内 `UCLI.exe` 进程归零，未出现“无法关闭”，安装完成并自动启动。界面仍显示 15 个项目、34 个会话和 `v0.12.0`；`ucli://` 命令为 `"F:\soft\ucli\UCLI.exe" "%1"`。冷启动时 Windows Shell 将 URI 规范化为 `ucli://connect/?...`，安装版正常启动，并在 2026-08-30 22:21:42 向生产服务端发出 preview 请求；运行中再次打开链接时主进程保持同一 PID，服务端在 22:23:21 收到第二次 preview。两次使用无效非敏感测试密钥，均按预期返回 400，未绑定设备。Portable 从临时目录正常启动，显示 `v0.12.0`、15 个项目和 34 个会话，并明确提示当前环境不支持自动更新；启动前后协议注册始终指向安装版。2026-08-31 条件卸载发现并修复两个真实 NSIS 缺陷：卸载后 `GetFullPathName` 无法解析已删除的 EXE，以及 System 插件 `r0/r1/r2` 误用了 `$0/$1/$2` 而非 `$R0/$R1/$R2`。修复候选卸载自有 command/icon 时完整删除 `ucli` key；将 command/icon 改为系统记事本模拟外部所有者后，卸载 UCLI 仍原样保留该 key。最终已重新安装到 `F:\soft\ucli`，协议恢复为 UCLI 所有，单主进程运行，15 个项目和 34 个会话保留。 |
| macOS / Linux | 待完成：原生 macOS DMG/ZIP 验证；Linux 打包验证。未以静态检查替代。 |
| 真实协议 smoke | PASS：2026-08-30 16:10:42（Asia/Shanghai）在客户端 `9b7b17c`、服务端 `a675de6fb2fad74c41553653c998b2a29fce183f`、runtime `sha256:e4a8f48841434df722bd361c2d2c65fd74674e10db8aef2413191700d63ee2f9` 上以全新授权仅执行一次；Preview、首次/幂等 Redeem、强制 Refresh、Bootstrap、Gateway 双目录、显式 `openai_responses` 非空模型流、Skills 目录、ZIP 大小/SHA-256 和 cleanup 全部通过，Skill 未安装或执行。更早一次功能 PASS 因成功诊断丢失不能作为最终验收；本行以修复后的新授权证据为准。 |
| 真实降级 | 待完成：用真实 0.11.6 二进制验证其忽略 `server_*` 表和 `ucli-server-*` 文件。 |

### 0.12.0 数据与紧急关闭

- [x] 服务端能力没有自动默认模型或自动安装 Skills；独立模式、已有本地会话、Profiles、Skills 和数据保持可用。
- [x] 服务档案按规范化 origin 与组织聚合；默认项和会话只在显式 `(serviceProfileId, modelId)` 选择可用时启动。`openai_chat` 保持目录可见，但不是托管 Codex 或 Claude 启动目标。
- [x] 服务档案/模型迁移对精确来源回填；歧义绑定清除、无法证明来源的历史会话保留并 fail closed。Codex artifact 按模型隔离，模型或 Skills 同步错误不改变连接/授权成功状态。
- [x] 紧急关闭只移除服务端入口/能力，不删除本地会话、Profiles、Skills 或数据。
- [ ] 在隔离安装中手工确认断网、5xx、disabled/expired/account/org inactive 状态不影响本地能力。
- [x] 新部署的真实 smoke 已完成模型流、Skills 下载哈希和清理。验收仅保留协议、阶段、allowlisted 稳定诊断和清理结果；未记录链接、URL、token、请求/响应体、完整 headers、身份信息或堆栈。

### 0.12.0 Skills 本地管理 DEV 验收

本节只可使用一次性、本地的 fixture 用户数据和 Skill 目录。不得读取或修改用户现有 Skills，不得创建服务端授权、使用真实组织 ZIP，或执行远程安装/更新；验收记录不得包含组织 ID、服务端 URL、用户路径、token、header、响应正文或测试凭证。

- [ ] “组织 Skills”和“本地 Skills”视图均可用；组织目录先显示缓存，随后五分钟外的后台刷新可由匹配目录事件更新页面，且不阻塞本地视图。
- [ ] 临时同步失败保留组织缓存和本地 Skills；显式断开仅清理未安装在线目录，已安装组织包仍显示其持久来源身份。
- [ ] CLI 矩阵显示 `enabled`、`disabled` 与 `inherit`。直接停用只影响目标投影；无法隔离的继承消费者显示 `SKILL_CLI_ISOLATION_UNSUPPORTED`，不显示成功确认。
- [ ] 停用提供者前为仍启用消费者建立并校验直接投影；筛选后的全选不包含隐藏项。
- [ ] 批量部分失败后只保留失败或跳过项供重试；`SKILL_PERSISTENCE_PENDING` 或恢复失败停止剩余项并显示恢复边界。
- [ ] 停用不删除规范包，移除投影不删除规范包；“移除受管包”有单独危险确认。控制台没有新的未捕获错误或重复 warning 循环。

## 0. 验收记录

| 字段 | 填写内容 |
| --- | --- |
| 验收版本 |  |
| Git 标签 / 提交 |  |
| Windows 版本与架构 |  |
| Claude Code 版本 |  |
| Codex 版本 |  |
| OpenCode 版本 |  |
| 验收人 / 日期 |  |
| 结果 | 通过 / 阻断 / 有条件通过 |

## 1. 发布前自动检查

- [ ] `npm test` 通过。
- [ ] `npm run build` 通过。
- [ ] `npm audit --registry=https://registry.npmjs.org` 通过，生产与构建依赖均无已知漏洞。
- [ ] `npm run dist` 生成 Windows x64 的安装版、便携版、blockmap 与 `latest.yml`。
- [ ] `npm run verify:release` 通过。
- [ ] `git diff --check` 通过。
- [ ] Release 的标签、`package.json` 版本、`latest.yml` 版本一致。
- [ ] 下载页公布安装版和便携版的 SHA-256，且与本地计算结果一致。

## 2. 安装、启动与升级

- [ ] 从 GitHub Release 下载 `UCLI-Setup-<version>-x64.exe`，核对 SHA-256 后安装。
- [ ] 首次启动显示工作台，未出现空白页、preload 错误或无限页面高度增长。
- [ ] 关闭主窗口后缩小到托盘；从托盘恢复窗口；选择退出后进程彻底结束。
- [ ] `UCLI-Portable-<version>-x64.exe` 可独立启动并显示正常工作台。
- [ ] 从上一版本覆盖安装后，工作台会话、规则、统计和数据库记录仍存在。
- [ ] 开发版与安装版可以分别启动，不会争用数据库、缓存或单实例锁。

## 3. CLI 与历史会话

- [ ] 在设置页检测已安装的 Claude Code 与 Codex；版本和路径显示正确。
- [ ] 新建 Claude Code 会话并选择工作目录；能发现对应原生历史会话。
- [ ] 使用含中文目录名的工作目录，Claude Code 历史仍能被发现和导入。
- [ ] 新建 Codex 会话并选择工作目录；能发现并导入原生历史会话。
- [ ] 恢复 Codex 历史会话；若历史 provider 不可用，界面提示回退并仍可恢复原上下文。
- [ ] 新建 OpenCode 会话并选择工作目录；确认 Windows 路径大小写、分隔符、尾部分隔符和中文目录下的历史会话均可发现。
- [ ] 导入一个 OpenCode 源会话后，确认它在列表中标为“已添加”，其他源会话未被误标记；停止并恢复后仍使用同一源会话 ID 与上下文。
- [ ] 已添加的历史会话显示为已添加，不能重复导入；移除后可从源会话重新添加。

## 4. 工作台与会话生命周期

- [ ] 可切换 1、2、4 窗格；终端尺寸与页面高度保持稳定。
- [ ] 分别在 Claude Code、Codex、OpenCode 的 1、2、4 窗格中打开“历史”；每个窗格都能独立滚动和选择文本，不带动其他窗格。
- [ ] 反复点击“加载更早记录”可到达源会话第一轮；OpenCode 历史包含当前 TUI 可视范围之前的消息。
- [ ] 从“历史”返回“终端”后，原生 TUI 屏幕、输入、快捷键、斜杠命令和 provider 原生鼠标行为保持不变。
- [ ] 收缩/展开会话列表、切换 1/2/4 窗格、进入/退出单窗格和整个分屏全屏后，不出现截断行、空白终端或错误 PTY 尺寸。
- [ ] 删除或暂时无法读取原生历史源时，仅显示“源历史记录不可用”，当前 CLI 进程和终端仍正常运行。
- [ ] 在两个及以上已分配会话之间，`Tab` 前进、`Shift+Tab` 后退；单一活动会话时 Tab 保留给原生 CLI。
- [ ] 关闭窗格：仅关闭当前窗格，CLI 进程、UCLI 记录、源会话和统计保持。
- [ ] 停止会话：终止 CLI 进程，但会话记录和窗格保留，可恢复。
- [ ] 移除会话：从工作台隐藏并停止进程；源会话、Token、费用和审计统计仍保留。

## 5. 安全与统计

- [ ] 可信规则中的安全网络命令按配置自动放行。
- [ ] 高风险命令触发确认；硬黑名单始终拒绝。仅在专用测试目录中验证，不执行真实删除或发布操作。
- [ ] Claude Code 会话产生模型、Token、费用、轮次和审批留痕。
- [ ] Codex 会话产生可用的 Token、模型和轮次统计。
- [ ] OpenCode 会话产生模型、Token 和轮次留痕；官方导出未提供费用时显示“不可用”，真实 `$0` 不被混淆。
- [ ] 移除会话后，统计页面仍包含已产生的历史用量和审计数据。

## 6. 发布结论与回归处理

- [ ] 只有所有阻断项通过，才将 GitHub Release 标记为正式发布。
- [ ] 发现回归时，在 GitHub Issues 创建问题，包含版本、Windows 版本、CLI/provider、复现步骤、期望结果、实际结果和脱敏日志。
- [ ] 将问题标记为 `needs-triage`；信息不足时使用 `needs-info`。
- [ ] 修复后使用本清单重新验证原复现路径，并在 Issue 中记录结果。

## 7. 飞书通信 Gateway

### 企业应用前置条件

- [ ] 已创建飞书企业自建应用并启用机器人能力。
- [ ] 事件订阅使用 WebSocket 长连接，不配置公网 Webhook。
- [ ] 已订阅消息接收事件和卡片回传事件。
- [ ] 应用具备发送消息、更新卡片、回复消息和消息表情回复所需权限。
- [ ] 目标为群组时，已申请群组完整消息权限；目标为用户时不额外申请该群权限。
- [ ] 应用已发布到测试企业，机器人已加入目标群或可向目标用户发消息。
- [ ] App Secret 只在 UCLI 本机设置页输入，诊断文件、日志和截图中均不出现明文。

### 配置与生命周期

- [ ] Gateway 关闭时测试配置；测试成功后原子应用，失败不覆盖当前可用连接。
- [ ] 在设置抽屉选择一个可运行会话和一个离线会话；工作台头部只显示全局开关和状态。
- [ ] 开启后进入“等待绑定”；私聊机器人或在目标群 `@机器人` 发送 `绑定 UCLI`。
- [ ] UCLI 本地出现绑定候选，且只显示脱敏目标与发起人信息；本地确认后才保存目标。
- [ ] 绑定发起人自动成为首位操作人；未确认前不转发会话，也不接受其他飞书任务。
- [ ] 解除绑定后保留 App ID/Secret 并重新进入“等待绑定”，旧目标与操作人立即失效。
- [ ] 重启 UCLI 后，开启意图会自动连接；已绑定配置直接恢复，未绑定配置继续等待绑定。
- [ ] 在头部关闭 Gateway 并重启；确认仍为关闭，不发生自动连接或消息补发。
- [ ] 关闭 Gateway 不停止、恢复、删除或改变任何 AI CLI 会话。

### 会话转发选择状态矩阵

| 会话选择 | 全局 Gateway | 绑定/连接 | 会话状态 | 预期控件 | 预期网络行为 |
| --- | --- | --- | --- | --- | --- |
| 未选择 | 任意 | 任意 | 任意 | 未选择转发 | 不创建会话根消息或转发消息 |
| 已选择 | 已关闭 | 任意 | 任意 | 已选择，Gateway 已关闭 | 不发送消息；选择状态保留 |
| 已选择 | 已开启 | 未绑定 | 任意 | 已选择，等待飞书绑定 | 不发送消息 |
| 已选择 | 已开启 | 连接中/重连中 | 任意 | 已选择，等待连接 | 不发送消息 |
| 已选择 | 已开启 | 已连接 | 已停止/离线 | 已选择，等待会话 | 会话就绪前不创建根消息 |
| 已选择 | 已开启 | 已连接 | idle/running | 正在转发 | 创建或复用根消息 |
| 正在切换 | 任意 | 任意 | 任意 | 正在更新，控件禁用 | 每次操作仅发起一次 IPC 更新 |
| 更新失败 | 任意 | 任意 | 任意 | 恢复服务端状态并显示错误 | 不显示错误的成功状态 |

### 路由与消息

- [ ] 可运行的已选会话创建一条根消息；重复同步复用同一根消息。
- [ ] 撤回根消息后，下次同步重新创建根消息并替换失效路由。
- [ ] 非操作人白名单用户的消息和卡片操作均被拒绝。
- [ ] 关闭某会话转发后，旧 root、线程、消息和卡片按钮均失效；重新开启创建新入口。
- [ ] 群组普通消息即使 `@机器人` 也不路由；只有已知 root/thread 下的回复可路由。
- [ ] 私聊仅在恰好一个已选会话为 idle/running 时允许无引用任务；多个候选时拒绝。
- [ ] 普通 AI CLI 输出、终端流、reasoning、工具调用和 Token 用量不会转发到飞书。

### 决策、方案、完成与恢复

- [ ] 安全规则未覆盖的行为保持等待，由用户在桌面端或飞书端决定；等待五分钟后不会自动拒绝。
- [ ] 桌面端与飞书端同时回答同一决策时只有一个胜出，另一端按钮立即失效。
- [ ] 方案卡片显示确定性摘要；点击后可查看完整方案；整个流程不需要配置 LLM。
- [ ] 用户可在方案线程中提交修订，provider 再次请求确认后可执行或拒绝。
- [ ] 明确任务完成时发送完成卡片；用户点击后可查看完整结果。
- [ ] 首个任务立即执行，最多等待五个任务，第六个等待任务被拒绝。
- [ ] 歧义路由、不支持的内容和队列已满均收到明确回执；远端网络失败不改变本地拒绝结果。
- [ ] 桌面端已有明确运行中的 turn 时，飞书任务等待其完成，不会并发写入 CLI。
- [ ] 中断后队列暂停；继续处理队首；清空取消全部剩余任务。
- [ ] 非预期 WebSocket 重连后同步根状态、待决策和最近完成信息，但不重放普通任务。
- [ ] 主动关闭后不进行状态补发；再次开启只建立当前状态。

### 诊断与发布结论

- [ ] 导出诊断，确认只含期望/实际状态、通道类型、掩码目标、会话计数、最近连接时间、
  脱敏错误以及路由/审计行数。
- [ ] 诊断不含 App Secret/密文、完整操作人 ID、消息正文、任务、决策、方案、结果、
  action token 或 AI 输出。
- [ ] 在验收记录中填写飞书应用版本、目标类型、实际测试账号和结果；不要记录 Secret
  或完整 Open ID。

## 8. 0.8.0 配置档案验收

- [ ] 新建 Codex 引用档案和托管档案；托管密钥保存后页面只能看到是否已保存和末尾掩码。
- [ ] 同时打开两个 Codex 分屏并选择不同档案；确认各自使用对应 Provider，且密钥环境不会出现在其他会话、其他 CLI、日志或诊断中。
- [ ] 设置应用默认和项目默认；确认显式会话选择优先，其次项目默认、应用默认、系统当前。
- [ ] 导入历史 Codex 会话时保持历史来源；项目默认档案不能静默覆盖历史 Provider。
- [ ] 运行中切换档案；选择“取消”时绑定不变，选择“下次重启生效”时进程不重启，选择“立即重启”后新档案生效。
- [ ] 退出并重新打开 UCLI；保存的 1/2/4 分屏、会话和档案绑定直接恢复，无需切换分屏。
- [ ] 使用 CC Switch 修改 `config.toml`；系统当前会话跟随变化，具体档案会话保持独立，UCLI 不覆盖 `config.toml`。
- [ ] 外部修改和删除 UCLI 自有 profile 文件；分别显示漂移和缺失，且只有用户明确确认后才覆盖或重新生成。
- [ ] 备份后删除本地数据库并启动；带所有权标记的档案可恢复非敏感字段，托管密钥要求重新输入。
- [ ] 导出诊断；只包含档案总数、可用/漂移/缺失计数、配置目录可写性和最近检查时间。
- [ ] Claude Code、OpenCode、U-Code 只显示“0.8.0 沿用系统配置”，没有不可用的保存按钮。

## 9. 0.10.0 统计与工作总结

### 已自动覆盖的无费用路径

- [x] 使用 fake runner 覆盖证据收集、分块、重试、取消、调度 catch-up、启动恢复、导出和失败容错；不调用真实 AI CLI，不产生 Provider 费用，不修改用户会话。
- [x] 验证小时、天、周、月趋势查询及项目、CLI、模型、指标筛选；验证升级前累计基线与升级后精确趋势分开显示。
- [x] 验证自动总结默认关闭、每种周期只补最新一个缺口、过期运行任务在重新入队前中断，以及退出时停止调度器。
- [x] 验证运行日志不含 prompt、transcript、Markdown、凭据、原始 CLI 文本，只包含批准的运行元数据。
- [x] 验证 Markdown 导出和严格白名单 HTML 导出；恶意链接、资源加载、脚本、动态 SVG、隐藏正文和导航伪造均被拒绝。

### 需要用户本地验收

以下项目会调用本机已安装的真实 AI CLI，可能产生 Provider 费用，因此本次自动验证未执行：

- [ ] 从 pre-0.10 数据库升级，确认旧累计总量只显示为 legacy totals，不会进入升级后的精确时间桶。
- [ ] 产生实时使用更新，确认小时、天、周、月四种趋势均出现正确数据，项目、CLI、模型和指标筛选可用。
- [ ] 分别生成每日、每周、每月、每季度和每年报告，核对周期边界、时区、覆盖提示和使用量口径。
- [ ] 在副本项目和无敏感信息的测试会话中，分别选择计划支持的 AI CLI 生成一次手动总结；确认命令可用、模型和 Provider 符合预期，并记录费用。
- [ ] 设置一个全局默认 AI CLI，再为单次手动报告覆盖 executor、profile 或 model，确认覆盖只影响该版本。
- [ ] 明确启用一种自动总结周期，关闭应用并跨过周期边界后重新打开，确认每种周期只生成最新一个缺失报告；完成后立即关闭自动总结。
- [ ] 在生成期间退出并重启应用，确认旧任务标为 interrupted、不会重复扣费，且主窗口仍能打开。
- [ ] 取消一个多分块报告并重试，确认子进程停止、取消版本保留审计记录且重试产生新版本。
- [ ] 为同一周期重新生成报告，切换“当前版本”后重启应用，确认 current 选择和全部历史版本仍正确。
- [ ] 复制报告 Markdown，并通过系统文件选择器导出 Markdown；确认两者都与持久化的 canonical Markdown 一致。
- [ ] 分别导出 light、dark 和 custom 三种 AI HTML，使用浏览器离线打开并检查固定左侧导航、标题、项目进度、风险和下一步建议。
- [ ] 在测试会话中加入 prompt-injection 文本与假密钥，确认模型没有遵循证据中的指令，报告、日志和导出均不泄漏假密钥原文。
- [ ] 在 Claude Code 内单独运行 `/insights`，确认它仍是 Claude Code 的交互式原生报告，而不是 UCLI 0.10.0 的跨 CLI 总结引擎。
- [ ] 准备一个已经含 OpenCode compact/native digest 的测试会话，确认 UCLI 可复用现有摘要；同时确认 UCLI 没有修改原生会话或生成新的 compact。

## 10. 0.10.1 总结性能、工作区与主题验收

本节使用专门的非敏感测试数据。除“AI Custom”项目外，主题验收必须断网执行且不得启动任何 AI CLI。需要 AI 的生成项目由验收人员明确确认费用后手工执行，自动化测试只使用 fake runner。

| 锚点 | 人工检查 | 预期结果 |
| --- | --- | --- |
| `summary-workspace-recovery` | 使用 pre-0.10.1 数据库升级并打开既有报告；并在并行 Map 中取消、重启后重试 | 旧报告可读；启动顺序为工作区恢复、缓存校验/清理、旧任务中断、调度补偿；已完成缓存条目不重复执行 |
| `summary-direct-one-call` | 生成一个证据完整的小型日报，记录冷启动耗时和性能指标 | 策略为 direct，计划调用与实际 AI 调用均为 1 |
| `summary-cache-partial-hit` | 生成多项目报告后原样重生成，再仅修改一个项目重生成；分别记录热缓存耗时 | 完全重复时 AI 调用为 0；单项目变化时未变化项目命中缓存，只重跑受影响 Map 和下游 final |
| `summary-cache-quota` | 先产生超过新配额的缓存，再把配额降低到当前占用以下 | 新自动任务前按 LRU 清理到配额内；报告、用量账本、设置和完成工作区不被删除 |
| `summary-map-concurrency` | 设置并发度为 2，生成至少三个独立 Map 的报告，并在执行中取消一次 | 同时最多运行 2 个 Map，第三个等待；取消后不启动新 Map，重试可复用已经完成的缓存条目 |
| `summary-theme-executive` | 离线导出 Executive | 不启动 AI 进程；呈现管理摘要结构，标题导航完整 |
| `summary-theme-engineering` | 离线导出 Engineering | 不启动 AI 进程；呈现工程报告结构，标题导航完整 |
| `summary-theme-timeline` | 离线导出 Timeline | 不启动 AI 进程；呈现时间线结构，标题导航完整 |
| `summary-theme-dashboard` | 离线导出 Dashboard | 不启动 AI 进程；呈现仪表盘结构，使用量卡片只包含可信数值 |
| `summary-theme-print` | 离线导出 Print | 不启动 AI 进程；呈现适合打印的结构和固定样式 |
| `summary-ai-custom-export` | 选择 AI Custom，确认界面明确提示速度较慢且产生 AI 用量，再导出 | 仅在确认后启动一次 AI；输出经过安全验证，不接受不安全 HTML |

### 10.1 完整人工矩阵

- [ ] 升级 pre-0.10.1 数据库，打开一个已有报告，确认迁移保留报告、设置及用量数据。
- [ ] 生成小型日报，确认 direct 策略只产生 1 次 AI 调用，并记录冷启动耗时。
- [ ] 生成多项目报告，再原样重生成，确认热缓存命中且不产生新的 AI 调用。
- [ ] 只修改其中一个项目，确认其他项目的 Map 缓存继续复用。
- [ ] 在并行 Map 中取消任务，重启并重试，确认完成的缓存条目不会重跑，工作区不会残留 running 状态。
- [ ] 将缓存配额降低到当前占用以下，确认在新的自动任务前完成 LRU 清理。
- [ ] 完成报告后检查工作区：输入证据已经删除，保留的 output 与 manifest 合计不超过 5 MiB。
- [ ] 断网导出 Executive、Engineering、Timeline、Dashboard、Print 五个内置主题，确认 AI 进程启动次数为 0。
- [ ] 导出 AI Custom，确认界面明确标注 AI 使用与潜在费用，生成结果通过本地安全验证。
- [ ] 检查所有 HTML：无 `script`、远程 URL、事件处理属性或用户 CSS；标题与导航存在，报告正文内容未被本地主题渲染器改写。
- [ ] 检查旧版 light 映射到 Executive、dark 映射到 Engineering、custom 映射到 AI Custom，取消导出不会启动生成或打开保存对话框后的写入流程。
- [ ] 检查设置默认值：缓存配额 1 GiB、失败工作区保留 7 天、Map 并发度 2；“清理缓存”不会删除报告，“同时清理失败工作区”只删除 failed/interrupted 工作区。

## 11. 0.10.2 设置、应用空间与软件更新验收

本节使用非敏感测试数据。自动化测试不得调用真实 AI CLI、不得访问真实更新服务，也不得清理真实用户数据；下列项目由验收人员在隔离副本或专用测试安装中执行。

| 锚点 | 人工检查 | 预期结果 |
| --- | --- | --- |
| `settings-section-navigation` | 使用鼠标与键盘切换设置分区，并分别在高于和低于 900 px 的窗口中操作 | 当前分区清晰可见，焦点顺序正确，窄窗口仍可访问全部设置 |
| `settings-section-deep-link` | 打开 `?section=storage` 后重新加载，并从侧栏更新详情进入 `?section=updates` | 重新加载和详情导航均落到指定分区，不丢失共享状态 |
| `storage-inventory-no-provider-paths` | 查看全部应用空间类别并检查 IPC 返回 | 只显示固定中文标签与安全计数，不出现外部 Provider 路径、项目路径、文件名或错误元数据 |
| `storage-protected-data` | 查看报告、用量账本、设置、会话、档案、Skills 与活动工作区 | 受保护数据有明确说明且不可清理，操作区不出现清理按钮 |
| `storage-immediate-cleanup` | 在测试副本中清理应用自有缓存和非活动派生数据 | 确认后立即清理；活动中的总结工作区保留，非活动且可重建的派生数据删除；用量随后刷新 |
| `storage-restart-cleanup` | 安排浏览器缓存、Skills 暂存和更新器暂存清理后重启 | 显示“下次启动时清理”，并在相关子系统启动前完成；受保护数据保持不变 |
| `storage-partial-failure` | 制造不可读目录或锁定文件后盘点并清理 | 显示 `partial` 或 `partial-success`，不可读/锁定项不被报告为零占用或完全成功 |
| `update-footer-available` | 在已安装 0.10.2 上提供较新的测试版本 | 展开与折叠侧栏均显示新版本提醒，但不自动下载；打开详情也不触发下载 |
| `update-footer-download-progress` | 明确点击下载并在导航和重新加载前后观察进度 | 侧栏与设置页显示相同百分比，导航与重新加载不会造成状态倒退 |
| `update-footer-downloaded` | 等待测试更新下载完成并明确点击“重启并安装” | 两处都显示“重启并安装”；只有明确点击才把控制权交给安装器 |
| `update-portable-unsupported` | 分别启动便携版与开发版 | 明确显示应用内更新不可用，不发起更新器网络请求，也不显示下载操作 |

### 11.1 完整人工矩阵

- [ ] 从已填充数据的 0.10.1 安装升级，确认设置、报告、会话、档案、Skills、用量与缓存均保留。
- [ ] 使用鼠标和键盘切换设置分区；重新加载 `?section=storage`；在低于和高于 900 px 的窗口中检查导航与内容。
- [ ] 检查应用空间清单不包含外部 Provider 路径或项目路径；确认受保护类别明确标记且不可清理。
- [ ] 在测试副本中执行即时清理，确认活动中的总结工作区保留，非活动且可重建的派生数据删除。
- [ ] 安排浏览器缓存、Skills 暂存与更新器暂存清理并重启；确认在相关子系统启动前执行，受保护数据保持不变。
- [ ] 制造不可读目录和锁定文件，确认结果为 `partial` 或 `partial-success`，而不是错误的零占用或完全成功。
- [ ] 在已安装 0.10.2 上提供较新测试版本，确认侧栏显示提醒但不自动下载。
- [ ] 明确下载测试更新，确认相同百分比同时显示在侧栏和设置页，且导航与重新加载后保持一致。
- [ ] 下载完成后确认显示“重启并安装”；只有明确点击时才把控制权交给安装器。
- [ ] 启动便携版与开发版，确认不发起更新器网络请求，并且侧栏和设置页不提供下载操作。

## 12. 0.11.1 DeepSeek Harness 整改验收

公开的 DeepSeek Harness 没有 CLI TUI；0.11.1 的产品契约是 Web-only，旧会话固定显示 **legacy TUI unavailable**。本节必须使用隔离的 DSH_HOME、非敏感项目和专用 profile。Windows x64 与 macOS arm64 必须分别在原生平台执行；自动化通过不能替代原生结果，未执行项必须保留为 pending。

| 锚点 | 原生平台检查 | 预期结果 |
| --- | --- | --- |
| `dsh-managed-install` | 从未安装状态在档案管理中确认安装 | 只安装并选择 UCLI owned `0.1.0-rc.6`；UI 分开显示 managed/system、受支持版本和唯一动作，不显示路径、registry、命令或原始错误 |
| `dsh-install-interruption-rollback` | 分别在下载中取消和制造网络失败，再重启 UCLI | staging 被确认清理或保留为内部可重试状态；没有选中 partial Runtime；原 Runtime 与 DSH_HOME 均未修改 |
| `dsh-managed-repair` | 损坏 exact owned Runtime 的受管文件后确认修复 | 重新验证 package、entry、integrity、pnpm 与所有权后原子替换；失败恢复旧 Runtime；未拥有目录不被覆盖 |
| `dsh-web-lifecycle` | 新建两个 Web 会话并执行 start、stop、restart、remove、quit | 两个 exact loopback 动态端口互不相同；iframe 隔离；每次清理都等待 owned process tree 确认，不复用旧 controller |
| `dsh-legacy-session-migration` | 载入含 `surface:tui` 与 `surface:legacy-tui` 的 0.11.0 数据库 | 旧记录保持不可用且不启动进程；只有确认后才以相同 cwd 新建独立 Web 会话，原记录不改写、不 resume |
| `dsh-legacy-bridge-removal-rollback` | 在含旧 bridge 的副本 profile 中执行移除，并分别制造命令失败、回滚失败与 cleanup 失败 | 只处理四项 metadata；普通失败恢复原 bytes/mode/缺失状态；回滚或 cleanup 失败返回稳定码并保留内部重试状态，不删除其他 profile 数据 |
| `dsh-skills-four-roots` | 在项目 `.dsh/skills`、项目 `.agents/skills`、`$DSH_HOME/skills`、用户 `.agents/skills` 各放置一个 portable Skill，并加入同名冲突 | 四个来源均被发现；rank 100/200/400/500 决定“生效/被来源遮蔽”；普通列表不显示绝对路径；内置来源只读 |
| `dsh-shared-projection-dedupe` | 对同一项目同时选择 Codex 与 DSH 安装、更新和移除一个共享 Skill | 数据库只有一条 shared installation 和一个 `.agents/skills` 物理副本；更新不覆盖更高优先级来源，移除不碰未拥有内容 |
| `dsh-runtime-uninstall-preserves-home` | 创建 profiles、native sessions 与 Skills 后卸载 managed Runtime | 只删除 exact owned Runtime；DSH_HOME、profiles、sessions、四类 Skills 来源和 UCLI 会话记录全部保留 |
| `dsh-windows-native-acceptance` | 使用 0.11.1 Windows x64 Setup 与 Portable 重复上述九项 | 记录 Windows 版本、DSH 版本、两件产物 SHA-256、结果与 pending/失败原因；无 owned 子进程残留 |
| `dsh-macos-native-acceptance` | 使用 0.11.1 macOS arm64 DMG 与 ZIP 重复上述九项 | 记录 macOS 版本/架构、DSH 版本、两件产物 SHA-256、结果与 pending/失败原因；保留 executable mode，使用进程组完成清理 |

### 12.1 自动化发布门

- [x] Runtime manager 测试覆盖 trusted npm/Node、固定版本/integrity/pnpm、staging、原子提升、所有权、junction/symlink containment、静默期、回滚、repair、cleanup retry 与卸载边界。
- [x] Web 测试覆盖 fixed argv、readiness budget、60 秒超时、exact loopback URL、双会话端口隔离、iframe CSP，以及 Windows tree/POSIX process-group 清理状态机。
- [x] 旧会话测试覆盖 start/resume/restart 稳定不可用、零进程调用、迁移需确认且新建独立 Web 会话。
- [x] profile 测试覆盖官方 base 初始化、web/headless/旧元数据拒绝、旧 bridge 四文件移除与 rollback/cleanup retry。
- [x] Skills 测试覆盖四个默认来源、rank/遮蔽、共享投影去重、只读来源、迁移日志和失败收敛。

### 12.2 Windows x64 原生验收（pending）

- [ ] 在干净 Windows x64 VM 安装 Setup，记录 OS build、安装包 SHA-256、应用版本和初始 DSH 状态。
- [ ] 完成 `dsh-managed-install`、`dsh-install-interruption-rollback`、`dsh-managed-repair` 与 `dsh-runtime-uninstall-preserves-home`，保存脱敏截图和结果。
- [ ] 完成 `dsh-web-lifecycle` 与 `dsh-legacy-session-migration`，确认两个 loopback 会话和所有进程树最终清理。
- [ ] 完成 `dsh-legacy-bridge-removal-rollback`、`dsh-skills-four-roots` 与 `dsh-shared-projection-dedupe`，确认 profile/Skills 数据边界。
- [ ] 使用 Portable 重复安装、Web 生命周期和卸载保留检查；记录与 Setup 的差异。

### 12.3 macOS arm64 原生验收（pending）

- [ ] 在干净 macOS arm64 VM 安装 DMG，记录系统版本、架构、DMG SHA-256、应用版本和初始 DSH 状态。
- [ ] 完成 `dsh-managed-install`、`dsh-install-interruption-rollback`、`dsh-managed-repair` 与 `dsh-runtime-uninstall-preserves-home`，检查 executable mode 保持正确。
- [ ] 完成 `dsh-web-lifecycle` 与 `dsh-legacy-session-migration`，确认两个 loopback 会话使用独立端口且普通 Web 会话不创建 Unix socket。
- [ ] 完成 `dsh-legacy-bridge-removal-rollback`、`dsh-skills-four-roots` 与 `dsh-shared-projection-dedupe`，确认 profile/Skills 数据边界。
- [ ] 使用 ZIP 重复安装、Web 生命周期和卸载保留检查；记录与 DMG 的差异。

### 12.4 产物与回归

- [ ] `npm test`、`npm run build`、`npm run dist:win` 与 `npm run verify:release` 全部通过；平台条件 skip 对应到上述 pending 原生项目。
- [ ] Windows 产物为 `UCLI-Setup-0.11.1-x64.exe` 与 `UCLI-Portable-0.11.1-x64.exe`；macOS arm64 产物为 `UCLI-0.11.1-arm64.dmg` 与 `.zip`。
- [ ] 每个应用包只含隔离资源 `resources/deepseek-harness/ucli-dsh-bridge-0.11.0.tgz`；tgz 保持四个 allowlist 文件，不含 Runtime、凭据、测试 fixture 或可启动界面包。
- [ ] 回归 Claude Code、Codex、OpenCode 与 U-Code 的 create/attach/input/resize/stop/restart、权限、历史、统计、总结、Skills 与通信功能。
- [ ] 检查 `git status --short`、`git diff --check` 和产物清单；不删除或覆盖用户已有的未跟踪 dist 目录。
