# 0015 保留 MeetingRepository，外套事件信封 v2

- 状态：已接受
- 契约评审：2026-10-25（补齐命令 journal 与原子事件批次）
- 日期：2026-10-23
- 关联：B03、B08；`docs/c0/b03-contract/README.md` §3

## 背景

`meeting-repository.ts` 已经有追加写、快照、崩溃 tmp 清理、分页重放和大小上限，并经过测试。架构 11 要求「兼容旧日志而非整库重写」。但它缺少 schemaVersion、projectId、aggregateId、revision、actor/device、causationId。

## 决定

- 不换存储引擎（B08 另行评估），先在写入层加一层 `DomainEventV2` 信封。
- 读取时：无 `schemaVersion` 的行按 v1 处理，由适配函数包装成 v2，**不改写旧文件**。
- 项目级事件（不属于会议）放在 `projects/<projectId>/` 下，用同一套日志格式。
- 命令先写本地 journal；命令、完整事件批次和命令结果在同一事务提交。`batchId/batchIndex/batchCount` 不完整时投影与远端都不得部分应用，重放按 `commandId + batchId` 幂等。

## 后果

- 好：复用已测试的持久化；迁移可回退（删新投影即可）。
- 坏：两类日志目录并存；查询跨会议时需要投影层合并。
- 待定：B08 若决定换引擎（例如 SQLite），信封格式不变，只换存储实现。

## 考虑过的其他方案

- 直接换 SQLite：需要一次性迁移全部历史，回退困难；推迟到 B08 用数据量和查询需求决定。
