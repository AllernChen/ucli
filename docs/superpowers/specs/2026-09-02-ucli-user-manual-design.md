# UCLI 用户手册设计规格

## 概述

为 UCLI 创建一份面向所有用户的完整参考手册，以单个自包含 HTML 文件输出，包含约 22 张操作截图。

- **目标读者**：终端用户、新用户、团队管理员（所有人）
- **语言**：纯中文
- **输出格式**：单个自包含 HTML 文件（`docs/user-manual/UCLI-用户手册.html`）
- **源文件**：`docs/user-manual/UCLI-用户手册.md`（可编辑 Markdown 源）
- **截图目录**：`docs/user-manual/screenshots/`

## 目录结构

```
UCLI 用户手册
│
├── 1. 快速入门
│   ├── 1.1 系统要求与安装
│   ├── 1.2 首次启动与界面总览
│   └── 1.3 核心概念（会话、适配器、权限三档）
│
├── 2. 功能详解
│   ├── 2.1 工作台 — 会话总览与项目管理
│   ├── 2.2 会话工作台 — 交互式编码环境
│   ├── 2.3 统计 — Token 用量与费用追踪
│   ├── 2.4 规则 — 权限规则配置
│   ├── 2.5 配置档案 — 多 CLI Profile 管理
│   ├── 2.6 Skills 中心 — 可复用能力管理
│   ├── 2.7 设置
│   │   ├── 2.7.1 通用设置
│   │   ├── 2.7.2 通信 Gateway（飞书集成）
│   │   ├── 2.7.3 CLI 管理
│   │   ├── 2.7.4 服务端连接
│   │   ├── 2.7.5 软件更新
│   │   └── 2.7.6 存储管理
│   └── 2.8 工作总结
│
└── 3. 附录
    ├── 3.1 规则模式语法速查
    ├── 3.2 快捷键一览
    └── 3.3 常见问题 FAQ
```

## 每章节标准结构

```
章节标题
├── 功能概述（1-2 段，说明用途和价值）
├── 界面说明（带标注截图，标出各区域功能）
├── 操作步骤（分步骤图文对照）
│   ├── 常用操作（最频繁的 3-5 个场景）
│   └── 进阶操作（可选配置、高级用法）
├── 注意事项 / 小贴士
└── 截图（嵌入 base64，每章节 2-4 张）
```

## 截图计划（共 22 张）

### 主页面（8 张）

| # | 文件名 | 截图内容 |
|---|--------|---------|
| 1 | workbench-overview.png | 工作台首页：项目分组全貌 |
| 2 | session-workbench.png | 会话工作台：分屏布局 + 会话列表 |
| 3 | stats-overview.png | 统计页：总览卡片 + 按模型/项目表格 |
| 4 | rules-editor.png | 规则页：三栏编辑器 + 模式测试器 + 黑名单 |
| 5 | profiles-center.png | 配置档案页：CLI 卡片切换 |
| 6 | skills-center.png | Skills 中心：全部/组织/本地列表 |
| 7 | settings-general.png | 设置页：通用设置 + 各区块 |
| 8 | summary-overview.png | 工作总结：报告列表 + 详情视图 |

### 弹窗（7 张）

| # | 文件名 | 触发位置 | 截图内容 |
|---|--------|---------|---------|
| 9 | dialog-new-session.png | 工作台 → 新建按钮 | 新建会话弹窗：工作目录选择、历史会话发现、Profile 选择 |
| 10 | dialog-session-config.png | 会话卡片 → 齿轮图标 | 会话配置弹窗：信息、运行配置、维护操作 |
| 11 | dialog-rename.png | 会话卡片 → 更多操作 → 重命名 | 重命名会话弹窗 |
| 12 | dialog-summary-generate.png | 总结页 → 生成总结 | 生成总结弹窗：时间范围、会话选择 |
| 13 | dialog-summary-edit.png | 总结页 → 编辑任务 | 编辑总结任务弹窗 |
| 14 | dialog-html-export.png | 总结页 → 导出 HTML | HTML 样式选择弹窗 |
| 15 | dialog-server-register.png | 设置 → 服务端连接 | 服务端注册确认弹窗 |

### 抽屉（4 张）

| # | 文件名 | 触发位置 | 截图内容 |
|---|--------|---------|---------|
| 16 | drawer-gateway-config.png | 设置 → 通信 Gateway → 配置 | Gateway 配置抽屉：App ID/Secret、飞书绑定 |
| 17 | drawer-claude-profile.png | 配置档案 → Claude → 查看详情 | Claude Profile 详情抽屉 |
| 18 | drawer-summary-conversation.png | 总结页 → 查看对话 | 总结对话记录抽屉 |
| 19 | drawer-artifact-preview.png | 会话工作台 → 产物按钮 | 产物预览抽屉：图片/文本/Markdown/HTML |

### 关键交互状态（3 张）

| # | 文件名 | 截图内容 |
|---|--------|---------|
| 20 | interaction-approval.png | 会话工作台中的审批确认面板（待确认状态） |
| 21 | interaction-batch-select.png | 工作台批量选择模式 |
| 22 | interaction-split-pane.png | 会话工作台 2 窗格分屏布局 |

## 写作风格

- **语气**：平实、专业、不啰嗦，像同事在旁边指导
- **操作步骤**：动词开头，如"点击「新建」按钮"、"选择工作目录"
- **截图标注**：用箭头/圆圈标注关键按钮和区域
- **篇幅控制**：功能概述 2-3 句，操作步骤每步 1 行，每章 500-800 字

## HTML 技术规格

- **单文件自包含**：所有 CSS + JS + base64 图片内联
- **侧边栏目录**：固定左侧，可折叠展开，当前位置高亮
- **响应式**：桌面和移动端均可查看
- **打印友好**：`@media print` 样式优化
- **主题**：浅色主题，与 UCLI 品牌色调一致

## 工作流程

1. 启动 `npm run dev` 运行 UCLI 开发服务器
2. 逐页面操作并截图（22 张），保存到 `docs/user-manual/screenshots/`
3. 编写手册 Markdown 源文件（`docs/user-manual/UCLI-用户手册.md`）
4. 将 Markdown + 截图构建为自包含 HTML 文件
5. 用户审查手册内容

## 产出文件

```
docs/user-manual/
├── UCLI-用户手册.html          # 最终交付物（自包含 HTML）
├── UCLI-用户手册.md            # 可编辑 Markdown 源
└── screenshots/                # 截图源文件（22 张）
    ├── workbench-overview.png
    ├── session-workbench.png
    ├── ...
    └── interaction-split-pane.png
```
