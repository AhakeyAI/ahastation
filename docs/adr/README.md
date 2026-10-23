# 架构决策记录（ADR）

每条决定一个文件：`NNNN-短名.md`。状态取值：提议 / 已接受 / 已替代（注明替代者）。已接受的 ADR 不修改正文，改主意就写新的 ADR 替代它。

| # | 标题 | 状态 | 日期 |
| --- | --- | --- | --- |
| [0001](0001-stable-project-identity.md) | 项目使用稳定 ID，路径只是设备挂载 | 提议 | 2026-10-23 |
| [0002](0002-libsodium-for-device-crypto.md) | 设备间加密使用 libsodium，不自创协议 | 提议 | 2026-10-23 |
| [0003](0003-keep-meeting-repository-wrap-envelope.md) | 保留 MeetingRepository，外套事件信封 v2 | 提议 | 2026-10-23 |
| [0004](0004-runtime-base-keep-adapters.md) | 运行底座：保留现有 adapter，不引入 Paseo 作为执行层 | 提议（B04 证据完整） | 2026-10-23 |

模板：

```markdown
# NNNN 标题
- 状态：提议
- 日期：
- 关联：WBS / 设计文档

## 背景
## 决定
## 后果（好的、坏的）
## 考虑过的其他方案
```
