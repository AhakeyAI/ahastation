# 本地整合验收结果（2026-10-27）

源码验证版本 `c044ec35ed88f658bfef762ab8175996d71a02ef`；main 整合基底 `c8295b91210ccd261aa4a7a2dc5ee1eabc096491`。本文件为文档评审组的后续提交，不改变已验证代码。交接入口见 [本地整合说明](LOCAL_INTEGRATION_HANDOFF_2026-10-26.md)。

## 实际结果

| 检查 | 本次结果 |
| --- | --- |
| Renderer / Electron 类型检查 | 两侧通过 |
| 正式源码构建 | Vite、Electron、构建清单通过；仅既有 chunk 大小提示 |
| 当前原生组件 | 重新构建，冻结进程 self-test 协议2；28个 Python 源文件、85个载荷文件 SHA 全部匹配当前源码与载荷 |
| 完整 npm test 最终轮次 | **1180 项：1174通过、0失败、6跳过**；未放宽单项断言或超时 |
| test:collaboration 完整命令 | Python165项、Node204项通过，无跳过。此后增补由最终全量 Node 及下列针对最终源码的补验覆盖 |
| 最终 journal / Guardian / shared 补验 | 11 / 17 / 33 项分别通过 |
| 隔离 MySQL5.7.18 | Python97项、真实两个 Station 的 Node7项通过；实际生产鉴权、HTTP/WSS、协议能力和持久化路由 |
| 干净隔离 checkout 的 K03 对照 | Observe/Qoder合计156项，155通过、1符号链接权限跳过；夹具与Git原始字节相符 |
| 冻结包完整性 | .5的71项、.6的77项、.7 R2的76项清单文件全部与原SHA一致 |
| CI静态验证 | YAML、PR47上传条件、主构建7天保留期、Python/native步骤通过；未触发远端CI |

K01正式回归在本机临时 bare 仓库运行。旧源码的 executed / delivery-pending 缺 outcome 两例均出现 HEAD 改变、push=1、PR=1并报告completed。修复后，missing / unknown / failed / interrupted 各状态的新增 commit/push/PR/模型执行/验证/伪completed均为0；原文件和输出保留。明确completed正例各push=1、PR=1，反复操作不再发布。重启、轮询、交付重试、缺失/损坏/错attempt journal、停止交错与文字/仓库/选定文件门禁均有断言。

K02模拟RPC的拒绝、原线程连续接续、结果重开、脱敏、task/attempt/execution/thread/turn关联通过。**历史现场根因未确认**；没有当时执行电脑原始日志，日志增强通过不能替代真实Desktop接续修复验收。

两个原P1（Host确定拒绝后的恢复、迟到成果不得继承旧核验）及F01–F10相关协作回归保留并通过；长中文完整字节/SHA、人工核验弹窗、停止与完成交错未删除。

## 与旧失败的逐项比较

复用 compare-collaboration-regression.mjs 比较原 .7 完整日志（1151项、1112通过、34失败、5跳过）与本次最终日志。原34个名称逐一匹配：**33项现在通过，1项因Windows符号链接权限而跳过**；不能将这1项记为产品通过。没有新增失败。每项原名称、错误码/原因、当前通过/跳过状态见本机 `baseline-comparison.json` 的 failureDisposition，不只比较数量。

最终6个跳过分别是：macOS ARM64发布二进制夹具、POSIX Kimi认证夹具，以及4个需要Windows符号链接权限的检查（路径越界、域内链接、Kimi读取越界、Qoder manifest链接）。本轮未启用Developer Mode或改变OS权限。

完整失败轮次全部保留：初轮4失败（浏览器首次加载/旧完成夹具），其后1次首次加载超时，另1次原生夹具末尾刷新时Desktop socket丢失。浏览器夹具已关闭不使用的文件监听，依赖与运行器已整理；断言不变。原生断联当轮的3次执行都已停止且有退出证据；当前独立复跑2次、隔离基线2次及最终完整运行均通过，**该偶发断联根因仍未确认**，未按产品故障已修复处理。临时诊断代码已恢复；失败诊断存独立目录，未覆盖旧记录。

## 六个评审组及本地提交

| 组 | 本地提交（按依赖顺序） |
| --- | --- |
| a 契约 | 57b48af1a1206223c4a77ce958712e2b5cea1288 |
| b Hub | f2fae4cc8c1adf8a47f60819a72873e1aa2d253e |
| c Station/接收组件 | f7dd40f095587a4e3728c7918c938615e16ed6c2 |
| d 界面 | 40df0a89628b0076b643181f276d57e478d81e31 |
| e 构建/CI/脚本 | 11572170d9ad658da6bf1b962bf297773b2927f8；c044ec35ed88f658bfef762ab8175996d71a02ef（可复现验证补充） |
| f 文档 | 854193437d60dcf95d7fa345f9115a7ca3f4817c；本验收文档提交（准确SHA在本机FINAL-REVIEW-UNITS.json） |

最初六提交的最终tree `618133759df884dcc5e4db95b0591998f8497c78` 与保护点 `ef827c7b3afe8ab8605679bfb4db7caf65301d5a` 完全相同。之后仅有明确的测试/CI补充和本文档补充。原5f快照、.6/.7源码checkpoint c2b6f1800cae571b1e4b65fb1c7c424f0ccd46a5及原未跟踪文件都可由备份引用/bundle/ZIP恢复；未丢失已有正确修改。

## 交接路径与限制

实施目录：`C:/Users/79142/.codex/worktrees/collaboration-baseline-upload/station-ctrl`。

- 证据与完整日志：`C:/Users/79142/.codex/worktrees/collaboration-baseline-upload/station-ctrl/runtime/etrnal-integration-2026-10-26/`；入口 TEST-RESULTS.json、FINAL-REVIEW-UNITS.json、baseline-comparison.json、BUILD-SOURCE-VERIFICATION.json。
- Station构建：该实施目录的 `dist/`、`dist-electron/`；原生组件 `build/station-native/`。Station清单362个源文件SHA匹配。原生清单记录其实际构建提交8541934，此后的改动仅测试/CI/文档，其Python源码与当前字节一致，不以陈旧源码构建替代当前源码。
- MySQL证据：上述runtime内 `mysql57/rehearsal-025e5a50-fc88-4f90-894a-c20972077cab/RESULT.json`；新UUID数据目录、随机端口/密钥、非root应用账号，实例已关闭，测试数据保留。

Hub与Station/原生组件需匹配更新；本轮没有新增数据库迁移。原主工作区及其main（8f1506e4d22c51b07805cfc5f49c1fb25d634cdd）、station_hub和业务数据未改。原ROOT_CAUSE_AUDIT文本仍未跟踪并与初始ZIP字节相同。没有推送、真实PR、合并main或生产部署；本轮不重发同版本安装包，旧冻结包不含K01修复。

BLOCKED/待现场：真实双机、公网/微信云托管、真实GitHub写入与PR、用户原Desktop对话、付费模型及在线语音。本会话Docker CLI不可用，已实测原生MySQL路径；远端CI与Debian11 ARM64 Chromium未验证。Q/D冲突和独立安全前置分支仍按[冲突表](INTEGRATION_CONFLICTS_2026-10-26.md)交负责人裁决；没有自动选择或扩大权限。
