# Changelog

本项目的重要变更记录在此文件中。

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
