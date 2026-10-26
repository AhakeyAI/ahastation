# 技术开发准入与执行基线

日期：2026-10-25。范围：C0 收尾、A-14–A-20 真实复验、门 A / B / X 的设计准备。本文是当前准入入口；旧文档中的 pending 状态以本文及链接证据为准。

## 1. 当前结论

> **2026-10-26 更正**：准入改为有条件，见 `DECISIONS-2026-10-26.md`（前置修复 P1–P8、`etrnal-dev` 评审 R1）。

**可进入技术开发。** 真实 Claude/Codex 已证明默认模型创建、追问、目录授权、拒绝、严格停止、真实宿主 kill 后恢复和证据链。Codex 的授权方案由实测否决的 `workspace-write` 改为 `read-only + on-request`。最终代码二次回归为 937 tests / 931 pass / 0 fail / 6 skip，typecheck 与完整 build 通过；双 provider 并发复验通过。

“可进入开发”不等于可发布：语音真机 AEC、双机故障、安装包 smoke 和三位用户验收属于对应实施卡的验收，不可能在实现前完成。

## 2. Claude / Codex 额度使用原则

1. 只使用用户已明确授权的本机订阅账号，不切换 API 计费，不读取或提交 token、cookie 与账号配置。
2. 只在 B04 临时 fixture 仓库执行写任务；不修改用户真实项目，不提交、不推送、不发布。
3. 默认串行复验；只有明确的并发性能场景才并行。每个场景先跑确定性测试，真实模型只覆盖协议无法替代的部分。
4. 默认账号模型，不为绕过失败而手选更贵模型；失败先保留证据。只有证据无效或代码修复后才重跑，不为追求 pass 反复抽样。
5. S4/S5/S6 是一票否决项，不放宽判据。停止场景必须观察 30 秒，并验证无新工具、无文件变化、子进程树退出；S8 必须真实杀宿主进程树。
6. 原始证据只保留事件、用量和必要文件 hash；脱敏 fixture 删除 thread/turn ID、账号信息和密钥。
7. 订阅窗口只有百分比时，不声称精确费用或零超支；模型调用与语音 API 预算分开授权、分开计量。
8. 达到授权场景即停止调用。后续开发默认使用 mocked 确定性测试，真实模型再次运行需在实施卡中说明目的。

## 3. 准入清单

| 项 | 状态 | 证据 / 结论 |
| --- | --- | --- |
| Windows / Node 22 安装、类型检查、构建 | 通过 | 最终代码二次回归 937 tests / 931 pass / 0 fail / 6 skip；typecheck 与完整 build exit 0 |
| A-14 Codex 版本、默认模型与授权 | 真实通过 | Worker 全矩阵 + Host turn 完成；`read-only + on-request` 下所有写入由宿主按路径裁决 |
| A-15 Claude 默认模型 | 真实通过 | Worker S1/S2 + Host result；动态发现 13 个账号模型，旧 `model_not_found` 未再出现 |
| A-16 fileChange 路径 | 真实通过 | 批准含真实 paths；`test/` 与仓库外写入均被拒 |
| A-17 hooks 不绕过宿主 | 真实通过 | 保留本机 AhaKey 设置，Claude S3/S4/S5 均由宿主裁决 |
| A-18 就绪超时 | 通过 | N5095 Worker / Host 启动成功；25ms 超时单测走正常 failed |
| A-19 中断单终止信号 | 真实通过 | Claude S6 只有 `ended:interrupted`，steer 单测保持会话连续 |
| A-20 停止撤销与进程树 | 真实通过 | 两 provider S6：30 秒无新工具/文件变化，子进程归零 |
| S8 真实宿主恢复 | 真实通过 | 两 provider 均 taskkill 进程树后按同一原生 session 恢复，测试 2/2 |
| 双 provider 并发与资源样本 | 通过 | 两任务均 2/2；Claude RSS 峰值约 222 MiB，Codex 约 165 MiB；`results/ahastation-20261025-concurrent-runtime.json` |
| B03 领域契约 | 设计完成 | 增加 command journal、`batchId/Index/Count` 原子提交、崩溃幂等；ADR 0003 已接受 |
| B05 语音路线与成本 | 设计完成 | D3/D4 已决定；在线主路径、本地兜底；成本模型与硬预算见运行时验证文档 |
| B06 用量协议 | 设计完成，A-10 待实施 | 两 provider 真实样本；Codex `last` 为单次调用增量、`total` 为累计；Claude 含窗口与列表价 |
| B07 UX | 已冻结 | D7/D15 与原型 v2 |
| 跨设备协议与 ADR | 设计完成 | keyId、算法版本、规范 CBOR、一次性配对、安全码、fencing、停止 applied；ADR 0002 已接受 |
| WBS 与 PR #49 拆分 | 设计完成 | B12 5–8、B14 3–5、M4 5–8、M6 2–3 人日；PR #49 四线拆分 |
| 依赖漏洞 | 1 项发布前专项 | 已从 31 项降至 1 high；仅剩 PDF.js 5→6 大版本迁移，列入 B25/发布前，不强行跨版本 |

## 4. 开发期验收，不作为开工前伪装完成的事项

- 在线 ASR/TTS 的首包、打断、准确率与真实账单：在 A-08 接入统一 benchmark 后执行；语音 API 额度与 Claude/Codex 授权分开。
- N5095 有人在场的 WebAudio + Chromium AEC / barge-in：A-08 与 M6 验收；当前 25% 自听基线不能当作 AEC 结果。
- sherpa-onnx 离线并发：A-11 实施后测，在线主路径不依赖它开工。
- X8 双机乱序、重放、撤销、旧 keyId、停止未知：A-12/A-13/X3/X5 实施后使用 Mac + N5095 验收。
- PR #49 的 Windows daemon 和打包 smoke：各拆线自己的合并门槛。
- 完整发布仍需 B40–B42，不因“允许开工”提前宣称发布就绪。

## 5. 首批开发顺序

1. **运行时基线合入**：当前 A-14–A-20 修复、严格 B04 harness 与证据先形成独立 PR；后续功能基于该提交，不基于旧 main。
2. **领域与来源**：A-01 → A-02 → A-03；并行 B14-GH 只读 Issue 关联。完成稳定 ID、事件批次和迁移后才让其他切片写领域事件。
3. **确认闭环**：A-04 + A-07 + B12-HOST；验收过期版本拒绝、命令与多事件原子恢复、确认前零 Run。
4. **语音与会议**：A-08 → A-09 → M4；A-05 可并行。A-11 离线兜底排在线路径之后，M6 用真实 WebAudio 验收。
5. **执行与计量**：A-10 接 usage，随后 B10/B19/B21；Codex 按 `last` 累加、`total` 对账，缺失反馈继续按预留保守结算。
6. **跨设备**：A-12 → A-13 → X3 → X5/X6 → X8。先在假传输中通过确定性故障测试，再接自建中继。

完整卡号、依赖和人日以 `plan/cards.csv` 为准；关键路径见 `plan/README.md` §3。

## 6. 证据索引

- B04 场景：`b04-runtime/results/C-A-<provider>-S*.json`、`C-A-<provider>-HOST.json` 与 `results/logs/`；并发资源：`results/ahastation-20261025-concurrent-runtime.json`。
- 严格 harness：`b04-runtime/harness/`（真实写任务停止、独立子进程宿主 kill、进程树与全文件 hash）。
- 运行时修复与语音调研：`docs/plans/2026-10-25-runtime-repair-verification.md`（修复分支）。
- 用量 fixture：`b06-quota/fixtures/*2026-10-25.json`；接线设计：`b06-quota/WIRING.md`。
- 契约：`b03-contract/README.md`；跨设备：`design/remote-control.md`；安全决定：`../adr/0002-libsodium-for-device-crypto.md`。
