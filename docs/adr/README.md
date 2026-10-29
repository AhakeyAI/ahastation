# 架构决策记录（ADR）

每条决定一个文件：`NNNN-短名.md`。状态取值：提议 / 已接受 / 已替代（注明替代者）。已接受的 ADR 不修改正文，改主意就写新的 ADR 替代它。

## 编号规则（2026-10-26 起，决定 G7）

- 编号在本仓库所有长期分支之间统一分配，不在各分支里各自从 0001 起编号。新建 ADR 前，先查本索引和远端各分支的 `docs/adr/`。
- 已占用的编号：
  - main：0001；
  - `etrnal-dev`：0002–0012，原号保留；
  - C0：0013–0016，原为 0001–0004，2026-10-26 重新编号，只改了文件名和标题号，正文不变。
- 评审分支已占用 0017、0018、0019，**下一个可用编号是 0020。** 新增前核对统一索引，不能按哪个分支先合入静默覆盖。
- 跨分支合并时，编号冲突由本索引登记，不允许静默覆盖同名文件。

## 索引

| # | 标题 | 来源 | 状态 | 日期 |
| --- | --- | --- | --- | --- |
| [0001](0001-meeting-owned-visible-task-collaboration.md) | Meeting-Owned Visible Task Collaboration（会议拥有可见的任务协作） | main | 已接受 | 2026-07-24 |
| [0002](0002-shared-meeting-with-existing-codex-sessions.md) | 共享会议同时承载多设备任务和已有 Codex 对话 | `etrnal-dev` | 该分支内已接受，**评审中** | 2026-10-21 |
| [0003](0003-single-coordinator-for-shared-meeting.md) | 共享会议保留唯一协调者和初始协调设备 | `etrnal-dev` | 同上 | 2026-10-21 |
| [0004](0004-task-boundary-is-complete-delivery.md) | 以完整交付定义任务边界 | `etrnal-dev` | 同上 | 2026-10-21 |
| [0005](0005-codex-first-through-extensible-agent-interface.md) | Codex 首版与可验证的多 Agent 扩展接口 | `etrnal-dev` | 同上 | 2026-10-21 |
| [0006](0006-github-for-cross-device-file-transfer.md) | 通过 GitHub 传递跨设备输入与成果文件 | `etrnal-dev` | 同上 | 2026-10-21 |
| [0007](0007-verified-meeting-integration-before-final-merge.md) | 通过已验证的会议分支放行代码依赖任务 | `etrnal-dev` | 同上 | 2026-10-21 |
| [0008](0008-stop-releases-execution-capacity-without-abandoning-task.md) | 停止释放执行资源并保留可继续的任务 | `etrnal-dev` | 同上 | 2026-10-21 |
| [0009](0009-shared-meeting-lifetime-independent-of-view.md) | 共享会议运行独立于查看窗口 | `etrnal-dev` | 同上 | 2026-10-21 |
| [0010](0010-one-meeting-per-native-conversation.md) | 原生对话同时只关联一个共享会议 | `etrnal-dev` | 同上 | 2026-10-21 |
| [0011](0011-recover-received-tasks-on-original-device-first.md) | 首版已接任务只在原执行设备恢复 | `etrnal-dev` | 同上 | 2026-10-21 |
| [0012](0012-shared-tool-approval-with-single-effective-response.md) | 原生工具审批跨端展示并只接受一次有效答复 | `etrnal-dev` | 同上 | 2026-10-21 |
| [0013](0013-stable-project-identity.md) | 项目使用稳定 ID，路径只是设备挂载 | C0（原 0001） | 已接受（D8） | 2026-10-23 |
| [0014](0014-libsodium-for-device-crypto.md) | 设备间加密使用 libsodium，不自创协议 | C0（原 0002） | 已接受 | 2026-10-23（安全评审 2026-10-25） |
| [0015](0015-keep-meeting-repository-wrap-envelope.md) | 保留 MeetingRepository，外套事件信封 v2 | C0（原 0003） | 已接受 | 2026-10-23（契约评审 2026-10-25） |
| [0016](0016-runtime-base-keep-adapters.md) | 运行底座：保留现有 adapter，不引入 Paseo 作为执行层 | C0（原 0004） | 已接受（D14） | 2026-10-23 |

0002–0012 的文件已随本地整合保留，0013–0016 从 C0 `04c5f762` 原文引入，只同步治理文档，未据此合入其实现。这些 ADR 在该分支内标为 accepted，但按决定 G1，跨设备方案以评审结论为准。

评审分支的 [0017：设备消息签名](https://github.com/ShawnyinsGit/ahastation-internal/blob/review/etrnal-dev-2026-10/docs/adr/0017-trusted-hub-with-signed-device-messages.md)、[0018：跨设备执行端](https://github.com/ShawnyinsGit/ahastation-internal/blob/review/etrnal-dev-2026-10/docs/adr/0018-cross-device-executor-uses-ts-adapters.md)、[0019：原生 CLI Worker 与全局 hooks](https://github.com/ShawnyinsGit/ahastation-internal/blob/review/etrnal-dev-2026-10/docs/adr/0019-native-cli-workers-with-host-hooks.md) 已占用编号。0019 替代 0016 的 Worker 执行部分和 0018 第 1、2 条；新实现不再把 Worker 对齐 TS adapter。原 ADR 正文保留，新要求见 [当前评审状态](../collaboration/REVIEW_STATUS.md)。

交叉点历史原文见 [本次冲突表](../collaboration/INTEGRATION_CONFLICTS_2026-10-26.md)，负责人裁决以评审分支 CONFLICTS.md 和 ADR 0017–0019 为准。下方保留原待裁决交叉点作为历史索引，不表示这些决定仍未裁决。本次未新增 ADR，下一个编号是 0020。

## 待裁决的交叉点

以下几组 ADR 讨论的是同一类问题，会列入冲突表（R2），由负责人逐条裁决。裁决前两边都不算被替代。

| C0 | `etrnal-dev` | 交叉点 |
| --- | --- | --- |
| 0013 项目稳定 ID | 0002、0010 | 跨设备如何识别同一项目和同一会话 |
| 0014 libsodium 设备加密 | 0006 GitHub 传文件 | 跨设备传输走自建加密通道还是 GitHub |
| 0015 保留 MeetingRepository | 0001、0003、0009 | 会议的存储与协调模型 |
| 0016 保留现有 adapter；决定 G4（命令越界的检测） | 0005、0008、0012 | Agent 接口、停止语义、跨端审批 |

## 模板

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
