# UCLI 用户手册实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一份面向所有用户的 UCLI 完整参考手册，自包含 HTML 格式，含 22 张操作截图。

**Architecture:** 先截取全部 UI 截图（启动 dev server → 逐页面操作截图），再基于截图编写 Markdown 手册内容，最终构建为自包含 HTML 文件（base64 内联图片 + 内联 CSS/JS）。

**Tech Stack:** Electron + Vue 3 dev server（截图源）、Markdown（内容源）、内联 HTML/CSS/JS（最终产物）

## Global Constraints

- 语言：纯中文
- 输出：单个自包含 HTML 文件，无外部依赖
- 截图：22 张，覆盖所有页面、弹窗、抽屉和关键交互状态
- 写作风格：平实、专业，操作步骤动词开头
- 每章节 500-800 字，功能概述 2-3 句

## File Structure

```
docs/user-manual/
├── UCLI-用户手册.md            # Markdown 源文件（可编辑）
├── UCLI-用户手册.html          # 最终自包含 HTML（构建产物）
└── screenshots/                # 截图目录（22 张 PNG）
```

---

### Task 1: 创建目录结构

**Files:**
- Create: `docs/user-manual/screenshots/` (目录)
- Create: `docs/user-manual/UCLI-用户手册.md` (空文件占位)

- [ ] **Step 1: 创建目录和占位文件**

```bash
mkdir -p docs/user-manual/screenshots
touch docs/user-manual/UCLI-用户手册.md
```

- [ ] **Step 2: 验证目录结构**

```bash
ls -la docs/user-manual/
```

Expected: 看到 `screenshots/` 目录和 `UCLI-用户手册.md` 文件。

- [ ] **Step 3: Commit**

```bash
git add docs/user-manual/
git commit -m "docs(user-manual): create manual directory structure"
```

---

### Task 2: 启动开发服务器并验证可用

**Files:**
- 无新建文件

- [ ] **Step 1: 安装依赖（如未安装）**

```bash
cd F:/projects/ucli
npm install
```

- [ ] **Step 2: 启动开发服务器**

```bash
npm run dev
```

等待 Electron 窗口打开，确认应用正常加载，看到工作台页面。

- [ ] **Step 3: 确认窗口可截图**

在终端中确认 dev server 输出无错误，Electron 窗口可见。此步骤不提交——dev server 是临时运行的。

---

### Task 3: 截取主页面截图（8 张）

**Files:**
- Create: `docs/user-manual/screenshots/workbench-overview.png`
- Create: `docs/user-manual/screenshots/session-workbench.png`
- Create: `docs/user-manual/screenshots/stats-overview.png`
- Create: `docs/user-manual/screenshots/rules-editor.png`
- Create: `docs/user-manual/screenshots/profiles-center.png`
- Create: `docs/user-manual/screenshots/skills-center.png`
- Create: `docs/user-manual/screenshots/settings-general.png`
- Create: `docs/user-manual/screenshots/summary-overview.png`

**前置条件：** dev server 正在运行（Task 2）

- [ ] **Step 1: 截图 #1 — 工作台首页（workbench-overview.png）**

确保 Electron 窗口在工作台页面（`#/`）。如有会话数据则展示项目分组视图；如为空则截取空状态（带"还没有会话"提示）。截图保存到 `docs/user-manual/screenshots/workbench-overview.png`。

- [ ] **Step 2: 截图 #2 — 会话工作台（session-workbench.png）**

导航到会话工作台（`#/session`）。截取包含左侧会话列表和右侧窗格的完整布局。如无会话，创建一个测试会话后再截图。保存为 `session-workbench.png`。

- [ ] **Step 3: 截图 #3 — 统计页（stats-overview.png）**

导航到统计页（`#/stats`）。截取包含总览卡片（输入/输出 Tokens、费用、总轮次）和审批分布的页面。保存为 `stats-overview.png`。

- [ ] **Step 4: 截图 #4 — 规则页（rules-editor.png）**

导航到规则页（`#/rules`）。截取三栏编辑器（拒绝/高危/允许）、模式测试器和硬黑名单区域。保存为 `rules-editor.png`。

- [ ] **Step 5: 截图 #5 — 配置档案页（profiles-center.png）**

导航到配置档案页（`#/profiles`）。截取 CLI 切换卡片和 Profile 列表区域。保存为 `profiles-center.png`。

- [ ] **Step 6: 截图 #6 — Skills 中心（skills-center.png）**

导航到 Skills 中心（`#/skills`）。截取全部/组织/本地切换和 Skills 列表。保存为 `skills-center.png`。

- [ ] **Step 7: 截图 #7 — 设置页（settings-general.png）**

导航到设置页（`#/settings`）。截取通用设置区块（默认 CLI、权限模式、工作目录等）。保存为 `settings-general.png`。

- [ ] **Step 8: 截图 #8 — 工作总结（summary-overview.png）**

导航到统计页的「工作总结」标签页。截取报告列表和详情视图。保存为 `summary-overview.png`。

- [ ] **Step 9: 验证所有 8 张截图存在**

```bash
ls -la docs/user-manual/screenshots/*.png | wc -l
```

Expected: 8 个文件。

- [ ] **Step 10: Commit**

```bash
git add docs/user-manual/screenshots/
git commit -m "docs(user-manual): add main page screenshots (8 images)"
```

---

### Task 4: 截取弹窗截图（7 张）

**Files:**
- Create: `docs/user-manual/screenshots/dialog-new-session.png`
- Create: `docs/user-manual/screenshots/dialog-session-config.png`
- Create: `docs/user-manual/screenshots/dialog-rename.png`
- Create: `docs/user-manual/screenshots/dialog-summary-generate.png`
- Create: `docs/user-manual/screenshots/dialog-summary-edit.png`
- Create: `docs/user-manual/screenshots/dialog-html-export.png`
- Create: `docs/user-manual/screenshots/dialog-server-register.png`

**前置条件：** dev server 正在运行

- [ ] **Step 1: 截图 #9 — 新建会话弹窗（dialog-new-session.png）**

在工作台页面点击「新建」按钮，等待弹窗完全展开。截取包含会话名称、工作目录选择、历史会话发现区域的完整弹窗。保存为 `dialog-new-session.png`。截图后关闭弹窗。

- [ ] **Step 2: 截图 #10 — 会话配置弹窗（dialog-session-config.png）**

在工作台或会话工作台中，点击某个会话卡片的齿轮图标。截取包含会话信息、运行配置、维护操作的完整弹窗。保存为 `dialog-session-config.png`。截图后关闭弹窗。

- [ ] **Step 3: 截图 #11 — 重命名弹窗（dialog-rename.png）**

在工作台中，点击某个会话卡片的「更多操作」菜单，选择「重命名」。截取重命名弹窗。保存为 `dialog-rename.png`。截图后关闭弹窗。

- [ ] **Step 4: 截图 #12 — 生成总结弹窗（dialog-summary-generate.png）**

导航到统计页 → 工作总结标签页，点击「生成总结」按钮。截取包含时间范围、会话选择的弹窗。保存为 `dialog-summary-generate.png`。截图后关闭弹窗。

- [ ] **Step 5: 截图 #13 — 编辑任务弹窗（dialog-summary-edit.png）**

如有已有总结报告，点击编辑按钮打开编辑弹窗。截取编辑任务弹窗。保存为 `dialog-summary-edit.png`。截图后关闭弹窗。如无已有报告，创建一个后再编辑。

- [ ] **Step 6: 截图 #14 — HTML 导出样式弹窗（dialog-html-export.png）**

在总结报告详情中点击「导出 HTML」按钮。截取 HTML 样式选择弹窗。保存为 `dialog-html-export.png`。截图后关闭弹窗。

- [ ] **Step 7: 截图 #15 — 服务端注册确认弹窗（dialog-server-register.png）**

导航到设置页 → 服务端连接区块。如有注册确认流程，截取确认弹窗。如无法触发，截取服务端连接面板本身并标注说明。保存为 `dialog-server-register.png`。

- [ ] **Step 8: 验证截图数量**

```bash
ls docs/user-manual/screenshots/dialog-*.png | wc -l
```

Expected: 7 个文件。

- [ ] **Step 9: Commit**

```bash
git add docs/user-manual/screenshots/dialog-*.png
git commit -m "docs(user-manual): add dialog screenshots (7 images)"
```

---

### Task 5: 截取抽屉截图（4 张）

**Files:**
- Create: `docs/user-manual/screenshots/drawer-gateway-config.png`
- Create: `docs/user-manual/screenshots/drawer-claude-profile.png`
- Create: `docs/user-manual/screenshots/drawer-summary-conversation.png`
- Create: `docs/user-manual/screenshots/drawer-artifact-preview.png`

**前置条件：** dev server 正在运行

- [ ] **Step 1: 截图 #16 — Gateway 配置抽屉（drawer-gateway-config.png）**

导航到设置页 → 通信 Gateway 区块，点击「配置」按钮打开抽屉。截取包含 App ID/Secret 输入、飞书绑定信息的完整抽屉。保存为 `drawer-gateway-config.png`。截图后关闭抽屉。

- [ ] **Step 2: 截图 #17 — Claude Profile 抽屉（drawer-claude-profile.png）**

导航到配置档案页，选择 Claude CLI，点击某个 Profile 的查看详情按钮打开抽屉。截取 Profile 详情抽屉。保存为 `drawer-claude-profile.png`。截图后关闭抽屉。

- [ ] **Step 3: 截图 #18 — 总结对话记录抽屉（drawer-summary-conversation.png）**

在工作总结页面，点击某个报告的「查看对话」按钮打开抽屉。截取对话记录抽屉。保存为 `drawer-summary-conversation.png`。截图后关闭抽屉。

- [ ] **Step 4: 截图 #19 — 产物预览抽屉（drawer-artifact-preview.png）**

在会话工作台中，点击某个窗格的「产物」按钮打开抽屉。截取产物预览抽屉（可能包含图片/文本/Markdown/HTML 预览）。保存为 `drawer-artifact-preview.png`。截图后关闭抽屉。

- [ ] **Step 5: 验证截图数量**

```bash
ls docs/user-manual/screenshots/drawer-*.png | wc -l
```

Expected: 4 个文件。

- [ ] **Step 6: Commit**

```bash
git add docs/user-manual/screenshots/drawer-*.png
git commit -m "docs(user-manual): add drawer screenshots (4 images)"
```

---

### Task 6: 截取关键交互状态截图（3 张）

**Files:**
- Create: `docs/user-manual/screenshots/interaction-approval.png`
- Create: `docs/user-manual/screenshots/interaction-batch-select.png`
- Create: `docs/user-manual/screenshots/interaction-split-pane.png`

**前置条件：** dev server 正在运行

- [ ] **Step 1: 截图 #20 — 审批确认面板（interaction-approval.png）**

在会话工作台中，如有会话处于「待确认」状态，截取审批确认面板（显示工具名、命令内容、允许/拒绝按钮）。如无法触发真实审批状态，截取 ApprovalPanel 组件的 UI 展示区域并标注。保存为 `interaction-approval.png`。

- [ ] **Step 2: 截图 #21 — 批量选择模式（interaction-batch-select.png）**

在工作台页面点击「多选」按钮进入批量选择模式。截取包含全选、批量删除、批量停止按钮的批量操作栏，以及会话卡片上的复选框状态。保存为 `interaction-batch-select.png`。截图后退出批量模式。

- [ ] **Step 3: 截图 #22 — 2 窗格分屏布局（interaction-split-pane.png）**

在会话工作台中，将分屏数切换为 2，分配两个不同会话到两个窗格。截取 2 窗格分屏布局。保存为 `interaction-split-pane.png`。

- [ ] **Step 4: 验证总截图数量**

```bash
ls docs/user-manual/screenshots/*.png | wc -l
```

Expected: 22 个文件（8 主页面 + 7 弹窗 + 4 抽屉 + 3 交互状态）。

- [ ] **Step 5: Commit**

```bash
git add docs/user-manual/screenshots/interaction-*.png
git commit -m "docs(user-manual): add interaction state screenshots (3 images)"
```

---

### Task 7: 编写手册 Markdown — 快速入门（第 1 章）

**Files:**
- Modify: `docs/user-manual/UCLI-用户手册.md`

**Interfaces:**
- Consumes: `screenshots/workbench-overview.png`（界面总览截图）
- Produces: Markdown 源文件第 1 章内容

- [ ] **Step 1: 编写手册头部和目录**

在 `UCLI-用户手册.md` 顶部写入手册标题、版本号、更新日期，以及完整的目录（链接到各章节锚点）。

```markdown
# UCLI 用户手册

> 版本：v0.12.1 | 更新日期：2026-09-02

## 目录

- [1. 快速入门](#1-快速入门)
  - [1.1 系统要求与安装](#11-系统要求与安装)
  - [1.2 首次启动与界面总览](#12-首次启动与界面总览)
  - [1.3 核心概念](#13-核心概念)
- [2. 功能详解](#2-功能详解)
  ...
- [3. 附录](#3-附录)
  ...
```

- [ ] **Step 2: 编写 1.1 系统要求与安装**

内容要求：
- 系统要求：Windows 10/11，Node.js 18+，Claude/Codex CLI 已安装并在 PATH 中
- 安装步骤：下载安装包 → 运行 NSIS 安装程序 → 首次启动
- 便携版说明：解压 `win-unpacked/` 直接运行
- 截图：无（纯文字说明）

- [ ] **Step 3: 编写 1.2 首次启动与界面总览**

内容要求：
- 启动后默认进入工作台页面
- 界面五大区域说明：左侧导航栏、顶部工具栏、主内容区、状态指示
- 截图引用：`![界面总览](screenshots/workbench-overview.png)` 并用文字标注各区域

- [ ] **Step 4: 编写 1.3 核心概念**

内容要求：
- **会话**：一个 AI CLI 进程实例，有独立的工作目录、权限模式和统计
- **适配器（Adapter）**：UCLI 支持的 AI CLI 类型（Claude Code、Codex、OpenCode、U-Code、DeepSeek Harness）
- **权限三档**：一直同意（除黑名单全放行）、安全规则（规则匹配拦截）、逐次确认（每步都问）
- **配置档案（Profile）**：不同项目/会话可使用独立的 API 密钥和模型配置
- 无截图（概念说明）

- [ ] **Step 5: Commit**

```bash
git add docs/user-manual/UCLI-用户手册.md
git commit -m "docs(user-manual): write chapter 1 — quick start"
```

---

### Task 8: 编写手册 Markdown — 工作台与会话工作台（2.1-2.2）

**Files:**
- Modify: `docs/user-manual/UCLI-用户手册.md`

**Interfaces:**
- Consumes: `screenshots/workbench-overview.png`, `screenshots/session-workbench.png`, `screenshots/dialog-new-session.png`, `screenshots/dialog-session-config.png`, `screenshots/dialog-rename.png`, `screenshots/drawer-artifact-preview.png`, `screenshots/interaction-approval.png`, `screenshots/interaction-batch-select.png`, `screenshots/interaction-split-pane.png`

- [ ] **Step 1: 编写 2.1 工作台**

内容要求：
- 概述：工作台是 UCLI 的首页，按项目和 CLI 类型分组展示所有会话
- 界面说明：工具栏（新建/多选/筛选/全部展开收起）、项目分组头部、CLI 分组、会话卡片
- 操作步骤：
  1. 新建会话：点击「新建」→ 选择工作目录 → 选择 CLI 类型 → 配置 Profile → 确认
  2. 批量操作：点击「多选」→ 勾选会话 → 批量删除/停止
  3. 筛选会话：按权限模式筛选
  4. 打开项目目录：点击项目头部的导出图标
  5. 重命名/配置会话：卡片右上角菜单
- 截图引用：workbench-overview.png, dialog-new-session.png, dialog-rename.png, interaction-batch-select.png

- [ ] **Step 2: 编写 2.2 会话工作台**

内容要求：
- 概述：会话工作台是核心交互界面，支持分屏同时操作多个会话
- 界面说明：左侧会话列表（可折叠）、右侧分屏窗格（1/2/4 窗格）、顶部控制栏
- 操作步骤：
  1. 分配会话到窗格：点击左侧会话 → 分配到当前活动窗格
  2. 切换分屏数：点击 1/2/4 单选按钮
  3. 切换活动窗格：按 Tab 键
  4. 查看产物：点击窗格头部的产物按钮打开预览抽屉
  5. 处理审批：当会话等待确认时，审批面板自动出现在窗格内，点击「允许」或「拒绝」
  6. 导入已有会话：点击「导入」按钮
  7. 全屏分屏：点击「分屏全屏」按钮
- 截图引用：session-workbench.png, drawer-artifact-preview.png, interaction-approval.png, interaction-split-pane.png

- [ ] **Step 3: Commit**

```bash
git add docs/user-manual/UCLI-用户手册.md
git commit -m "docs(user-manual): write chapters 2.1-2.2 — workbench & session workbench"
```

---

### Task 9: 编写手册 Markdown — 统计与规则（2.3-2.4）

**Files:**
- Modify: `docs/user-manual/UCLI-用户手册.md`

**Interfaces:**
- Consumes: `screenshots/stats-overview.png`, `screenshots/rules-editor.png`

- [ ] **Step 1: 编写 2.3 统计**

内容要求：
- 概述：统计页汇总所有会话的 Token 用量、费用和审批数据
- 两个标签页：使用统计、工作总结
- 使用统计界面说明：总览卡片（输入/输出 Tokens、费用、总轮次）、审批分布（自动放行/人工确认/已拒绝）、按模型表格、按项目表格、按会话表格
- 操作步骤：
  1. 查看总览数据
  2. 按模型/项目/会话维度分析
  3. 刷新数据
- 截图引用：stats-overview.png

- [ ] **Step 2: 编写 2.4 规则**

内容要求：
- 概述：规则页用于配置权限拦截规则，决定哪些工具操作被拒绝、需要确认或自动放行
- 界面说明：三栏编辑器（拒绝/高危/允许）、模式测试器、硬黑名单（只读）
- 操作步骤：
  1. 编辑规则：在对应栏的文本框中每行写一条规则
  2. 保存规则：点击「保存规则」
  3. 测试规则：在模式测试器中输入规则模式和样例命令，点击「测试」查看是否匹配
  4. 查看硬黑名单：不可编辑，所有模式都强制拦截
- 截图引用：rules-editor.png

- [ ] **Step 3: Commit**

```bash
git add docs/user-manual/UCLI-用户手册.md
git commit -m "docs(user-manual): write chapters 2.3-2.4 — stats & rules"
```

---

### Task 10: 编写手册 Markdown — 配置档案与 Skills（2.5-2.6）

**Files:**
- Modify: `docs/user-manual/UCLI-用户手册.md`

**Interfaces:**
- Consumes: `screenshots/profiles-center.png`, `screenshots/skills-center.png`, `screenshots/drawer-claude-profile.png`

- [ ] **Step 1: 编写 2.5 配置档案**

内容要求：
- 概述：配置档案页管理各 AI CLI 的独立配置，支持为不同项目选择不同 API 密钥和模型
- 界面说明：CLI 切换卡片（Claude/Codex/DSH 等）、Profile 列表、DSH 运行时管理
- 操作步骤：
  1. 切换 CLI 查看对应的 Profile 列表
  2. 查看 Profile 详情（打开抽屉）
  3. 初始化 DSH Profile
  4. 在新建会话时选择 Profile
- 截图引用：profiles-center.png, drawer-claude-profile.png

- [ ] **Step 2: 编写 2.6 Skills 中心**

内容要求：
- 概述：Skills 中心统一管理各 CLI 的可复用能力（插件/技能）
- 界面说明：三个视图切换（全部/组织/本地）、项目范围选择、组织 Skills 目录同步
- 操作步骤：
  1. 查看已安装 Skills 列表
  2. 安装组织 Skills：从组织目录同步并安装
  3. 安装本地 Skills
  4. 切换项目范围查看不同项目的 Skills
- 截图引用：skills-center.png

- [ ] **Step 3: Commit**

```bash
git add docs/user-manual/UCLI-用户手册.md
git commit -m "docs(user-manual): write chapters 2.5-2.6 — profiles & skills"
```

---

### Task 11: 编写手册 Markdown — 设置（2.7）

**Files:**
- Modify: `docs/user-manual/UCLI-用户手册.md`

**Interfaces:**
- Consumes: `screenshots/settings-general.png`, `screenshots/drawer-gateway-config.png`, `screenshots/dialog-server-register.png`

- [ ] **Step 1: 编写 2.7.1 通用设置**

内容要求：
- 默认 CLI 选择、默认权限模式、默认工作目录
- Codex 配置目录、Codex Provider 查看
- 语言切换（简体中文/English）
- 截图引用：settings-general.png

- [ ] **Step 2: 编写 2.7.2 通信 Gateway（飞书集成）**

内容要求：
- 概述：Gateway 将会话事件转发到飞书，支持远程监控和决策
- 操作步骤：配置 App ID/Secret → 测试连接 → 保存并应用 → 在飞书发送"绑定 UCLI"完成绑定 → 选择要转发的会话
- 安全说明：仅转发用户决策、方案摘要和任务完成事件
- 截图引用：drawer-gateway-config.png

- [ ] **Step 3: 编写 2.7.3 CLI 管理**

内容要求：
- 检测本机 PATH 中的 AI CLI
- 安装/升级 CLI 的操作（会显示完整命令并确认）
- 截图引用：settings-general.png（CLI 管理在同一页面）

- [ ] **Step 4: 编写 2.7.4 服务端连接**

内容要求：
- 概述：连接企业服务端，获取组织 Skills、模型目录和配置同步
- 操作步骤：粘贴连接链接 → 连接 → 查看组织信息 → 同步/断开
- 截图引用：dialog-server-register.png

- [ ] **Step 5: 编写 2.7.5 软件更新**

内容要求：
- 检查更新 → 下载更新 → 重启并安装
- 不支持应用内更新的版本说明（需从 GitHub Release 下载）
- 无额外截图（在设置页截图中已包含）

- [ ] **Step 6: 编写 2.7.6 存储管理**

内容要求：
- 查看 UCLI 数据存储占用
- 清理历史数据
- 无额外截图

- [ ] **Step 7: Commit**

```bash
git add docs/user-manual/UCLI-用户手册.md
git commit -m "docs(user-manual): write chapter 2.7 — settings"
```

---

### Task 12: 编写手册 Markdown — 工作总结（2.8）

**Files:**
- Modify: `docs/user-manual/UCLI-用户手册.md`

**Interfaces:**
- Consumes: `screenshots/summary-overview.png`, `screenshots/dialog-summary-generate.png`, `screenshots/dialog-summary-edit.png`, `screenshots/dialog-html-export.png`, `screenshots/drawer-summary-conversation.png`

- [ ] **Step 1: 编写 2.8 工作总结**

内容要求：
- 概述：按周期生成结构化工作总结，支持编辑、版本管理和多格式导出
- 界面说明：左侧报告列表、右侧详情视图、版本历史
- 操作步骤：
  1. 生成总结：点击「生成总结」→ 选择时间范围和会话 → 确认生成
  2. 查看总结详情：点击左侧报告条目
  3. 编辑任务：点击编辑按钮修改总结内容
  4. 查看对话记录：点击查看对话抽屉
  5. 导出：支持 Markdown 和 HTML 两种格式导出
  6. 版本管理：查看历史版本、设置当前版本、重试失败的生成
- 截图引用：summary-overview.png, dialog-summary-generate.png, dialog-summary-edit.png, dialog-html-export.png, drawer-summary-conversation.png

- [ ] **Step 2: Commit**

```bash
git add docs/user-manual/UCLI-用户手册.md
git commit -m "docs(user-manual): write chapter 2.8 — work summaries"
```

---

### Task 13: 编写手册 Markdown — 附录（第 3 章）

**Files:**
- Modify: `docs/user-manual/UCLI-用户手册.md`

- [ ] **Step 1: 编写 3.1 规则模式语法速查**

内容要求：
- 完整的规则语法表格，从 `classifier.js` 和 CLAUDE.md 中提取：
  - `Bash(rm:*)` 前缀匹配
  - `Bash(re:git\s+push.*--force)` 正则匹配
  - `Edit(src/**)` glob 匹配文件路径
  - `Write(~/.ssh/**)` glob（支持 ~ 展开）
  - `Read(/etc/**)` glob 匹配路径
  - `WebFetch(github.com)` host 后缀匹配
  - `re:<regex>` 裸正则
  - `<glob>` 裸 glob
- 每种模式配一个示例

- [ ] **Step 2: 编写 3.2 快捷键一览**

内容要求：
- 从 UI 代码中提取的快捷键：
  - `Tab` — 在会话工作台中切换窗格
  - 其他发现的快捷键
- 以表格形式呈现

- [ ] **Step 3: 编写 3.3 常见问题 FAQ**

内容要求：
- 10 个常见问题，从功能逻辑推导：
  1. 如何同时管理多个项目的会话？
  2. 权限三档有什么区别？
  3. 如何导入已有的 Claude/Codex 会话？
  4. Token 统计不准确怎么办？
  5. 如何为不同项目使用不同的 API Key？
  6. Gateway 连接失败怎么排查？
  7. 如何批量删除会话？
  8. 工作总结生成失败怎么办？
  9. 如何升级 CLI 工具？
  10. 数据存储在哪里？如何清理？

- [ ] **Step 4: Commit**

```bash
git add docs/user-manual/UCLI-用户手册.md
git commit -m "docs(user-manual): write chapter 3 — appendix (syntax, shortcuts, FAQ)"
```

---

### Task 14: 构建自包含 HTML 文件

**Files:**
- Create: `docs/user-manual/UCLI-用户手册.html`（从 Markdown 构建）

**Interfaces:**
- Consumes: `docs/user-manual/UCLI-用户手册.md`（完整 Markdown 源）
- Consumes: `docs/user-manual/screenshots/*.png`（22 张截图）
- Produces: `docs/user-manual/UCLI-用户手册.html`（自包含 HTML）

- [ ] **Step 1: 创建 HTML 构建脚本**

编写一个 Node.js 脚本 `docs/user-manual/build.mjs`，功能：
1. 读取 `UCLI-用户手册.md`
2. 将 Markdown 转换为 HTML（使用 marked 库或手写简单转换）
3. 将所有 `screenshots/*.png` 引用替换为 base64 data URI
4. 内联 CSS 样式（侧边栏导航、响应式布局、打印样式、UCLI 品牌色调）
5. 内联 JS（侧边栏折叠/展开、当前位置高亮、锚点跳转）
6. 输出到 `UCLI-用户手册.html`

```bash
# 安装构建依赖（仅开发用）
npm install --save-dev marked
```

- [ ] **Step 2: 编写 HTML 模板样式**

CSS 要求：
- 左侧固定侧边栏目录（240px 宽），可折叠
- 主内容区自适应宽度，max-width 900px
- 浅色主题，UCLI 蓝色主调
- 截图响应式（max-width: 100%）
- 表格清晰美观
- `@media print` 隐藏侧边栏，内容全宽
- 移动端侧边栏折叠为顶部汉堡菜单

- [ ] **Step 3: 运行构建脚本**

```bash
node docs/user-manual/build.mjs
```

验证输出文件 `UCLI-用户手册.html` 存在且大小合理（预计含 base64 图片后 5-15MB）。

- [ ] **Step 4: 在浏览器中验证 HTML 文件**

用浏览器打开 `docs/user-manual/UCLI-用户手册.html`，检查：
- 侧边栏目录正常显示和跳转
- 所有 22 张截图正常渲染
- 响应式布局在不同宽度下正常
- 打印预览正常

- [ ] **Step 5: Commit**

```bash
git add docs/user-manual/build.mjs docs/user-manual/UCLI-用户手册.html
git commit -m "docs(user-manual): build self-contained HTML manual with embedded screenshots"
```

---

### Task 15: 最终审查与清理

**Files:**
- Modify: `docs/user-manual/UCLI-用户手册.md`（如需修正）
- Modify: `docs/user-manual/UCLI-用户手册.html`（如需重建）

- [ ] **Step 1: 内容完整性检查**

逐章检查 Markdown 源文件：
- [ ] 所有 3 个一级章节（快速入门、功能详解、附录）存在
- [ ] 所有子章节（1.1-1.3, 2.1-2.8, 3.1-3.3）内容完整
- [ ] 所有 22 张截图引用正确（路径和文件名匹配）
- [ ] 目录链接锚点正确
- [ ] 无 TODO/TBD 占位符

- [ ] **Step 2: 截图完整性检查**

```bash
ls docs/user-manual/screenshots/*.png | wc -l
```

Expected: 22。逐一确认每张截图内容正确（不是空白或错误页面）。

- [ ] **Step 3: 重新构建 HTML（如有修改）**

```bash
node docs/user-manual/build.mjs
```

- [ ] **Step 4: 最终 Commit**

```bash
git add docs/user-manual/
git commit -m "docs(user-manual): finalize user manual — all 22 screenshots, complete content"
```
