# v2：完成证据与新增发布

本说明是既有 `turnOutcome` / `exitConfirmed` 字段的语义收紧，不另建消息格式或状态。执行、交付和人工验收继续使用 v2 schema；缺字段的旧记录仍可读取，不自动重写历史。

- `exitConfirmed` / `cleanup_confirmed` 仅证明执行资源已退出。`ok` 和命令退出码不能代替原生轮次 `completed` 证据。
- 新任务执行适配器报告准确的 `completed / interrupted / failed / unknown`。缺少正常完成证据为待核对，不启动新模型补证据。
- Station 对所有新增 Git commit、push、PR、选定文件和文字成果发布复用 `authorizeDelivery`：原 task/attempt、范围、明确完成、退出、设备/Agent/目录授权均须满足。收到停止意图后不得新增发布或验证命令；已发生的合法发布事实保留。
- 恢复读取原 attempt 的本机 journal，核对 `executionId`；显式轮次结果与实际退出分别判断。损坏、缺失或错 attempt 的证据不作为完成依据。不会用原生 `ok=true` 将缺失字段补成 completed。
- Hub 是新增交付事件的最终校验方：`task.event(status=delivered)` 要求退出证据和该 attempt 的明确 completed（本事件或已有服务器事实），否则 `409 TURN_COMPLETION_UNCONFIRMED`。相同已有成果的幂等回执保留原记录，不补造字段；已验收历史不因本次升级被重写。
- 依赖可用性仍复用现有 `deliveryIdentity / delivery_hash / verifiedDelivery`，核验绑定和旧历史兼容规则不由客户端重新定义。本次不引入数据库迁移。

对应可执行回归：`tests/collaboration-completion-evidence.test.mjs`、`services/remote/tests/test_collaboration_p1.py::test_K01_HTTP_requires_explicit_completion_and_preserves_historical_delivery`；停止交错与本地 Git 证据在 hardening suites。原 `scripts/review/reproduce-legacy-outcome.mjs` 保留作为缺陷历史探针，退出 0 不代表产品通过。
