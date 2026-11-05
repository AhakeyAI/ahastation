# 规划索引与适用范围

更新：2026-11-04（Asia/Taipei）。本索引用于区分当前实施依据、历史交付记录和其他模块的独立计划；不以旧日期推断远端 Issue/PR/CI 当前状态。

## 原生 CLI Worker 当前入口

**当前实施依据：[原生 CLI Worker 接线规划](2026-11-02-native-cli-worker-integration.md)。** 用户已明确：复用本地原生 CLI；子任务不向 Host 请求工具审批；不修改 Codex 引擎。Host 派单和验收，CLI 按原生权限配置执行。

本机关键路径：现有终端模式接线 → 当前任务身份/报告生产端 → 一个真实任务的候选交付和验收 → 生命周期/恢复。全局 hooks 状态观察、跨设备和扩展 UI 不扩大这条前置链。代码与验收状态见当前规划，不能从旧方案或本索引推断功能已开放。

11-03 已接通 Claude/Codex 本机终端 Worker 的任务绑定、`aha-worker report/ask/inbox`、候选回执、同会话追问、接管/交还、停止证据和显式重启恢复。[N1–N8 证据](../c0/b04-runtime/native-cli-scenarios.md#2026-11-03-离线接线证据)来自隐藏夹具、自有仓库和进程；真实 Claude/Codex 账号、原生审批/模型回合及指定平台生产验收仍待执行。真实账号和付费模型未获本轮授权。

11-04 按 `31fde4f` 审查修复 5 个接线缺陷，新增故障回归，见[审查修复证据](../c0/b04-runtime/native-cli-scenarios.md#2026-11-04-审查修复证据)。原生只读/脑暴组合目前明确不支持，不以提示词保证只读、不隐式转 SDK。PR #153 已撤回、原 CI 已取消，本轮仅本地修改；不得据历史绿色测试标为生产闭环完成。

## 文档登记

| 文档 | 适用范围 |
| --- | --- |
| [11-02 原生 CLI Worker 接线](2026-11-02-native-cli-worker-integration.md) | 当前原生 Worker 实施依据，包含代码事实、次序和复核修正 |
| [10-29 冲刺分工](2026-10-29-sprint-plan.md) | 模块/接口/负责人参照；旧时间和审批要求按当前规划限定，不是实时进度表 |
| [10-31 #86 候选交接](2026-10-31-issue-86-worker-bridge.md) | 历史核心/协议交付；旧 Host 逐工具裁决不再作为当前接线前置 |
| [11-01 生产链复审](2026-11-01-native-worker-production-review.md)、[ConPTY/联网边界](2026-11-01-native-cli-egress-boundary.md) | 历史离线候选、缺陷修复和边界证据；不再派发其旧 P1/P2 强制隔离路线 |
| [10-29 #85 实现](2026-10-29-issue-85-global-hooks-implementation.md)、[10-31 #85 收口](2026-10-31-issue-85-global-hooks-closeout.md) | 安装/卸载、安全恢复及观察能力仍可复用；controlled deny-only 是历史代码事实，不是新产品目标 |
| [10-17 多 CLI 实施](2026-10-17-multi-cli-implementation-plan.md)、[Orca 对照](2026-10-17-orca-multi-cli-parity.md) | 历史设计/分支资产线索；尤其 CLI 桥的“已实现”必须在当前检出核实，不继承完成声明 |
| [10-17 PTY supervisor](2026-10-17-pty-supervisor-design.md)、[10-23 daemon 路线](2026-10-23-terminal-daemon-roadmap.md) | 终端生命周期与后续能力；复用已有实现，不默认重做全部阶段，也不承诺未经验证的跨应用恢复 |
| [10-23 工作区重构](2026-10-23-terminal-workspace-refactor.md)、[10-24 视觉验收](2026-10-24-terminal-v1-visual-review.md)、[10-26 修订](2026-10-26-terminal-review-revision.md)、[10-28 拆分提交](2026-10-28-terminal-pr-submission.md) | 对应历史源码/截图/PR 的记录；当前工作不重新启动旧拆分和合入顺序 |
| [10-25 运行时修复](2026-10-25-runtime-repair-verification.md) | SDK/历史 A-14–A-20 运行时修复记录；不能给新原生 CLI 路线追加 Host 审批要求 |
| [07-24 协作设计](2026-07-24-meeting-task-collaboration-design.md)、[实施](2026-07-24-meeting-task-collaboration.md)、[Worker 交付协议](2026-07-24-worker-protocol-delivery-loop.md) | 既有任务、报告和交付领域的来源；参考当前实际代码复用，不重跑历史实现清单 |

## 关联文档与边界

- [ADR 索引](../adr/README.md)、[原生变更说明](../c0/design/native-cli-worker.md)和[能力矩阵](../c0/native-worker-capability-matrix.md)中的旧审批契约已注明范围变更。
- [原生 CLI 验收](../c0/b04-runtime/native-cli-scenarios.md)用于新路线；旧 B04 场景、SDK/Paseo 结果及交接包原件保持原样。
- C0/AME、协作和其他模块仍沿用其各自入口。跨端由用户答复原生审批、计划确认、任务通信、成果接受与发布授权不因本次取消工具回 Host 审批而删除。
- 本 chat 协调工作区的 10-29 工作顺序和 10-31 完成草案已转为历史入口；实际开发使用本索引指定的当前规划。其他任务的 worktree、源码、暂存和文件保持原状。
