# Windows 发布验收清单

本清单用于 UCLI Windows x64 发布前和 GitHub Release 发布后的人工验收。自动化 `npm run verify:release` 只验证构建产物和更新元数据的一致性；以下交互行为必须在实际 Windows 环境中验证。

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

## 12. 0.11.0 DeepSeek Harness 验收

本节必须在隔离的测试 DSH_HOME、非敏感项目与专用 profile 中执行。自动化测试使用 fake runtime/socket/PTY，不调用真实 provider，不写用户 profile。Windows 与 macOS 必须分别在原生平台完成；一个平台的结果不能替代另一个平台。

| 锚点 | 人工检查 | 预期结果 |
| --- | --- | --- |
| `dsh-runtime-version` | 分别测试未安装、版本不可读、非 `0.1.0-rc.6` 和精确 `0.1.0-rc.6` | 前三者以稳定错误阻止 TUI/Web；精确版本可继续。界面不显示 DSH_HOME 或可执行文件路径 |
| `dsh-profile-rollback` | 对四个 profile 元数据文件记录 bytes/mode/原缺失状态，启用 bridge 时强制 pnpm 失败 | 仅 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml` 恢复；不删除 node_modules、插件、凭据或会话；回滚失败明确报告且保留私有备份 |
| `dsh-tui-permission-single-owner` | 分别触发 downstream allow/deny/ask、高风险命令与 `sandbox_permissions` | 每个工具最多出现一次 UCLI 提示；deny/超时/断桥不执行；workspace-write 保持固定，更宽 sandbox 直接拒绝，DSH 原生 UI 不二次询问 |
| `dsh-tui-root-subagent-code-mode` | root、continuable subagent、普通 subagent 与 Code Mode 并发叶子分别调用工具 | 每个实际叶子都经 `tools/pre-execute`，native session 映射不串线，相同 callId 不跨 agent 复用 |
| `dsh-two-session-isolation` | 同时运行两张 TUI 卡，分别输入、resize、审批、完成与恢复 | 两个 PTY、endpoint、token、request map、native session ID 和清理生命周期完全独立 |
| `dsh-web-loopback-isolation` | 同时启动两张 Web 卡并检查监听地址、URL 与 iframe | 使用不同 `127.0.0.1` 动态端口；不绑定 LAN、`0.0.0.0`、`::`；iframe 仅加载对应 exact loopback URL |
| `dsh-web-native-ownership` | 在 Web 中执行权限、查看历史与统计，并检查 UCLI 卡片/详情/Gateway | 权限、历史、统计只在 DSH 原生界面；UCLI 不挂载 xterm/history/approval/usage/Gateway，不把 native stats 记入账本 |
| `dsh-security-no-secret-persistence` | 启动、恢复、断桥、失败安装、停止、删除并检查日志/DB/IPC/诊断 | 不出现 endpoint、token、Web URL（退出后）、provider 凭据、prompt、transcript、tool input/result 或原始 stdout/stderr |
| `dsh-windows-native-acceptance` | 在 Windows x64 原生安装包验证 named pipe、PTY、Web、stop/restart/delete/quit | UCLI 主动清理使用进程树终止；无被拥有的子进程或 pipe 留存。记录 Windows 版本、DSH 版本、包 SHA-256 与结果 |
| `dsh-macos-native-acceptance` | 在 macOS 原生包验证 Unix socket 权限、symlink 拒绝、PTY、Web 与退出清理 | 临时目录 `0700`、socket `0600`，endpoint containment 成立；无子进程/socket 留存。记录 macOS/架构、DSH 版本、包 SHA-256 与结果 |

### 12.1 TUI、Gateway 与恢复

- [ ] 确认设置页只展示精确兼容 runtime 摘要；“配置档案 → DeepSeek Harness”可以初始化基础 profile 和管理 bridge，但不声称或下载 deepseek-harness 仓库中不存在的 TUI。
- [ ] 使用用户已有的兼容 TUI profile；确认 bridge 未安装、版本不兼容和已兼容三个状态彼此独立，操作完成后重新枚举。
- [ ] 检查实际 argv：新建为 `dsh --profile <profile>`，恢复追加 `--resume <nativeSessionId>`；cwd 固定为卡片工作目录，未使用 shell command string。
- [ ] 全屏交互、中文输入、复制粘贴、resize 与终端字节均正常；终端 ANSI 不会进入 transcript、最终回复或 Gateway。
- [ ] assistant committed、tool call/result、usage、attention、turn completion 映射一次且归属正确；恢复后统计在历史基线上累计，不回退或重复。
- [ ] Gateway 只接受 live、已认证且已有 native session ID 的 TUI。桥断开前后分别测试普通任务、队列、decision、interrupt、snapshot 与 reconnect；旧 generation 不得落卡、保存 route 或复活 token。
- [ ] 停止、重启、恢复、移除和退出均等待 bridge 与 PTY 清理确认；清理失败卡片保持 non-accepting 且保留所有权，可重试，不报告假离线。

### 12.2 Web、CSP 与生命周期

- [ ] 检查实际 argv 精确为 `dsh web --host 127.0.0.1 --port 0`，环境不含任何 `UCLI_DSH_BRIDGE_*`。
- [ ] readiness 只接受 stdout 完整行 `dsh web: http://127.0.0.1:<port>`；测试 ANSI、空白、路径、query、fragment、userinfo、非法端口、超过 16 KiB 和 60 秒超时均失败关闭。
- [ ] 检查 CSP 只允许 `frame-src http://127.0.0.1:*`，不增加 loopback `connect-src`、`unsafe-eval` 或 webview；iframe 采用最小 sandbox 与 `no-referrer`。
- [ ] Web stop/restart/remove/quit 先停用界面和 IPC，再确认整棵被拥有进程树退出；清理失败不复用 controller 或报告成功。

### 12.3 产物与回归

- [ ] `npm test`、`npm run build`、`npm run verify:release` 均通过，无 failed/cancelled；平台条件 skip 必须由对应原生平台验收覆盖。
- [ ] Windows 与 macOS 安装包各只含一个 `resources/deepseek-harness/ucli-dsh-bridge-0.11.0.tgz`；tgz 仅含 `package.json`、`cordis.patch.yml`、`framing.js`、`index.js`，无 bridge 源码目录、凭据或 TUI。
- [ ] 回归 Claude Code、Codex、OpenCode 与 U-Code 的 create/attach/input/resize/stop/restart、权限、历史、统计、总结、Skills 与 Gateway。
- [ ] 检查 `git status --short`、`git diff --check` 和产物清单；不得包含临时 DSH profile、上游 clone、测试 token、endpoint 或未归属文件。
