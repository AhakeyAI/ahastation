# collaboration.7 两个 P1 的验收说明

本轮实施目录为 `C:\Users\79142\.codex\worktrees\collaboration-baseline-upload\station-ctrl`，参考 HEAD 为 `5f76c3a396daec014727b4f55fd588eb5a094f0d`。保留 .5、.6 冻结包、原报告和已有未提交修改；不提交、推送、合并或部署。

## 自动回归与证据

新增正式测试：`tests/collaboration-p1-regression.test.mjs`、`services/remote/tests/test_collaboration_p1.py`，并扩展实际 React 回归。修改前的失败断言在 `runtime/p1-fix-c7-2026-10-26/pre-fix-node.log` 和 `pre-fix-hub.log`；这些失败是缺陷证据，不计产品通过。

回归覆盖：明确业务拒绝与下一输入；真实执行仍占用；网络／代次／协议／身份冲突仍核对；旧拒绝记录恢复；成功收据优先；不同正文、测试报告、Git 提交拒绝；重复成果幂等；旧 attempt／范围；损坏旧核验绑定的依赖创建、集成、基线和验收阻断；合法新 attempt 与无关任务继续；重启和准确成果界面状态。原长中文／BOM／SHA、人工弹窗、停止与正常完成交错用例保留。

最终结果和逐项失败原因对照见本轮 `DELIVERY_REPORT.md` 与 `REGRESSION_FAILURES.md`，不可将套件中的既有失败或 BLOCKED 改写为全部通过。

## 现场步骤（BLOCKED，未执行）

1. 两台物理电脑安装 .7，配套 Hub 更新后，在专属会议保留一个已派任务，让 Host 提交遗漏它的完整计划。应显示具体拒绝和“提案未应用”；原计划、已派任务不变；直接输入修订要求，下一轮正常处理。
2. 原执行仍运行时断网或重启 Station，应保持等待，不能提前释放。恢复时沿原输入、原会话和原请求核对，不能另起模型执行。
3. 在专属测试会议完成 D1 的人工核验／集成，再提交同 attempt 不同正文、报告或提交：Hub 明确拒绝，D1 和审阅证据保留。相同回执幂等。
4. 对旧损坏绑定记录，所有相关下游入口保持等待；独立任务和其他会议正常。明确修订范围并继续产生新 attempt 后重新交付、核验，才可放行。
5. 复核公网连接、双方重启、用户正常 Codex Desktop 接续与专属 GitHub 测试仓库。没有指定仓库及当前现场环境，不执行真实推送／PR；不修改用户原 Codex 历史或生产凭据。

本次无新增数据库迁移。Hub 必须更新；升级和旧字段规则见 `services/remote/docs/COLLABORATION_7_UPGRADE.md`。
