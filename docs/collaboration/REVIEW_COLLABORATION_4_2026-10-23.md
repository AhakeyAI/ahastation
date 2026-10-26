# collaboration.4 独立复审

日期：2026-10-23。审查对象：`etrnal-dev`，HEAD `b0cd16d1b7c4f9c91f9135ea163a7532ce1f2a1b` 加现有未提交修改，版本 `0.19.0-collaboration.4`。候选工作树为 `C:/Users/79142/.codex/worktrees/collaboration-baseline-upload/station-ctrl`。

**结论：大部分修复已经实现，但还不能判定 F1–F3 和 S01–S18 全部满足。独立补充检查复现了两处遗漏，需要修复并补回归后重新冻结交付。** 原测试通过和包来源一致的证据成立；它们没有覆盖下面两种异步故障组合。

本轮没有修改产品实现，没有重新打包、提交或推送，没有关闭用户应用，也没有访问或更改生产 Hub、`station_hub` 或真实项目。新增内容仅为本复审报告和隔离复现材料。错误复现脚本的正常退出表示“反例成立”，不能记作正确行为验收通过。

## 1. [P1] 专家停止异常会中断整个设备的调度

位置：`electron/collaboration/station-service.ts:270–276`，重点为 272–273 行。

`doPump()` 在调度 Host、处理工具决定和启动独立任务之前，先遍历需要停止的消息。这里直接等待 `handle.stop()` 或 `nativeHelper(worker-stop)`，没有逐条异常隔离。原生组件启动失败、异常退出或核对超时均可能使这些 Promise 拒绝；`native-helper.ts` 明确存在相应拒绝路径。

一旦某个专家停止抛异常，本次 `doPump()` 直接退出，后面的独立工作均不处理。该停止消息仍满足下一次循环条件，后续调度会反复卡在同一条记录。应只等待的专家交流，由此扩大成整个设备的工作阻塞，违反 F1、S01、S03 和 S13。

独立复现：`runtime/review-collaboration4-2026-10-23/reproduce-expert-stop-isolation.mjs`，证据为同目录 `EXPERT-STOP-ISOLATION.json`。使用当前编译的真实 StationService 和独立持久状态，只注入停止组件的异常；没有调用真实用户 Agent。

- 连续两次调度均因同一个专家停止异常退出。
- 独立 Host、另一会议已接收任务、已有工具决定的处理次数均为 **0**。
- 正对照：仅将停止结果换成 `false`（仍未确认退出），三个独立对象均各处理 **1** 次。说明独立工作原本具备执行条件，阻塞来自异常未隔离。

修复应将停止失败保留为该输入的待核对状态，不宣称退出、不释放未证明可释放的资源，同时让其余独立工作继续；不能用设备或会议全局锁处理。回归需要覆盖活跃 handle 抛异常、恢复时 helper 抛异常，以及停止结果正常但未确认的正对照。

## 2. [P2] 迟到失败会将已确认的消息提交降回无法恢复的 pending

位置：`electron/collaboration/station-service.ts:188–197`，重点为 193 行；`message.reconcile` 的 935–939 行使该状态无法自行核对。

连接恢复后的 `flush()` 和用户点击“核对／补投原提交”可以同时投递同一个 requestId。若其中一次成功，代码会删除 outbox 并将提交设为 accepted；另一请求稍后发生网络错误时，catch 分支不检查已确认终态，仍无条件将它改成 pending。

最终出现 **Hub 已保存一条消息、本机有 messageId，但 status=pending 且 outbox 为空** 的矛盾状态。之后 `message.reconcile` 因找不到 outbox，直接返回本地 pending，既不查询 Hub，也不恢复原命令；重启也不能恢复。用户可能持续看到错误的待核对状态，或因误以为失败而重新发送，违反 F2、S07。

独立复现有两份：

- `reproduce-concurrent-delivery.mjs` / `CONCURRENT-DELIVERY.json`：最小并发状态复现。
- **`reproduce-concurrent-delivery-http.mjs` / `CONCURRENT-DELIVERY-HTTP.json`**：真实生产 Hub HTTP、独立 SQLite 和真实 Station 持久文件，只在传输返回处注入丢响应及迟到失败。流程为首次提交已落 Hub 但丢响应 → 后台补投仍在途中 → 手工核对成功 → 后台请求迟到失败。

第二份证据确认：Hub 对该提交只有 **1** 条消息；本机先 accepted 后 pending；outbox 为空；重新加载磁盘状态后再核对仍 pending，且没有发出任何网络核对请求。此复现没有造成 Hub 同 ID 重复入库，问题在 Station 收据状态回退及恢复缺口。

修复应让同一 requestId 的确认状态不可被较早失败降级，协调后台补投和手工核对，并确保缺少 outbox 的异常 pending 仍有可靠核对路径。只需按提交隔离，不能增加会议或账号全局发送锁。回归应覆盖两种响应先后顺序、连续点击核对和进程重启。

## 3. 已核验成立的部分

| 范围 | 本轮核对结果 |
| --- | --- |
| F1 正常独立上下文和准备失败 | 同上下文等待，独立 Host／任务继续；授权、目录、输入、发布失败可见且释放预约；恢复线程身份、明确未启动重试的现有测试通过。停止异常见问题 1 |
| F2 普通提交及输入保护 | 实际 React 连点、Enter、防擦除新正文、附件准备和稳定点名通过；单一路径丢响应／重启的现有测试通过。并发补投乱序回执见问题 2 |
| F3 计划修改和双向版本 | 本轮未发现新的阻断问题。相同快照／改名／在线／进度保留编辑；真正计划变化需核对；关闭与拒绝分开；切会后保留；迟到批准回应不擦除后续修改；已分发只读；Host 依据和服务端版本保护的现有回归通过 |
| Hub 与旧数据 | 当前源码无新增 DDL；.4 继续复用 schema=2 的实体、事件和幂等记录。原生及旧 Bridge 接口保留，新保护要求匹配 Station。上述两个反例均定位到 Station，并未证明需要更改数据库结构 |
| 原功能保护 | 原 R1–R4 和统一会议重点回归本轮通过。不能把这些结果扩展成所有硬件、平台和原功能无条件通过 |

## 4. 本轮实际执行与证据审阅的区别

本轮实际执行：

- Renderer 和 Electron 两侧 `npm run typecheck`：通过。
- `collaboration-stability.test.mjs`、`collaboration-review-fixes.test.mjs`、`unified-meeting.test.mjs`：**37/37**，无跳过。
- `collaboration-stability-ui.test.mjs`：隔离真实 Chrome／React，**13/13**。
- `test_collaboration_stability.py`：独立 SQLite／HTTP／WSS，**13/13**。
- 上述两种新增错误复现成立；尚未转成产品已修复的正确行为测试。
- 最终交付 `CHECKSUMS.json` 的 **64** 个文件全部匹配。
- `FROZEN-SOURCE.json` 的 **604** 个源码／测试／脚本文件与当前工作树、源码 ZIP 均匹配。
- 最终 .4 `app.asar` 与本轮测试使用的编译产物一致：`dist` **57** 个、`dist-electron` **191** 个，共 **248** 个文件逐字匹配。因此上述反例适用于已交付的 .4 代码。
- 从 .4 Hub ZIP 独立导出验证：**35** 个清单文件、权限模式、**28** 个固定依赖、生产路由导入、独立 lifespan、`/health` 和 `/ready` 通过。未构建 Docker 镜像。

本轮查阅并核对来源、没有重新执行的交付证据：

- 完整 Node：1095 项，1056 通过、34 既有失败、5 跳过；失败名、错误码和规范化后的原因比较无新增。此结论仅限现有测试集合，不能抵消新反例。
- 正式构建、NSIS 解包／实际载荷启动与重启、真实 Codex 链路、独立 MySQL 5.7.18 演练和旧数据保留。
- MySQL SQL 与 .3 一致；生产数据库未被本轮访问或迁移。

本轮额外包核验材料保存在 `runtime/review-collaboration4-2026-10-23/INDEPENDENT-PACKAGE-CHECK.json`、`INDEPENDENT-ASAR-CHECK.json` 和 `hub-export/deployment-verification.json`。

## 5. 对验证报告与验收的结论

现有报告对真实双机、公网、GitHub PR、用户 Codex Desktop、硬件、Docker 和未签名安装器的边界说明清楚，包与源码一致。没有发现将这些未运行项目伪称为通过的证据。

但 S01／S03／S07 还缺少上述异常组合，不能以当前“通过”表格认定这些要求已完整满足。应先修复两项、补正确行为回归、复跑相关测试并重新构建 Station、更新源码及校验报告；若 Hub 内容未变，可核对复用同一 Hub 内容并明确匹配版本，无需为了这两个问题新建库或清理旧数据。

最终现场仍待第二台物理电脑＋公网 Hub、用户指定 GitHub 仓库的真实 PR、用户 Codex Desktop 原对话接续／停止／断联恢复、语音屏幕等硬件及 Docker 镜像构建。保留 34 个既有失败和 5 个跳过的单列说明。**当前判断是“主要修改成立，仍有两处代码缺口及现场验收未完成”，不是“全部修改要求已满足”。**
