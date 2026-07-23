<p align="center">
  <img src="resources/icons/ucli.png" width="112" alt="UCLI Logo" />
</p>

# UCLI

UCLI 是一个 Windows 优先的本地 AI CLI 工作台。它在用户与已安装的 Claude Code、Codex 之间转发终端输入输出，保留原生 CLI 交互，同时提供多会话编排、安全确认、历史恢复和使用统计。

## 主要功能

- 原生终端代理：不重做 Claude Code、Codex 的交互界面。
- 会话发现：按工作目录发现并导入 Claude Code、Codex 历史会话。
- 多会话工作台：支持 1、2、4 窗格、导航收缩、会话列表隐藏、单窗格/分屏整体全屏，以及 `Tab`/`Shift+Tab` 切换会话。
- 后台通知：Claude/Codex 需要确认、等待用户输入或完成任务时显示 Windows 通知；通知标明会话与操作类型，点击后定位到对应工作台窗格。
- 会话生命周期：支持停止、关闭窗格、移除和重新添加。
- 安全规则：可信命令自动放行，高风险操作要求确认，硬黑名单始终拒绝。
- 使用留痕：记录 Token、费用、轮次、审批和模型统计；移除会话后仍保留历史统计。
- Provider 回退：Codex 历史 provider 已失效时，可使用当前可用 provider 恢复原上下文。
- CLI 管理：在设置页检测、安装和升级受支持的 AI CLI。
- Windows 桌面体验：单实例、关闭到托盘、后台审批/任务完成提醒、托盘恢复和退出清理。

当前正式适配 Claude Code 和 Codex。OpenCode 等其他 CLI 可按统一 adapter 接口继续扩展。

## 下载与安装

从 [GitHub Releases](https://github.com/AllernChen/ucli/releases) 下载：

- `UCLI-Setup-0.2.1-x64.exe`：Windows 安装版。
- `UCLI-Portable-0.2.1-x64.exe`：Windows 便携版。

当前 Windows 产物未进行代码签名，首次运行可能出现 SmartScreen 提示。请从本仓库 Release 下载，并核对 Release 中公布的 SHA-256。

## 快速开始

1. 安装并启动 UCLI。
2. 在“设置”页面检测本机 Claude Code 或 Codex。
3. 在“会话”页面新建会话并选择工作目录。
4. UCLI 会扫描该目录对应的原生历史会话，可选择导入或新建。
5. 在工作台选择 1、2、4 窗格管理多个会话。

## 会话操作语义

| 操作 | CLI 进程 | UCLI 记录 | 原生会话 | 用量与审计 |
| --- | --- | --- | --- | --- |
| 关闭 | 继续运行 | 保留 | 保留 | 保留 |
| 停止 | 终止 | 保留，可恢复 | 保留 | 保留 |
| 移除 | 终止 | 从工作台移除 | 保留 | 保留 |

## 数据位置

UCLI 的生产数据默认保存在：

```text
%APPDATA%\ucli\ucli.db
```

开发版使用独立的 `%APPDATA%\ucli-dev`，不会与安装版争用单实例锁或数据库。UCLI 不会删除 Claude Code、Codex 自己保存的原生会话。

## 本地开发

要求 Node.js 与 npm，建议在 Windows 10/11 x64 环境开发和打包。

```powershell
npm install
npm run dev
npm test
npm run build
npm run dist
npm run verify:release
```

`npm run dist` 生成 NSIS 安装版和便携版，输出到 `dist/`。
`npm run verify:release` 校验当前 `dist/` 与版本、打包命名规则、`latest.yml` 的 SHA-512 是否一致。完整人工发布验收见 [docs/release-acceptance.md](docs/release-acceptance.md)。

## 安全说明

安全规则用于减少重复确认并拦截已知高风险操作，但不能替代用户判断、系统权限隔离或数据备份。执行删除、发布、权限变更等高影响操作前，请核对命令和目标范围。

## License

[MIT](LICENSE)
