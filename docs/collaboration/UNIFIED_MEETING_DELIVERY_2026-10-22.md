# AhaStation 统一会议交付记录 · 2026-10-22

交付版本：**0.19.0-collaboration.2 Windows x64 候选版**。在用户指定候选工作树 `C:\Users\79142\.codex\worktrees\collaboration-baseline-upload\station-ctrl` 的 `etrnal-dev` 增量实施；基底提交 `b0cd16d1b7c4f9c91f9135ea163a7532ce1f2a1b`。原 `C:\aha\ahastation\station-ctrl` 工作现场及旧 0.19.0-collaboration.1 候选包保留。

**结论边界：本轮完成统一会议代码接入和当前条件下的候选产物交付；不能宣称 Q70–Q100／T01–T45 已全部实机验收。用户确认目前只有这一台电脑。** 双物理机、公网 Hub 新版本、真实 GitHub 仓库及正在使用的 Codex 桌面接续仍需外部条件。原始失败与中间验证均保留，不把历史包、静态 HTML 或夹具当作实机证据。

## 按修改总清单核对

| 需求 | 实际改动、复用与新增 | 代码位置 | 验证范围 |
| --- | --- | --- | --- |
| 原会议入口 Q70–71、76、79 | 收敛独立 SharedMeetings 正常入口，复用原 AppTopBar、SideDrawer、ScreenStage、Participants、TasksView、TaskInspector、DeliveryViewer 和 PlanMeetingModal 的主框架；新增统一状态投影和共享动作适配。共享业务 ID 保持，不复制为另一套本机任务 | src/App.tsx；src/lib/unified-meeting-store.ts；src/components/UnifiedMeetingFrame.tsx；原组件中的 Shared 适配 | React 实际交互夹具、协议回环；实际双机待验收 |
| 唯一原 Host Q72、77、96 | 新会议经原 Orchestrator／HostGroup 和 meeting-command；共享模式不向本机 WorkerScheduler 再派一份任务。SharedCoordinator 只留旧会议恢复。Codex 传输复用持久守护，保留真实退出和原线程身份 | electron/collaboration/unified-host.ts；electron/orchestrator.ts；station-service.ts | 原命令单次提案测试；真实 Codex Host→批准→Worker 完整链 |
| 完整交付与分配 Q72、75、96 | 按完整交付建任务；手动审阅责任设备，自动由 Host 提议；批准独立。派发固定获准设备，不按 activeTasks 静默覆盖，忙时等待；已接工作不迁移；稳定 planTaskId 去重 | station-service.ts；unified-policy.ts；services/remote/device/collaboration_store.py | 固定目标、重复派发、依赖与循环拒绝、实际模型链 |
| 本机勾选 Q73–74、78 | 创建 participants=[]，本机不默认选入；勾选成为候选仍核验能力／授权／名额；取消候选保留席位和已接任务 | SharedMeetingEntry.tsx；UnifiedMeetingParts.tsx；collaboration_store.py | Hub 回归与 A 未选／B 已选界面检查 |
| 可读计划／任务／成果 | 原计划正文编辑真实保存，显示设备容量／等待数量；任务表、看板、详情同源。新增共享结构化报告适配原 DeterministicDeliveryReviewer，检查当前 task／attempt 和实际退出；真实命令退出码、准确 Git 成果、图片／文档／Diff／PR 可读 | PlanMeetingModal.tsx；TaskInspector.tsx；DeliveryViewer.tsx；electron/collaboration/delivery-report.ts；git-files.ts | 计划 UI、失败测试阻断／旧 attempt 拒绝、Git 回环；真实 GitHub 待指定仓库 |
| 简明设置 Q80、83、86 | 三常规区域；检测复用原 Station 登录、backend 注册与认证，保留独立 Agent 设置；GitHub GCM／gh 本机状态和浏览器登录入口；普通目录／仓库当前流程授权，文字不要求仓库 | UnifiedCollaborationSettings.tsx；RemoteControlSettings.tsx；station-service.ts | 两侧类型、包启动、契约；完整真实账号／GitHub 登录动线待实机 |
| 高级与旧兼容 Q80、84 | 原高级恢复、LAN／自托管、服务地址、并发、权限、撤销、原生桌面能力保留。Pocket Vibe adapter 不删除；旧会议仅在无在途工作且核验后迁移 Host 权威，保留业务 ID 和旧线程历史，不假称转换原生线程 | CollaborationPanel.tsx 高级；station-service.ts meeting.migrate；collaboration_store.py | 迁移拒绝在途任务、保留身份协议测试；旧用户记录实机待验收 |
| 稳定邀请 Q85、87–89、97 | 原＋／Participants 按设备展示真实 Agent；同设备同 Agent 去重，跨设备分开，离线保留卡片；不因多任务复制成员；运行中邀请不换 Host 或改现有安排 | UnifiedMeetingParts.tsx；unified-meeting-store.ts；collaboration_store.py | Hub 去重和取消候选回归、React UI |
| 群聊与专家 Q81、88、95、100 | 原 @／搜索／键盘／语音点名复用；普通 Host、明确 Agent、明确 task 和原生路径互斥；Host 可咨询指定专家。加入不调用模型；独立讨论与执行 Worker 分开，不要求逐一联系执行者 | SideDrawer.tsx；App.tsx；station-service.ts discuss/coordinator；collaboration_store.py | 实际 @ 与任务关联 UI；真实 Worker 并行独立讨论且 thread 不同 |
| 三类上下文 Q89、93、97–100 | 会议成员讨论、每个业务任务、明确原生对话分开持久化；按需背景包含目标、计划、近期 Host 决定摘要和相关成果，排除完整原生历史及私人专家讨论，限制输入大小 | unified-policy.ts；meeting-input.ts；production-types.ts；station-service.ts | 背景隔离／授权拒绝测试、实际模型独立线程 |
| 附件／屏幕／技能保留 | 原 ASR、TTS、屏幕选择／视频预览、截图、拖放、附件解析和斜杠入口保留；选定资料经准确 Git 引用读取，复用原 docx／PDF／图片解析器，Codex localImage 实际输入；已安装技能按明确选择加载说明 | App.tsx；UnifiedMeetingFrame.tsx；meeting-input.ts；services/remote/device/station_codex.py | 合成图片真实识别＋双文件实际产出；真实麦克风／用户屏幕及复杂技能完整实机未运行 |
| 原生接续 Q89–90 | 明确设备／标题／原生身份，沿用原 Gateway 串行和原权限／目录；摘要入主聊天，历史留详情；同一原生指令不再由 Host 拆派 | NativeHistory；NativeExecution；codex_shared.py／codex_shared_service.py | 33 项原生 Python 兼容及 Node 原生回环；用户 Codex 桌面实机待验收 |
| 首页／项目 Q91、94 | 原首页、最近项目、默认 Host、恢复保留；纯文字免目录，新目录／仓库就地授权；共享主项目开始文件任务后固定，换项目用另一会议 | Lobby.tsx；SharedMeetingEntry.tsx；collaboration_store.py | 首页返回／恢复同任务 UI、主项目／跨会议依赖协议测试 |
| 加入和授权 Q80、86、92 | 无项目也能加入查看交流；执行前各端独立目录授权。同一仓库可不同路径。资料读取核验指定 Agent 的项目授权；文字工作禁用文件／命令／网络／MCP 工具，明确共享的文档／图片作为本轮输入 | station-service.ts authorize/startTask；meeting-input.ts；station_codex.py | 未绑定／错误 Agent 拒绝、真实文字模型、原权限回归 |
| 任务补充 Q98 | 原 TaskMailboxPanel 结构复用，新增 Chat 明确关联任务；普通 @ 不猜最新任务，不广播；保存、边界投递、停止后编辑／忽略及明确继续分别展示 | SideDrawer.tsx；TaskMailboxPanel.tsx；unified-meeting-store.ts；collaboration_store.py | 明确路由与单任务 mailbox 回归、UI 关联任务发送 |
| 中断／暂离 Q99 | 底部明确 Host、指定任务或全部；全部再次确认并覆盖本会议 Host、任务和明确讨论／原生轮次；保留真实退出再释放名额。首页／Leave 只离开视图；仅凭保存凭据不拦截原单机关窗 | UnifiedMeetingParts.tsx；orchestrator.ts interruptHostReply；station-service.ts；main.ts | 范围 UI、守护进程真实退出、协议停止／恢复、隔离包重启 |
| 原功能保护 Q82 | 保留其他 Agent 本机、语音、屏幕、技能、记忆、IDE、恢复与交付入口；去多 Agent 前置开关时解除普通输入强制任务包装；协作出错不阻塞原本机入口 | App.tsx、MeetingControls／Header、dispatch-mode、orchestrator；UNRELATED_FUNCTIONS_AUDIT.md | 两侧类型、全量同条件基线；不将代码保留等同全部物理实测 |

## 本轮实际修复的整合问题

- 共享 UI／任务投影及唯一原 Host 统一，固定提案目标，真实报告进入原检查规则，计划正文编辑与容量接通。
- 群聊明确 task 路由、独立专家上下文、精确中断、暂离生命周期及关闭责任范围。
- Windows 原子记录临时文件超长路径，新增长路径实际守护进程回归。
- 实际模型发现的流式交付竞争：先原子保存 finalSummary，再发布退出；同 task／attempt 的成果生成串行，重试沿用已保存正文，避免分片换行或重复发布。
- 纯文字执行与资料权限边界：不通过文字任务绕过文件／命令授权，选定资料同时核验本机绑定与 Agent。
- Codex Host 的旧默认模型不可用时，改用已存在的 GuardedCodexExecution 真实模型目录选择；命令格式失败清楚反馈、保存输入和线程，允许用户继续修订，不陷入永久核对阻塞。

## 验证结果与证据

| 验证 | 本轮最终结果 |
| --- | --- |
| Renderer＋Electron 类型检查 | 两侧通过，typecheck-frozen.log |
| 正式构建 | 通过；保留 Vite 大 chunk 提示，无编译错误 |
| 统一模块回归 | 9／9 通过，含并发交付／正文精确性、上下文隔离与资料授权 |
| 全量 Node | 1054 项：1015 通过，34 失败，5 跳过；有效基线 1045 项：1006 通过，34 失败，5 跳过；逐一比较失败名无新增 |
| 既有失败 | 进程观察／ps、lsof、Kimi、Qoder、符号链接与文件监听等用例；完整 34 项名称见 baseline-comparison.json，未宣称全绿或全部归因同一问题 |
| Python／协议 | Guardian 10／10、原生兼容 33／33、导出／探针 4／4、基础契约 4／4 通过；v2 的 19 个共享校验案例在 Node 全量中与 Python 一致 |
| MySQL 5.7.18 | 最新串行演练通过：迁移保留／操作 SQL／DML 权限、16 项统一协议、8 项旧协议、7 项 Station 集成 |
| 真实模型 | 最终统一链通过；独立核验确认原生正文＝持久 finalSummary＝两端成果，纯文字运行配置及独立专家线程有效；另有真实图片＋双文件产出 |
| Windows NSIS | 构建、包内来源／组件核验通过；安装器实际载荷匹配且双隔离进程启动／OS 凭据恢复／WSS 重连通过；未覆盖用户安装 |
| 导出部署包 | 33 文件 Hub 清单／Unix 权限／独立导入及导出测试通过；云端容器与部署未执行 |
| 公网／实机 | 原域名只读健康和就绪 200，未认证 snapshot 401；实际第二台电脑／公网新版本／真实 GitHub PR／用户 Codex 桌面仍待验收 |


证据目录：`release/unified-meeting-delivery/verification/`；原始日志全部留在 `runtime/unified-meeting-2026-10-22/`。`DELIVERY_INDEX.json` 列出本轮证据和作用边界；`CHECKSUMS.json` 给出实际交付文件 SHA-256。

真实模型：使用本机正常 Codex 登录，原 Host 生成计划、明确批准、指定接收端执行、实际正文核验、持久收据／退出、两端一致，并验证独立专家 discussionThread 不等于 Worker thread。另用合成四象限 PNG，经真实 localImage 输入生成两份文件并由独立脚本读取核对。均未向用户真实项目写文件，未据此声称公网／双物理机／真实 GitHub 验收。

Windows：实际 NSIS 构建；包内源码／原生组件清单与当前来源比对，内置接收组件 frozen 自检和 Codex 0.144.1 检查。实际安装载荷解包比对及启动／OS 凭据恢复／WSS 重连单独留证据。没有覆盖当前用户安装。候选包没有发布者签名。

UI：在真实 React 原框架配合显式界面夹具检查 @、计划正文编辑／批准、容量等待、同任务看板与详情、明确任务关联、停止范围、首页恢复、Chat 和屏幕入口。截图带“界面交互夹具／无模型／无公网验收”标识，不能冒充真实双机。

MySQL：本机独占 MySQL 5.7.18 迁移演练，通过账号／凭据／旧设备保留、SQL 可重复执行、Compact 默认／Dynamic 表、版本标记保护及 DML 应用账号验证。当前 Hub 的 16 项统一协议、8 项旧协议及 7 项 Station 集成在串行演练通过。前两次出现 Windows 临时表重命名权限拒绝和临时 worker 观察窗口超时，原始失败保留；未改写无关测试来消除失败，也未在生产数据上试验。

中间失败说明：最初错误 Node loader、遗漏原生组件的基线尝试不计作有效基线；有效基线为 baseline-final-node.log。真实 Host 早期出现不合规字段／验收条件对象，保留日志并修复提示和失败恢复；真实交付竞争失败保留，按代码修复后重新验证。一轮测试进行期间新增回归用例与旧编译产物混用，记录为中间无效构建，最终只引用冻结来源重新编译后的结果。

逐项正式边界见 [T01–T45 验收矩阵](UNIFIED_MEETING_ACCEPTANCE_2026-10-22.md)。不把 5 项跳过或基线 34 项失败算作通过，也未因保持原功能边界而修改那些无关模块。

## 安装与部署材料

所有最终交付位于 `release/unified-meeting-delivery/`：

- `AhaStation Setup 0.19.0-collaboration.2.exe` 及 blockmap。
- `source/ahastation-collaboration-source.zip`：包含当前已跟踪和必要未跟踪源码、文档与测试；附完整源码清单和基底提交，不暗示已 Git 提交。
- `deployment/ahastation-hub-source.zip`：压缩包根 Dockerfile、当前 Hub／契约、MySQL 5.7 操作 SQL、部署／升级／回退说明及逐文件哈希；已从导出目录独立导入服务验证。未实际构建云端容器。
- `deployment/ahastation-wss-probe-source.zip`：原 WSS／心跳探针，供隔离测试环境使用。
- `deployment/ahastation-mysql57-upgrade-materials.zip`：操作 SQL、迁移核验和升级／回退说明。schema=2 的当前库本轮无新增 DDL。
- `verification/`、`CHECKSUMS.json`、本报告、使用说明和验收矩阵。

可以继续复用当前微信云托管 Hub：`https://ahastation-hub-220629-6-1398334410.sh.run.tcloudbase.com`。本轮只读检查 /health、/ready 均 200，未认证 v2 snapshot 为 401。材料中的 prod 是环境标签，不能据此判定不可用；也不能用 200／401 认定新扩展已部署。统一会议需要同版 Hub 的 unified-meeting-v1 能力。保留原域名、账号、HUB_SECRET、数据库与设备身份即可受控升级，不要求新建或清库。

升级／回退详见部署包 `docs/UNIFIED_MEETING_UPGRADE.md` 及 [MySQL 5.7 说明](MYSQL57_HUB_UPGRADE.md)。新统一会议不能直接交给旧 SharedCoordinator 消费；回退必须保持兼容协议，或在确认相关执行真实退出并保存增量后，由操作者恢复匹配的数据库与服务版本。不得在在途任务上盲目切旧镜像或覆盖数据库。

## 实际使用流程与尚缺条件

操作顺序：设置接入 → 首页选项目／目录和 Host → 原＋邀请设备 Agent → Chat 普通目标／@ 讨论 → 审阅计划并选择责任设备 → 明确批准 → 各端本机授权后执行 → 原任务界面看真实状态／审批／补充 → 文件、测试、准确提交及 PR → 检查与最终验收。纯文字省略 GitHub 和项目步骤。详细见 [使用说明](UNIFIED_MEETING_USER_GUIDE.md)。

剩余外部验收条件：

1. 第二台 Windows 电脑，安装同版、登录同账号；用户已说明目前只有本机，因此尚未开展实际双机。
2. 可部署的隔离云测试环境及正常管理端登录／发布权限。当前只确认现有 prod Hub 可访问，没有新增生产发布授权或管理端条件；本轮未部署或重启它。
3. 用户指定的真实 GitHub 测试仓库、两端正常登录和授权目录，验证准确提交／PR／成果获取；未自选用户项目上传。
4. 由用户在选定的真实 Codex 桌面对话上完成串行交接、双向停止和历史核对；以及实际麦克风、屏幕／声纹／IDE、其他 Agent 与复杂技能的完整实机回归。现有自动测试和协议夹具不能替代这些操作。

Git：全部变更仍在 `etrnal-dev` 未提交工作树，包含本轮之前已有的未提交内容；没有新增提交、推送、创建 PR 或生产部署。源码包包含必要未跟踪实现，不能只使用 git diff --stat 的已跟踪统计判断交付范围。

## 复现入口

在本工作树运行，先将实际 Node 目录加入 PATH，并设置 COLLABORATION_PYTHON／POCKET_VIBE_TEST_PYTHON 指向已具依赖的 Python。Windows 本轮为 Node v24.22.0、Python 3.13.5。

```text
npm run typecheck
npm run prebuild:native
npm run build
npm run test:collaboration
```

本轮全量采用 `node --test --test-concurrency=1 --test-timeout=120000`，使用 tests/electron-stub.mjs 的 register loader，参数详见 package.json 及原始执行日志。不要把该 resolver 文件直接作为普通 --import 模块。

可重复验证脚本：`scripts/real-unified-two-stations-smoke.mjs`、`scripts/verify-unified-delivery-evidence.mjs`、`scripts/real-unified-files-smoke.mjs`、`scripts/rehearse-collaboration-mysql.py`、`scripts/verify-station-windows-package.mjs`、`scripts/packaged-collaboration-smoke.mjs`。真实模型脚本使用本机正常登录并只操作各自临时目录；第二个是离线证据核验，不再次调用模型。

本轮 Windows 打包在已准备的依赖上用 electron-builder --win --x64 --publish never --config.npmRebuild=false，输出到本交付目录；包内实际原生运行时随后自检和启动核验。未提交／推送／发布生产。
