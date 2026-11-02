# collaboration.5 独立复审（2026-10-23）

审查对象：候选工作树 `C:/Users/79142/.codex/worktrees/collaboration-baseline-upload/station-ctrl`，分支 `etrnal-dev`，HEAD `b0cd16d1b7c4f9c91f9135ea163a7532ce1f2a1b`，未提交版本 `0.19.0-collaboration.5`。核对最终包 `release/collaboration5-delivery-final`；中间包不作为最终证据。

依据：Q108–Q112 最终确认、原修复提示词及 H01–H14 / S01–S18。原有需求和历史报告保留。本次仅审查，未修产品代码、未重打包、未提交／推送、未访问生产库或真实 GitHub，未操作用户 Station / Codex。

**结论：上一轮两处已复现问题的修复通过独立定向回归；本次另复现一处旧记录升级的发布准入缺口，尚不能认定全部修改要求已满足。交付包与当前冻结源码匹配，问题存在于实际打包逻辑中。**

## 需要修复：缺少轮次结果的旧记录获得了自动发布许可（P1）

相关当前源码：

- `electron/collaboration/station-service.ts:925`：`authorizeDelivery` 只在 `local.turnOutcome` 有值且非 completed 时拒绝；未停止、字段缺失的旧记录可通过。
- 同文件 `:502–503`：`executed + exitConfirmed` 会被 pump 自动送交付。
- 同文件 `:887`：发布时用 `receipt.turnOutcome ?? 'completed'` 补出正常结束，并发送 delivered。
- 同文件 `:77–80`：初始化没有为旧 executed / delivery-pending 记录先核对正常完成证据的步骤。

复现使用当前 dist 的生产 StationService、持久磁盘、本机专属真实 Git 仓库与 bare remote、实际冻结 native helper；SSH 传输被明确导向本机 bare 仓库。PR 接口为计数夹具，未请求真实 GitHub，未调用模型。

两组任务都具有旧形状 `status=executed, exitConfirmed=true, stopRequested=false`，有本机文件与相同授权。唯一差别是轮次结果字段：

| 记录 | 实际结果 |
| --- | --- |
| 显式 `turnOutcome=unknown` | delivery-pending；无新提交、无推送、PR 调用 0 |
| 缺少 `turnOutcome` | 自动 delivered；实际新建提交、推送任务分支、PR 调用 1，发送 `turnOutcome=completed` |

测试中缺少正常完成 journal／Hub outcome 证据，服务没有先核对它们，而是由缺字段直接推导正常完成。不能据旧 `executed` 标签一律断言真实中断，但这里已证明**缺失新字段本身绕过了新增许可边界**。这与提示词“旧记录缺字段……不能默认当作……新发布许可”和 Q111 的可靠正常结束证据要求冲突。

修复应以原 taskId + attemptId 核对本机原执行 journal、准确原生轮次或可验证的原结果。缺字段且没有充分证据时保留成果和待核对状态，不新增 Git 副作用、不补造 completed；可靠证据恢复后再延续原交付。不要把所有旧记录简单标失败或丢弃。Station、Hub 写入约束、升级读取和匹配包应一起核验，成功的旧回执仍需可读，无需因此清库或增加 DDL。

补回归至少包括：旧 executed 与 delivery-pending、字段缺失、journal 存在／缺失／中断／正常、重启、重复核对；同时证明无证据场景新增 commit/push/PR 为零，有可靠正常证据时原交付可恢复且不重跑 Agent。

复现材料：`runtime/review-collaboration5-2026-10-23/reproduce-legacy-outcome.mjs` 与 `LEGACY-OUTCOME.json`。脚本退出 0 表示反例成立，不代表产品行为正确。

2026-10-24 源码快照补充：独立反例脚本已复制到可提交的 `scripts/review/reproduce-legacy-outcome.mjs`，不包含运行 profile、凭据或二进制；原本机材料保留。当前上传状态及另一个远端讨论恢复问题见 [开发快照](DEV_SNAPSHOT_2026-10-24.md)。

## 上一轮两处问题是否关闭

| `.4` 已发现问题 | 当前核验 |
| --- | --- |
| 专家 stop 抛异常／悬挂，使公共 pump 不能处理其他工作 | 定向回归通过。当前按输入／执行职责启动后台操作，公共 pump 不等待全部停止完成；真实 HTTP/WSS 夹具证明独立任务、真实容量限制、审批和交付可推进 |
| 并发补投中迟到失败将 accepted 改回 pending，形成空 outbox 的坏状态 | 定向回归通过。当前按原 requestId 合并在途、accepted 单调；HTTP/WSS 与磁盘测试覆盖回应丢失、重启及旧坏状态核对 |

这两处是上一轮 `.4` 审查已发现、本轮 `.5` 修复的问题，不是本次新出现的回归。上述旧记录缺字段问题则是本次独立审查新复现的实现遗漏；需求中已经有这条边界，并非需要用户另提一项新需求。

## 本次实际独立执行

证据目录统一为 `runtime/review-collaboration5-2026-10-23/`。

| 检查 | 结果 |
| --- | --- |
| renderer + electron `npm run typecheck` | 退出 0，见 `typecheck.log` |
| 六套 hardening Node 测试，加 review-fixes / stability / unified / 实际 React UI | 73/73 通过，退出 0，见 `node-focused.log` |
| Hub `test_collaboration_hardening.py` | 15/15 通过，退出 0，见 `python-hardening.log`；含继承用例，不再累计为另一套独立覆盖 |
| 最终 CHECKSUMS | 71 项全部哈希和大小匹配 |
| 冻结源码与当前磁盘 | 623 项匹配 |
| 源码 ZIP 自带来源清单 | 800 项哈希匹配 |
| 打包 ASAR 与当前 dist / dist-electron | 248 项逐字匹配；exe/helper/清单哈希与最终 NSIS 提取报告一致。本次未重新解包 NSIS，也未重新安装启动用户软件 |
| Hub ZIP 独立导出、依赖、生产路由与 lifespan | 36 文件、28 固定依赖、COPY 来源、隔离 SQLite health/ready 启动通过；见 `hub-export/` |
| MySQL DDL | `.5` Hub ZIP 中原 `.4` SQL 逐字相同，未新增 DDL |
| 旧 outcome 缺失对照复现 | 反例成立；明确 unknown 禁止发布，缺字段却自动发布 |

独立 Node 运行未调用真实付费模型；真实 Git 副作用仅发生在测试自己的本机临时仓库。审查前已有完整回归、MySQL 5.7.18 演练、真实 Codex 和安装载荷启动日志，此次核对报告和来源，**没有重新执行完整 1118 项、MySQL 演练、真实模型或安装器启动**，不可将其说成本次全部独立重跑。

## 34 项既有失败的含义与已核实原因

报告的本轮基线为 1095 项 / 1056 通过 / 34 失败 / 5 跳过；最终为 1118 / 1079 / 34 / 5。其失败名称、错误码与断言头部比较记录为 34 项相同。“既有”指此次 `.5` 修改前的候选基线；不等于已证明上游最初 Git 基线就失败，更不意味着应永久忽略。

这 34 项不是 34 个互不相关的产品功能故障。一项底层夹具错误会引发进程关联、状态识别等多项断言失败。本次进一步做了只读／内存对照，未改测试或产品源码：

1. `tests/fixtures/observe/ps-sample.txt` 当前工作树为 CRLF；`parsePsOutput` 按 `\n` 分割后使用行尾正则，原样解析为 0 条。在内存中仅改成 LF 后解析为 22 条。`lsof` 夹具也受行尾影响，LF 对照可恢复预期 cwd。多个旧 Observe / CLI / Desktop / 后代进程测试依赖这些共同夹具。
2. Kimi 的 `makeKimiHome()` 在 JSON 文本上直接将 POSIX 前缀替换为含未转义反斜杠的 Windows 路径，破坏相关 JSON 行；还残留混合分隔符。导致本应存在的 session 被跳过，后续测试读取 null / undefined。这是测试准备的跨平台问题，不能据此声称 Kimi 实际 Agent 能力已验证。
3. Qoder 一项符号链接测试与六项 tailer 文件监听测试报 `EPERM`。符号链接权限和监听故障须分别处理，不能把监听报错未经核验也全部归因于未开启开发者模式。

只读对照脚本和结果：`diagnose-baseline-fixtures.mjs`、`BASELINE-FIXTURE-DIAGNOSIS.json`。报告的完整失败表见 `release/collaboration5-delivery-final/verification/REGRESSION_FAILURES.md`。原功能“完全不受影响”仍不能用“新增失败 0”替代验收；后续应修复夹具兼容性、核实监听环境后重跑相关原功能，而不是删除／跳过断言。本次不擅自扩大为全仓测试修复。

## 达到与尚未达到的边界

已得到本次可执行支持：停止故障隔离、原消息确认与旧 pending 状态修复、账号切换防迟到覆盖、正常／中断／未知的显式 outcome 分支、正常停止后的既定交付与不新启动测试、部分成果不自动发布、计划保护与相应界面回归，以及最终包与源码一致。

尚未满足：旧记录缺少 outcome 的升级恢复／自动发布边界。因此 H13/H14 和“旧数据安全恢复”的完整结论需要收回为部分覆盖，修复并新增回归后重新打包。

原报告明确未完成的现场验收仍然未完成：物理双机／真实公网云 Hub、真实 GitHub PR、用户 Codex Desktop 接续和硬件／其他 Agent 或平台。本机两服务、模拟 PR、已检查 MySQL 记录和可导入 Hub 不能替代这些。无 Docker 引擎，未构建启动 Docker 镜像；安装器未签名。没有证据表明必须更换 MySQL5.7 或 station_hub，但“所有功能全部达到要求”目前仍不成立。
