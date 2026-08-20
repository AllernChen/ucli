# Changelog

本项目的重要变更记录在此文件中。

## [Unreleased]

## [0.11.4] - 2026-08-20

- 会话产物：从 Claude / Codex / OpenCode / U-Code transcript 提取 AI 写入的文件路径，抽屉列出并支持内嵌预览（HTML / Markdown / 文本 / 图片）与系统程序打开，可弹出到独立原生窗口。

## [0.11.3] - 2026-08-19

### 修复

- 修复 Ctrl+V 在终端中粘贴两次的问题：xterm 6.x 新增原生 paste 事件，keydown 时抑制默认行为，只粘贴一次。
- 修复 ucode 会话 token 无数据的问题：ucode export 缺少会话级 info.tokens 时，改为逐消息求和回退。
- 降低启动内存占用：读取大文件头/尾改为有界读取（64KB/256KB），并用 countSessions 替代 listSessions 判空。

### 功能优化

- 菜单栏折叠按钮移到侧栏顶部，更显眼。
- 会话卡片新增「更多操作」下拉菜单（停止/重启/重命名/移除/配置），按维护状态门控。
- 会话卡片支持多选，并提供批量删除、批量停止。
- 新建对话框抽取为独立组件，SessionDetail 的新建按钮改为就地弹窗，不再跳转。
- 新增快捷新建（项目/CLI 分组「+」按钮预填 cwd）与会话名称输入框。
- 项目支持打开所在目录（调用系统文件管理器）。
- 会话窗格新增「定位」按钮，点击后工作台滚动到对应卡片并高亮。

## [0.11.2] - 2026-08-19

### DeepSeek Harness 数据接入

- DSH Web 会话现在纳入 UCLI 的 token 统计：capabilities 契约把 `statsOwner` 从 native 改为 ucli（权限/历史仍由 DSH 原生管理），新增 loopback API 客户端与每 10 秒的轮询器，把 DSH Web 的 token 用量聚合写入会话统计并在工作台/统计页展示。
- DSH 会话接入 summary：`sessionHistoryService` 新增 DSH 分支，总结时从 DSH Web 导出会话转录（Web 未运行时临时拉起再导出、完成后回收），按时间范围过滤，执行器仍为 claude/opencode。
- 引入 `fflate`（DSH 同款零依赖 ZIP 库）用于解压 DSH 的会话日志归档。

## [0.11.1] - 2026-08-18

### DeepSeek Harness 整改

- 0.11.0 的 DSH TUI 适配建立在错误的上游假设上：公开的 `deepseek-harness` 包并不提供可由 UCLI 启动的 CLI TUI。0.11.1 因此改为 Web-only；所有新会话只启动 DSH 原生 Web，旧 TUI 会话稳定返回不可用并只提供“新建 DSH Web”迁移动作。
- 新增 UCLI 托管 Runtime manager，固定安装并验证 `@deepseek-ai/dsh@0.1.0-rc.6`、pnpm `10.30.3` 和 npm integrity。安装、升级、修复、卸载使用 staging、原子提升、所有权标记、静默期门和失败回滚，renderer 不能提交路径、版本、registry、package 或 command。
- 原生 profile 继续由 DSH 拥有。UCLI 只初始化官方基础 profile，并把 `@ucli/dsh-bridge@0.11.0` 识别为 legacy bridge：不会自动加载或安装，只允许用户确认后按四个元数据文件的事务边界移除并回滚。
- DSH Skills 现在覆盖项目 `.dsh/skills`、项目 `.agents/skills`、`$DSH_HOME/skills`、用户 `.agents/skills` 及只读内置来源；按优先级选择生效来源，并让 Codex 与 DSH 的共享投影只保留一个物理副本。
- 0.11.1 升级、迁移和 Runtime 卸载均保留 DSH_HOME、profiles、原生 sessions 与 Skills；不会因为停用旧 TUI/bridge 路径而删除用户数据。

### 修复

- 新建 DSH Web 会话时，通过 DSH loopback API 自动把选中目录注册为 workspace 并预开一个空白会话，Web 界面打开即定位到该目录，而非空工作台。
- 修复移除 legacy bridge 失败：`pnpm remove` 不接受 `--ignore-scripts`，改用 `--config.ignore-scripts=true` 后按原四文件事务边界移除。
- 修复托管 Runtime 安装失败：安装超时由 2 分钟放宽到 15 分钟，慢网环境下冷装 `@deepseek-ai/dsh` 不再被提前终止。
- 修复新建会话面板中 DeepSeek Harness 出现两个入口的问题：通用「快速新建」与「发现历史会话」不再渲染 DSH，只保留专属「新建 DSH Web」。

### 发布兼容

- 应用与安装产物版本升级到 `0.11.1`；为识别并安全移除旧元数据，发布资源继续保留隔离的 `resources/deepseek-harness/ucli-dsh-bridge-0.11.0.tgz`，但不把它作为可启动界面或新安装依赖。
- DSH Web 继续使用 exact loopback URL、受限 iframe 和被拥有的进程树清理；权限、历史和统计由 DSH 原生界面管理，Gateway 对 Web 与全部旧 TUI generation 均保持关闭。

## [0.11.0] - 2026-08-14

### DeepSeek Harness 适配

- 新增 DeepSeek Harness 一等适配器，固定兼容 `@deepseek-ai/dsh@0.1.0-rc.6`，并提供桥接 TUI 与本地 Web 两种界面。
- 桥接 TUI 使用独立 PTY 保留原生全屏交互，同时通过 `@ucli/dsh-bridge@0.11.0` 提供认证的会话、权限、统计、通知、快照和 Gateway 控制平面；支持原生 session ID 持久化与 `--resume`。
- UCLI 不捆绑、下载或宣称提供 `turtle-ui`。TUI 必须由用户已有的兼容 DSH profile 提供；“配置档案”页可初始化基础 DSH profile，并显式安装或更新 UCLI bridge，bridge 失败时按元数据边界回滚。
- 新增 `dsh web --host 127.0.0.1 --port 0` 本地 Web 回退；严格验证 loopback URL 并在窄权限 iframe 中显示。Web 的权限、历史和统计由 DSH 原生管理，UCLI Gateway 保持关闭。

### 安全、生命周期与界面

- bridge protocol v1 使用 4 字节大端长度帧、1 MiB 上限、随机 token、严格 hello/hello-ack、exact schema、双向 RPC 上限与超时；endpoint/token 不持久化、不进入日志或 renderer。
- DSH 工具调用统一经过 fail-closed 权限门；root、subagent 与 Code Mode 叶子调用均独立检查，所有 bridged tier 固定保留 workspace-write sandbox，更宽的 `sandbox_permissions` 直接拒绝。
- TUI bridge 断线与 Web 主机退出均立即停止接受新操作；stop/restart/delete 等待被拥有的 bridge、PTY 或 Web 进程树清理确认，清理失败保留所有权并允许重试。
- Settings、Workbench、会话卡片、详情、统计、维护与 Gateway 改为 authoritative capability 驱动。DSH Web 不挂载终端、历史、审批、用量或 Gateway 控件；缺失能力默认安全停用。
- DSH Skills 仅作为项目 `.agents/skills` 的只读虚拟可见目标，与 Codex 共享同一物理投影，不创建用户级 DSH 安装或重复来源。

### 修复与发布基础

- Claude Code 历史会话中的 `<synthetic>` 等内部伪模型不再作为 `--model` 传回 CLI；原生会话 ID 与上下文保持不变，异常分屏可直接重新启动恢复输入。
- DSH bridge 冷启动握手窗口延长到 60 秒，避免 Windows 首次加载 rc6 插件树较慢时被误判为 hello 超时；hello 前 PTY 瞬时退出会在完整清理后自动重试一次，连续失败返回准确的进程启动错误，握手仍受随机 endpoint、token 与协议校验保护。
- 修复工作台窗格切换会话时沿用旧终端输出订阅的问题，新会话会先释放旧绑定再回放上下文，无需先关闭窗格才能显示内容。
- Electron 升级到 43.4.0，electron-builder 升级到 26.15.3，并更新 ZIP、TOML 与 Vite 构建链依赖；官方 npm 全依赖审计无已知漏洞，发布 CI 使用 Node.js 24。

## [0.10.2] - 2026-08-13

### 设置与应用空间管理

- 设置页改为可通过鼠标或键盘访问的分区导航，并支持 `?section=storage`、`?section=updates` 深链接；窄窗口下保持完整可用。
- 新增应用空间盘点。报告、使用量账本、设置、会话、档案、Skills 及活动中的总结工作区属于受保护数据，始终不可清理；只允许清理应用自有且可重新生成的缓存、非活动派生工作区、日志、浏览器缓存、Skills 暂存与更新器暂存，绝不展示或删除外部 Provider、项目或用户文件路径。
- 可安全即时删除的类别在用户确认后清理并刷新用量；被运行中子系统占用的浏览器缓存、Skills 暂存和更新器暂存会标记为“下次启动时清理”，在相关子系统启动前执行。不可读或锁定项以部分结果呈现，不会伪装成零占用或完全成功。

### 软件更新

- 侧栏底部保留当前版本，并在存在新版本时显示升级提醒；展开和折叠布局共享同一更新状态，点击详情只打开设置页，不会自动下载。
- 设置页提供明确的下载操作、与侧栏一致的下载进度，以及下载完成后的“重启并安装”操作；安装只在用户明确点击后交给安装器处理。
- 自动检查仅用于受支持的已安装版本，不自动下载。便携版和开发版明确显示不支持应用内更新，也不提供下载操作或启动更新器网络请求。

## [0.10.1] - 2026-08-12

### 总结生成性能

- 小型完整证据优先走 direct 单次生成；大型报告使用内容寻址缓存和最多 1–3 路的有限并行 Map，重复生成可复用已验证结果，单项目变化只重跑受影响的 Map 及下游汇总。
- 报告展示生成策略、计划/实际 AI 调用数、缓存命中、耗时和 Map 并发度，便于核对冷启动、热缓存与部分缓存复用效果。

### 本地工作区与存储控制

- 总结任务改用应用本地的持久工作区和缓存；其中内容均为可重新生成的本地派生数据，不会写入安装目录，也不会作为原始会话或正式报告的替代存储。
- 缓存默认启用且配额为 1 GiB；失败或中断工作区默认保留 7 天。设置页可调整配额、并发度和失败保留期，并可清理缓存或同时清理失败工作区。
- 启动时恢复中断工作区并校验缓存，日常按过期时间和 LRU 配额清理；完成后的工作区删除输入证据，仅保留紧凑清单与输出。

### HTML 主题

- 新增 Executive、Engineering、Timeline、Dashboard、Print 五种确定性本地 HTML 主题，离线导出无需启动 AI CLI，结构和样式各有侧重。
- AI Custom 仍可按明确标注的 AI 用量生成自定义 HTML，并继续执行本地安全验证；旧版 light、dark、custom 选择保持兼容映射。

## [0.10.0] - 2026-08-12

### 使用统计

- 新增按小时、天、周、月查看的精确使用趋势，支持项目、AI CLI、模型和 Token、费用、轮次、成本覆盖率等指标筛选。
- 精确趋势只覆盖升级后采集的数据；升级前累计总量继续单独展示，不推算不存在的历史时间桶。

### 工作总结

- 新增每日、每周、每月、每季度和每年工作总结，按项目整理用量、进展、风险和下一步建议，并支持 Markdown 与安全 HTML 导出。
- 支持选择已安装的 Claude Code、Codex、OpenCode 或 U-Code 执行；自动总结默认关闭，catch-up 每种周期只补最新一个缺口。
- 复用 OpenCode compact 等已存在的原生摘要，但不会修改用户原生会话以触发摘要；Claude Code `/insights` 保持为交互式原生报告，不作为跨 CLI 引擎。

### 安全与可靠性

- 总结证据在分块前执行有界收集与敏感信息脱敏；AI 输出按不可信内容处理，HTML 导出采用严格结构和样式白名单。
- 应用启动会在窗口显示前完成持久化恢复、过期任务中断和调度 catch-up；总结失败不会阻止主窗口，退出时会停止调度器。
- 运行日志仅保留报告 ID、阶段、周期、执行器、耗时、分块计数和类型化错误码，不记录提示词、转录、报告正文、凭据或原始命令。

## [0.9.6] - 2026-08-11

### Skills 管理

- Skill 集合安装支持多选和全选；所选 Skills 共用 CLI 目标与用户级/项目级范围，并按仓库顺序逐项安装。
- 集合中的每个 Skill 独立执行兼容性、重复安装和目标冲突预检；同名重复、CLI 不兼容或冲突项会阻止批量确认。
- 批量安装固定到预检时的同一 Git 提交并复用一次仓库检出，避免分支移动造成混合版本；仍保留原分支或默认分支作为更新来源。
- 普通单项失败不会中断后续项；若本地数据库持久化待完成，则保留此前成功结果、标记状态待确认项并立即停止后续安装。
- 失败结果显示具体 Skill、错误码和原因并保留失败项供重试；安装完成后的列表刷新失败也不会丢失批量结果。

## [0.9.5] - 2026-08-11

### Skills 管理

- Git 仓库根目录没有 `SKILL.md` 时，自动识别仓库内的多个 Skill，并在安装前提供子 Skill 选择，不再把集合仓库误报为无效包。
- 选择子 Skill 后按其仓库子目录重新执行元数据、兼容性和冲突预检；一次仍只安装一个 Skill，避免批量覆盖现有内容。

## [0.9.4] - 2026-08-11

### Skills 管理

- 支持通过 HTTPS 访问自建 GitLab，并允许私网或本机地址使用 HTTP；URL 中的账号、令牌、查询参数和锚点仍会在保存前清除。
- 私网 HTTP GitLab 克隆会在单次 Git 操作中绕过全局代理，避免本地代理阻断内网仓库；公网 HTTP 仍被拒绝。

## [0.9.3] - 2026-08-11

### Skills 管理

- Git 仓库来源改为根据 URL 自动识别 GitHub 或 GitLab，避免因手动选择来源类型与仓库地址不一致而无法安装。

## [0.9.2] - 2026-08-11

### Skills 管理

- Skills 安装新增 GitLab HTTPS 仓库来源，支持 GitLab 群组与嵌套群组路径、分支、标签、提交和可选子目录。
- GitLab 私有仓库继续复用本机 Git 认证；URL 中的账号或令牌会在检出前清除，不写入数据库、诊断或错误信息。
- 已安装 GitLab Skill 保留来源类型并支持检查更新、预览更新和更新；来源项目聚合与详情中明确显示 GitLab。

## [0.9.1] - 2026-08-11

### 工作台会话配置

- 每个会话统一通过配置图标打开“会话配置”弹窗，分屏标题栏只保留配置、历史/终端、全屏、中断和关闭窗格。
- 配置档案、Codex Provider、飞书转发、名称、备注、诊断、停止、重启和移除操作集中到分区清晰的弹窗中。
- 待重启、档案异常或 Provider 异常会在配置图标显示提醒，并在弹窗内展示具体原因和处理入口。
- 首页会话卡片、工作台左侧列表和分屏窗口复用同一个配置组件；关闭窗格不会停止或删除会话。

## [0.9.0] - 2026-08-07

### Skills 管理

- Skills 页面升级为按名称聚合的统一目录，支持 GitHub 来源项目分组、四 CLI 可见性矩阵以及将现有受管 Skill 直接应用到其他 CLI。
- 明确区分 Claude 用户/项目目录、Codex Agent Skills、Claude 插件和 CLI 内置来源；有效链接、物理位置和失效链接分别展示，插件命令或 MCP 配置不会误识别为 Skill。
- 重复安装改为幂等操作：相同来源或相同内容复用现有受管包；目标目录已有相同内容时安全接管且不改写文件；同名异内容继续阻止覆盖。
- 新增一级“Skills”页面，统一盘点 Claude Code、Codex、OpenCode 和 U-Code 的用户级、项目级、兼容继承及内置 Skills。
- 支持从本地目录、ZIP 和 GitHub 仓库安装；私有仓库复用本机 Git 认证，UCLI 不保存 GitHub Token。
- UCLI 保存受管原件并按实际可见性选择最少投放目录，支持启停、更新预览、卸载、接管、同名冲突诊断和会话重启提示。
- 增加内容哈希与漂移保护；外部修改可选择恢复 UCLI 版本或接纳为新的受管版本，未接管的现有 Skills 不会被覆盖或删除。

### 安全与兼容

- Skill 安装不执行包内脚本，并限制路径穿越、符号链接、ZIP 解压范围、文件数量和总体积。
- OpenCode 与 U-Code 的跨目录兼容发现会合并为镜像或标记冲突；U-Code 内置 Skills 通过 `ucode debug skill` 只读发现。
- 新增 `skill_packages` 与 `skill_installations` 数据表，受管原件保存在 UCLI `userData/skills`，应用升级后继续保留。

## [0.8.3] - 2026-08-07

### Changed

- OpenCode 的安装和升级统一使用 `npm install -g opencode-ai`。
- U-Code 的安装和升级改为 `npm install -g @allenchen77/ucode-cli`，不再从 GitHub Release 下载原生二进制。
- U-Code 启动时优先使用 npm 全局可执行文件；旧 `~/.ucode/bin` 安装仅作为兼容回退，不再被强制插入 PATH 首位。

## [0.8.2] - 2026-08-06

### Fixed

- Claude Code 托管档案启动时不再加载用户级 Claude settings（包括 Provider 路由、hooks、permissions 等），避免 cc-switch 写入 `~/.claude/settings.json` 的 DeepSeek 地址覆盖 UCLI 当前选择的 MiMo 等档案。
- 托管档案继续保留项目级和本地级 Claude 设置；系统当前/订阅模式仍沿用完整的 Claude 用户配置。
- API Key 与 Bearer Token 仍只注入目标子进程环境，不进入命令行、临时 settings、会话记录或日志。

## [0.8.1] - 2026-08-06

### Claude Code 配置档案

- 新增 Claude 登录态、Anthropic API Key 和 Bearer Token 网关三种连接档案，支持应用默认、项目默认、新建/导入选择以及运行中会话切换。
- 每个 Claude 会话独立编译启动参数与环境；历史导入默认保持历史连接，UCLI 重启后恢复同一原生会话和档案绑定。
- 档案可设置首选模型；当 Claude 组织策略替换模型时，会话显示实际模型但不修改档案。

### 安全与兼容

- UCLI 不读取 Claude OAuth token，不修改 Claude 全局设置；API Key 与 Bearer Token 使用系统安全存储，只注入目标子进程并启用凭据清理。
- 诊断仅输出 Claude 档案数、连接方式、缺少凭据数和模型替换数，不包含密钥、Bearer Token、Base URL、环境变量或会话内容。
- “系统当前”继续继承现有环境；Bedrock、Vertex 与 Foundry 继续沿用系统配置。OpenCode 和 U-Code 的档案管理保持后续 0.8.x 计划。
- Claude Code 的 fallback model 参数只适用于非交互打印模式，因此 UCLI 交互终端不提供无效的 fallback model 设置。

## [0.8.0] - 2026-08-06

### 配置档案中心

- 新增一级“配置档案”页面，按 Codex、Claude Code、OpenCode 和 U-Code 展示真实支持状态。
- Codex 支持引用现有 Provider 和 UCLI 托管档案，可创建、编辑、复制、删除、设置应用/项目默认并回滚最近十个非敏感版本。
- 支持检测外部修改、缺失文件和孤立的 UCLI 档案文件，并提供显式重新读取、覆盖或重新生成操作。

### Codex 会话级档案

- 新建、导入和每个分屏会话均可独立选择档案；历史导入默认保持来源 Provider。
- Codex 使用官方 `--profile` 启动机制，档案绑定随本地会话和工作台一起恢复。
- 运行中切换只保存期望档案，由用户决定下次重启生效、立即重启或取消。

### 安全与兼容

- 托管密钥使用 Electron `safeStorage` 和操作系统密钥设施加密，不写入 TOML、命令行、Renderer、日志或诊断报告。
- UCLI 只写入带所有权标记的 `ucli-*.config.toml`，继续只读用户/CC Switch 管理的 `config.toml` 和 Codex `auth.json`。
- 诊断仅输出档案计数、健康状态、目录可写性和最近检查时间；保留 0.7.x Provider policy、会话恢复、Gateway 和安装升级行为。

### 已知限制

- 0.8.0 仅为 Codex 提供完整档案管理；Claude Code、OpenCode 和 U-Code 仍沿用系统配置。
- UCLI 不管理 OAuth/ChatGPT 登录态，不提供代理、协议转换、测速、熔断或自动故障转移。
- Windows 与 macOS 安装包仍未进行代码签名。

## [0.7.8] - 2026-08-06

### Added

- Codex 会话诊断新增“一键复制诊断信息”，通过固定字段白名单输出绑定状态和父子链，不包含项目路径、终端输出、提示词、消息内容或 transcript 文件。

### Changed

- GitHub Release 工作流升级到 Node.js 24 运行时兼容的 Actions 主版本，继续使用 Node.js 20 构建应用本身。
- 补充 1/2/4 分屏重启恢复以及 Windows 安装器路径级进程检测回归测试，覆盖混合 CLI 会话恢复和同名便携版误判场景。

## [0.7.7] - 2026-08-05

### Added

- Codex 分屏新增“诊断”入口，展示 UCLI 会话 ID、当前原生绑定、最新解析结果、项目目录和主会话父子链。
- 对检测到的旧 Codex 续接绑定提供一键修复，并将修复结果同时写入当前运行状态和本地数据库。

### Fixed

- 用户在 Codex 原生 `/resume` 中选择新会话后，工作台会立即显示并持久化新的原生会话 ID，不再继续展示旧绑定。

## [0.7.6] - 2026-08-05

### Fixed

- UCLI 启动时沿 Codex `forked_from_id` 主会话链解析并持久化最新续接 ID，避免恢复到旧上下文。
- Codex 原生 `/resume` 选择完成后自动更新 UCLI 绑定，同时排除 subagent 会话并保留 Gateway 新事件转发。

## [0.7.5] - 2026-08-05

### Fixed

- Restored Codex native session IDs from the earliest matching rollout file, so sessions resumed multiple times still reopen with their original context after restarting UCLI.
- Restored assigned workbench panes sequentially during startup, preventing one slow or failed CLI session from leaving other saved panes unopened.

## [0.7.4] - 2026-08-05

### Fixed

- Windows upgrades now close legacy same-name UCLI processes before invoking an older uninstaller, including hidden tray and path-unavailable remnants.
- The scoped installer process check now uses the extension-free PowerShell process name and is covered by real-process regression tests.

## [0.7.3] - 2026-08-05

### Fixed

- Windows NSIS upgrades now detect and close only `UCLI.exe` from the selected installation directory, avoiding false process conflicts with other UCLI installations or portable copies.

## [0.7.2] - 2026-08-04

### Fixed

- 补齐 Codex runtime 的 renderer IPC 转发，修复工作台启动时报 `ipc.getCodexRuntime is not a function`、从而中断会话与分屏恢复的问题。

## [0.7.1] - 2026-08-04

### Fixed

- 修复 UCLI 重启后工作台已有空窗格未回填保存会话的问题；2/4 分屏会直接恢复上次分配的会话，无需先切换分屏。

## [0.7.0] - 2026-08-04

### Added

- Codex 现在支持显式配置目录；优先级为 UCLI 设置、`CODEX_HOME`、用户目录下的 `.codex`。配置只读，UCLI 不会写入 CC Switch 或 Codex 的配置、认证和原生会话文件。
- Codex 会话可选择“来源 Provider”“跟随当前”或“显式指定”策略；设置页会显示已脱敏的当前 Provider 和可用 Provider，并监听外部配置变化。

### Changed

- 新建 Codex 会话默认跟随当前 live 配置，导入的历史会话默认保留来源 Provider；Provider 已不可用时会回退到当前配置并在界面提示。正在运行的会话不会因外部配置变化自动重启。

### Fixed

- UCLI 重启时会按工作目录和创建时间恢复缺失的 Codex 原生会话 ID，重新打开会话时使用 `codex resume <id>`，不再误建新会话。

## [0.6.0] - 2026-08-01

### Added

- 新增 U-Code 一等适配器，支持原生 TUI、新建/恢复、按工作目录发现历史会话、完整历史视图与 Gateway 转发。
- 设置页支持检测、安装和升级 `ucode`；安装与升级直接使用 `AllernChen/U-Code` 的 GitHub Latest Release 原生二进制，不依赖 npm。
- U-Code 支持 UCLI 三档权限映射，以及逐会话模型、Token、轮次与费用可用性统计。

### Changed

- OpenCode 系谱适配核心改为运行时配置，在共享权限、统计、历史和 Gateway 解析能力的同时，隔离 OpenCode 与 U-Code 的可执行文件、配置环境变量和原生会话数据。

### Fixed

- Codex Gateway 现在识别新版 `custom_tool_call` 审批事件，将 1/2/3 选项推送到飞书，并把飞书数字回复映射回 Codex TUI。

## [0.5.3] - 2026-07-31

### Added

- 终端链接支持点击直接打开，简化了链接处理逻辑。

## [0.5.2] - 2026-07-31

### Added

- 工作台左侧会话列表展示飞书转发状态；会话卡片与窗格使用飞书渠道图标。

### Fixed

- 新建飞书会话根卡后立即初始化可直接回复的话题，避免首次需要手动引用回复。
- 未选择转发的飞书图标灰度显示；已选择转发时恢复彩色状态。

## [0.5.1] - 2026-07-31

### Added

- 会话卡片和工作台窗格提供统一的 Gateway 转发快捷入口；全局 Gateway 开关仍只位于工作台头部。

### Fixed

- 明确区分会话“已选择”与“正在转发”状态，防止在 Gateway 未就绪时产生误导。
- 防止同一会话重复提交转发切换；失败后恢复服务端状态并显示错误提示。

## [0.5.0] - 2026-07-30

### Added

- 新增全球通信网关内核原语：网关通道、路由、适配器语义与配置持久化。
- 为 Claude Code、Codex CLI 和 OpenCode 暴露统一网关能力接口。
- 新增飞书（Feishu）入站网关通道与网关运行时集成。
- UCLI 工作台新增网关控制面板，支持查看和绑定飞书入站通道。

### Fixed

- 修复权限决策在网关场景下保持 pending 状态的问题。

## [0.4.10] - 2026-07-29

### Fixed

- Added visible software-update download progress, transfer details, and explicit installation handoff status.

## [0.4.9] - 2026-07-29

### Added

- 工作台每个会话窗格新增独立的完整历史视图；Claude Code、Codex 和 OpenCode 原生历史统一分页加载，可选择文本并独立滚动，切回后原生 TUI 状态保持不变。

### Fixed

- OpenCode complete-history views now use the local unsanitized export; statistics continue to use the sanitized export.
- Removed the global application header from the workbench while preserving its local workbench controls.
- 修复全屏 TUI 使用 xterm alternate buffer 时无法依靠终端 scrollback 查看早期对话的问题。
- 修复 OpenCode 恢复会话只显示当前 TUI 输出、未加载完整源会话历史的问题。
- 修复 2/4 分屏首次启动以及侧栏、分屏和全屏切换后 PTY 尺寸同步滞后导致的内容裁剪和重绘不完整。

## [0.4.8] - 2026-07-29

### Fixed

- Prevented Ctrl+V from being forwarded twice by the terminal key handler.
- Removed fixed Claude Code and Codex provider tags from the page header.

## [0.4.7] - 2026-07-28

### Added

- Settings now provides a safe support-diagnostics report with UCLI runtime, AI CLI availability, and local persistence status.
- Packaged installer builds can manually check, download, and install signed GitHub Release updates from Settings; portable and development builds remain manual-download only.

### Security

- Diagnostic exports deliberately exclude conversation content, session metadata, paths, logs, rules, secrets, and raw CLI output.

## [0.4.6] - 2026-07-28

### Added

- Configurable workbench and terminal keyboard shortcuts, including Tab / Shift+Tab pane switching and Ctrl-click session-to-new-pane.
- Ctrl-click (Windows/Linux) or Command-click (macOS) terminal web links, with main-process HTTP(S)-only external URL protection.
- Persisted window bounds, maximized state, navigation collapse, and workbench session-list visibility.

### Fixed

- Restoring a window saved on a disconnected display now falls back to a visible default window.
- Closing or removing a workbench pane now compacts remaining sessions safely and clears the persisted ID for a lone closed pane.
- Preserved macOS paste behavior and disabled/legacy-cleared shortcut compatibility.

## [0.4.5] - 2026-07-27

### Fixed

- OpenCode 历史会话恢复改为仅传递源会话 ID 启动原生 TUI，不再覆盖历史会话的模型与供应商配置；TUI 内仍可使用 `/session` 手动切换。
- 修复 OpenCode 1.18.x 因 `permission.webfetch`、`permission.websearch` 被生成为模式对象而报 `ConfigInvalid`；不支持细粒度模式的网络权限现在映射为整个工具的动作值。
- 修复 Windows 下从命令行或其他父进程启动 UCLI 后，父进程关闭输出管道会触发 `EPIPE: broken pipe` 并导致 Electron 主进程退出的问题。

## [0.4.4] - 2026-07-27

### Changed

- 工作台项目和会话列表改为按创建时间稳定排序，不再因会话活跃状态变化而跳动。
- 收窄默认高危规则，仅对递归删除、Git 推送和破坏性清理、发布、提权、递归权限修改、下载后执行以及敏感凭据修改等操作要求确认。
- 安全规则模式下，OpenCode 默认允许访问工作目录外；普通删除、`.env` 编辑和常规网络查询不再默认打断用户。

### Fixed

- 修复 OpenCode 无法转换默认 `curl/wget | shell` 正则时退化为所有 Bash 命令都要求确认的问题。
- 修复 Windows 命令规则大小写敏感，以及 `~/.aws/**` 等用户目录规则无法匹配绝对路径的问题。
- 升级时仅替换未修改过的 0.4.3 默认规则，保留用户自定义的安全策略。

## [0.4.3] - 2026-07-26

### Fixed

- 修复离开工作台页面后 xterm 实例被销毁、返回时对话内容消失；工作台现在跨路由保留终端滚动区，并在返回时重新适配窗格尺寸。

## [0.4.2] - 2026-07-26

### Fixed

- 修复 macOS 产物中的 `node-pty` `spawn-helper` 缺少可执行权限，导致新建 Codex、Claude Code 或 OpenCode 会话时报 `posix_spawnp failed`。
- macOS GUI 启动时恢复登录 Shell 的 `PATH`，使打包应用可以发现 `~/.npm-global/bin` 等终端配置中的 CLI 安装目录。

## [0.4.1] - 2026-07-26

### Added

- 新增 macOS DMG/ZIP 打包目标、平台对应的发布产物校验，以及本地构建说明。
- macOS 终端支持 `Command+C`/`Command+V`，并使用系统等宽字体作为首选。

### Changed

- `npm run dist` 改为构建当前操作系统产物，并保留 `dist:win`、`dist:mac` 显式命令。
- macOS 菜单栏托盘图标使用模板图像，以适配浅色和深色外观。

## [0.4.0] - 2026-07-24

### Added

- OpenCode 原生 TUI、历史发现/恢复、会话级权限映射，以及逐会话模型、Token、轮次统计。
- 费用可用性语义：官方导出未提供费用时显示“不可用”，与真实 `$0` 区分。

### Fixed

- OpenCode 安全规则改为官方 `OPENCODE_CONFIG_CONTENT` 覆盖，项目配置不能绕过当前会话的安全档位。
- OpenCode 历史发现兼容 Windows 路径大小写、分隔符、中文目录与异常输出，并限制为最近 30 条。

### Release artifacts

- `UCLI-Setup-0.4.0-x64.exe` — SHA-256: `D393388E7AC867C91AEC029CEEC1F10F31424A52854FC39AC7E39EC7DD708A34`
- `UCLI-Portable-0.4.0-x64.exe` — SHA-256: `A5DF275763C58C4C8E6C5A1DA5CEE084FB75928DD5AA72AF36A078B34B37B983`

### Added

- 新增 OpenCode 原生 TUI 适配器，支持新建、停止、恢复和多窗格交互。
- 设置页支持检测、安装和升级 OpenCode。
- 通过 `opencode session list --format json` 按工作目录发现并导入 OpenCode 历史会话。
- 将 UCLI 三档安全模式和规则映射到 OpenCode 原生权限配置，并继续强制危险命令黑名单。
- 新增 Windows OpenCode PTY 冒烟测试；npm 安装场景会绕过在 ConPTY 中阻塞的 `opencode.cmd`，直接启动真实 EXE。

## [0.3.1] - 2026-07-24

### Added

- 新增日志模块 (`electron/logger.js`)：记录主进程执行路径到 `ucli.log`，方便排查工作台布局持久化等运行时问题。
- 新增 `log:write` IPC 通道：允许渲染进程通过主进程日志模块统一写日志。

### Changed

- 工作台布局持久化流程增加详细日志：跟踪 `saveWorkbench` / `loadWorkbench` 调用、IPC 传输、DB 写入和磁盘刷新全过程。
- `saveWorkbench` / `loadWorkbench` 不再静默吞错误——所有异常记录到日志。

## [0.3.0] - 2026-07-24

### Added

- 支持会话名称编辑：在会话卡片和工作台侧边栏点击名称即可重命名，实时持久化到数据库。
- 工作台布局持久化：分屏数、窗格会话分配在重启后自动恢复，不再需要每次手动设置。

### Changed

- 会话卡片重新设计：精简短 ID，合并目录和时间行，减少视觉分割线，整体更清爽。
- 工作台顶部工具栏简化：按钮更紧凑，筛选器缩小，卡片网格自适应列宽。

## [0.2.1] - 2026-07-23

### Added

- 新增数据库只读诊断脚本和 Windows 发布验收命令。
- 新增数据库损坏恢复提示，显示损坏文件的保留位置和备份恢复结果。
- 全部页面支持将 UCLI 菜单导航收缩为图标栏，工作台会话列表可独立隐藏。
- 工作台支持单个会话窗格全屏，以及保持 2/4 窗格布局的分屏整体全屏；可通过按钮或 `Esc` 退出。
- UCLI 隐藏、最小化或失去焦点时，Claude/Codex 的人工审批、用户输入请求和本轮任务完成都会触发 Windows 原生通知；通知显示会话与操作类型，点击后直接定位到工作台对应会话。

### Fixed

- 修复全零、截断、非 SQLite 或内部页损坏的 `ucli.db` 导致导入会话报 `file is not a database`。
- 数据库只有在完成初始化后才发布给会话 IPC，避免损坏实例泄漏到 `session:create`。
- 损坏主库自动隔离为带时间戳的 `.corrupt-*.bak`，优先恢复上一份有效 `ucli.db.bak`。
- 数据库保存改为同目录临时文件落盘后原子替换，并保留紧邻上一版有效快照。
- 修复 2、4 窗格下无法向上滚动查看历史内容：分屏切换保留原终端缓冲，Codex 使用保留 scrollback 的 inline 模式。
- 修复 Codex 原生 TUI 审批未进入 UCLI 通知链路、Claude 持续输出时完成扫描被反复推迟，以及同一次完成被多个信号重复通知的问题。

### Release artifacts

- `UCLI-Setup-0.2.1-x64.exe`
  - SHA-256: `D401E84BC79799622288AD504A8F6154F1C3DC6A01516715C8A0446F202052DE`
- `UCLI-Portable-0.2.1-x64.exe`
  - SHA-256: `8FE81C4999BD39450E9A4CE4F0DD0060F5178D19A92C95FD249BB221C84B4D6F`

## [0.2.0] - 2026-07-22

### Added

- 新增 1、2、4 窗格多会话工作台和 `Tab`/`Shift+Tab` 会话切换。
- 新增 Windows 托盘、单实例唤回和退出清理。
- 新增 CLI 检测、安装和升级入口。
- 新增 UCLI Logo，用于应用、窗口、托盘和安装包。
- 新增会话、模型、Token、费用和审批统计留痕。

### Changed

- 移除会话改为软删除：从工作台隐藏，但保留原生会话和历史统计。
- Codex 历史 provider 不可用时回退到当前可用 provider。
- 开发版与安装版使用独立数据目录、缓存目录和单实例锁。

### Fixed

- 修复 Claude Code 中文工作目录历史会话无法发现或回放的问题。
- 修复 Codex provider 已失效时无法恢复历史会话的问题。
- 修复 Codex TUI 持续刷新导致原生会话 ID 与统计扫描长期推迟的问题。
- 修复工作台高度持续增长、布局切换后终端不回放等多会话交互问题。
- 修复 Electron preload 模块格式和 Windows Chromium 缓存启动问题。

### Release artifacts

- `UCLI-Setup-0.2.0-x64.exe`
  - SHA-256: `F0E35EA0324AF021DC3097FD84FFCD2BFCBF67A35B8E05EB4EB92734F71F8021`
- `UCLI-Portable-0.2.0-x64.exe`
  - SHA-256: `E1DCC8F286F19DD4B73C8CF1C04ABBB3742895E4519420872A7CD49924C5384D`

### Known limitations

- 当前发布目标为 Windows x64。
- 当前 Windows 产物未进行代码签名，可能触发 SmartScreen 提示。
