# 桌面布局补测（2026-11-04）

- 使用 `fa6d417` 代码和独立临时 userData。
- 将 `handheldMode` 设为 `desktop` 并重载 renderer：设置值为 `desktop`，`.meeting-navigation` 数量为 0，顶部工具栏和四列看板正常。结果：通过。
- 恢复为 `auto` 并再次重载：设置值为 `auto`，导航数量恢复为 1。结果：通过。
- 第一次仅通过 IPC 切换、未重载时，主窗口仍保持掌机布局；本补测证明重载后的持久化桌面模式有效，未额外声称设置窗口点击后跨窗口即时同步已通过。

证据：`desktop-mode-result.json`、`desktop-mode.png`、`auto-mode-restored.png`。
验证脚本：`docs/c0/validation/pr156-desktop-mode.mjs`。
