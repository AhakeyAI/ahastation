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

## 后续 P1：跨 attempt 完成证据不能授权发布（2026-10-27）

本次在 `etrnal-dev` 的 `86b0e9faaef2d8da68942963f1185cd261c98dec` 上追加修复，不重排此前六组提交。候选版本仍为 `0.19.0-collaboration.7`，本次源码以新增本地提交和下述 SHA 记录区分；没有重打或替换冻结安装包。原工作区、原审查证据和未跟踪的 `ROOT_CAUSE_AUDIT_2026-10-26.txt` 保留。

根因是 `authorizeDelivery` 分别比较“当前任务／传入任务”和“本地收据／传入收据”，没有把这两组的 taskId、attemptId 绑定在一起。`delivery.select` 完成异步文件选择后又读取当前收据，错误处理还可能用原收据给另一 attempt 上报完成事实。

修复复用原发布授权门禁：统一检查当前任务、传入任务、当前本地收据、传入收据，以及存在时的两个 taskSnapshot 身份；异步目录、仓库身份检查结束后再次核对。原明确 completed、实际退出、scope、停止、设备、Agent、目录和仓库授权继续生效。选定文件流程保留原 attempt 的收据和本次 publication，发布准备回调写入前后都经过同一门禁，身份失配时保留收据和成果，仅记录原有业务错误，不继续提交交付事件。

没有新增字段、迁移、队列、锁或依赖。新增的私有身份判断供门禁和错误处理复用，门禁内部复用同一段证据检查以覆盖 await 换代。删除了此入口未使用的 identity 变量和结束时重新读取收据的混用逻辑。`publishFiles` 在异步创建目录后、创建发布 worktree 前补充同一授权回调。Station 的仓库与选定文件两个发布入口也将该门禁传入现有 PR helper：等待已有 PR 查询及本机凭据读取后，真正创建请求前复查；读取原 PR 的幂等路径不新增发布。复用既有 ensurePr 回调，保持原六参数调用契约。

正式回归位于 `tests/collaboration-completion-evidence.test.mjs`，已纳入 `npm test` 和 `npm run test:collaboration` 原有入口。新增参数化组覆盖真实 `delivery.select`、旧调用方、已换代本地收据、taskId 不同但 attemptId 相同、两个陈旧 snapshot、文件选择和确认期间换代、准备回调写入被忽略，以及正常发布／重复交付／重启读取。另一用例在等待原 PR 查询时换代，核对创建计数为 0 且旧 PR 仍可读取。原缺字段、unknown/failed/interrupted、停止、旧 scope、长中文全文、SHA、人工验收和停止完成交错用例继续保留。

修复前先在未改动生产源码上运行新增正式回归；修正测试夹具的 undefined 序列化差异后，又以最终相同断言隔离验证原 HEAD 的 Station 源码。两次都因实际跨 attempt 放行失败，正常正例通过。修复前真实入口新增 **2 commit、1 资料分支、1 worktree、2 push、1 PR 夹具调用、1 验收调用**，并把旧完成事实报告给新 attempt；修复后这些计数全部为 **0**，旧收据、输出、文件和历史保留。测试准备阶段的 baseline commit/push 已从计数排除。

另有明确的中途边界：在原 attempt 已合法准备好资料 commit 后，才在收据写入处模拟换代；保留该已产生的 1 commit、1 分支和 1 worktree，后续 push、PR、模型、验收和交付事件均为 0。没有删除或回滚既有合法事实。正常同 attempt 仍产生预期的 2 commit、2 push 和 1 PR，重复交付不新增任何发布。

全部新证据位于实施目录的 `runtime/cross-attempt-fix-2026-10-27/`：修复前日志与 `before/`、最终夹具原源码反例 `PRE-FIX-FINAL-FIXTURE.log` 和 `before-final-fixture/`、修复后 `POST-FIX-REGRESSION-R2.log`、`after-r2/`、相关回归 `RELATED-NODE.log`。这里的 GitHub 形状 origin 被强制转入本机临时 bare 仓库，PR 为计数夹具，不代表真实 GitHub 验收。

最终参数化夹具按 taskId 区分文件内容，并使用空 Git 全局配置，避免同秒同内容的 Git 对象碰巧复用或用户全局传输规则影响隔离。其原源码反例记录为 `PRE-FIX-FINAL-V3.log`、`before-final-v3/`；PR 等待边界的修复前后分别见 `PR-PRE-FIX.log`、`pr-before/pr-attempt-RESULT.json` 和 `related-final/pr-attempt-RESULT.json`（创建计数 1 → 0）。验证源码指纹见 `FINAL-SOURCE-BEFORE-TESTS.json`，最终提交需与其中四个 Git blob 一致。

验证使用现有 `runtime/etrnal-integration-2026-10-26/verification-env/Scripts/python.exe`，Chrome 为 `C:/Program Files/Google/Chrome/Application/chrome.exe`。设置 `COLLABORATION_PYTHON`、`POCKET_VIBE_TEST_PYTHON`、`STATION_CHROME`、`PYTHONUTF8=1`，并在最终测试子进程中设置 `NO_PROXY=127.0.0.1,localhost,::1`。诊断已实测原环境的 Python WebSocket 会对 loopback 使用代理，设置后改为直连；未改系统代理、生产配置或凭据。Hub 回归使用本机临时文件数据库和真实 HTTP/WSS 路由。

已完成 `npm run typecheck`（Renderer 和 Electron）、`npm run build:electron`；最终完成证据／选定文件／Git／停止／恢复／Hub P1 的八文件 Node 回归为 **67/67**。单独运行 Python 的 `test_collaboration_p1.py`、`test_ui_fixes_native.py`、`test_station_codex_guardian.py`、`test_codex_shared.py` 分别通过 **6、11、17、33** 项。原生清单初次核对为 28 个源码、85 个载荷 SHA 一致；本次没有原生或 Hub 源码修改。

保留的失败轮逐项记录：首次修复后 `dialog/file-selection`、`dialog/confirmation`、`prepared/receipt-write-ignored` 及其父测试因新夹具显式 undefined 属性在 JSON 重启后消失而失败；改为创建没有该属性的新 attempt 夹具，保留原断言。首轮协作 Node 的 `F2 actual React rapid clicks submit once` 在 `page.goto` 前置加载超时，其余 215 项通过；相同断言独立复核为 15/15，首次页面加载的偶发耗时根因未确认。第二轮在 Python `test_H14_old_client_gets_explicit_version_error_after_new_outcome_not_invalidated_identity` 前置 WebSocket 握手遇到 EOF，未进入协议断言；独立诊断通过，并发现上述 loopback 代理问题。原失败日志分别为 `POST-FIX-REGRESSION.log`、`TEST-COLLABORATION.log`、`TEST-COLLABORATION-FINAL.log`，均保留；未在测试中添加自动重试、放宽超时、设置跳过或改变预期。

直连环境的完整协作命令结果为 Python **166/166**，Node **214 通过、3 失败、0 跳过（217 项）**，见 `TEST-COLLABORATION-DIRECT.log`。三个失败的完整名称为 `F2 actual React rapid clicks submit once`、`P1 actual React never displays or enables verification for a mismatched current delivery`、`F10 generated UTF8 travels frozen process journal, durable disk, authenticated HTTP, Hub restart and actual React without byte loss`；均在首次 `page.goto` 等待 `domcontentloaded` 超过原有 60000ms，未进入各自浏览器业务断言。没有把这些失败算作通过。

页面诊断见 `UI-LOAD-DIAGNOSTIC.json/log`：主页面和 Vite 客户端已返回，但 `/src/main.tsx` 持续等待，采集时依赖扫描耗时 86.7 秒。按未修改的 Vite 配置执行 `node node_modules/vite/bin/vite.js optimize` 后，再次验证缓存 hash 一致；原 UI 文件仍是 14/15，其首项仍前置加载超时，见 `VITE-OPTIMIZE.log` 和 `UI-PREBUILT-CACHE.log`。因此不能仅将超时归因于依赖扫描，完整加载延迟仍未定位。这些 UI 夹具、Renderer、Vite 配置与依赖清单和参考 HEAD 一致（`UI-SOURCE-UNCHANGED.json`）；本次保持其断言和超时，列为本机 UI 验证限制。

最终完整命令为 `npm test`，日志 `NPM-TEST.log`；其重新编译当前 Electron 源码后串行执行全部测试。逐项名称及状态比较见 `TEST-RESULTS.json`：

| 完整测试 | 总计 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: | ---: |
| 上一轮参考 | 1180 | 1174 | 0 | 6 |
| 本次实际 | 1192 | 1184 | 2 | 6 |

新增 12 个测试名称全部通过，没有删除原测试名称。两项由通过变为失败的名称为上述 F2 快速点击与 P1 核验显示用例；本次完整日志的错误均为首次 `page.goto` 等待 `domcontentloaded` 超过 60000ms。F10 长中文／SHA／原生 journal／真实 HTTP／Hub 重启／React 链路本次完整运行通过，协作命令中的失败轮仍保留。**本次完整测试和协作全集均未全绿，不能按产品全部验收通过交接。** 本任务的发布门禁专项和正式新增用例全部通过；按本次授权，无调用关系的本机 UI 前置加载限制单独列出，不扩大本次源码修复范围。

原有六项跳过的名称和原因逐项一致：`resolveCodexRuntime prefers an executable unpacked native binary`（macOS ARM64 夹具）；`Kimi authentication failure emits one auth-required circuit breaker`（POSIX shell 夹具）；`resolveConfinedPath rejects symlink escapes (the opencode-files hole)`、`resolveConfinedPath allows symlinks that stay inside the root`、`Kimi ACP file reads reject symlinks escaping the workspace`、`listQoderRuns skips symlinked manifests (fail closed)`（本机 Windows symlink 权限不可用）。没有把跳过算作通过。

最终源码保持验证前四个 Git blob 不变，原生组件再次核对为 **28 个 Python 源码、85 个载荷 SHA 一致**，见 `NATIVE-SOURCE-PAYLOAD-VERIFICATION.json`。最终本地提交 SHA 及逐文件对应关系保存到 `FINAL-DELIVERY.json`；证据摘要为 `KEY-REGRESSIONS.json`，清单为 `SHA256SUMS.txt`。`git diff --check` 和最终 diff 审查覆盖重复实现、冗余状态、无用代码及权限／并发边界；仅提交三个发布相关源码文件、正式测试和本文档，运行数据、构建产物及原审计文本不提交。

本次仅需更新 Station 的相应源码／编译输出，不需要更新 Hub 或迁移数据库；没有修改原生源码。原候选安装包未替换。未推送、创建真实 PR、合入 main、部署、使用生产数据库／凭据或原始 Codex 会话。BLOCKED／未执行：上述本机 UI 首次加载稳定性、真实双机、公网 Hub、真实 GitHub PR、用户原 Desktop 会话及付费模型；本机 bare Git、PR 计数夹具和隔离数据库结果不代替这些现场验收。
