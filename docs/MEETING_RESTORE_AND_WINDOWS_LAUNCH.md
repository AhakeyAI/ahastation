# 会议恢复、独立启动与冲突检查（2026-10-13）

## 使用

Windows 日常测试双击仓库根目录 `Start-AhaStation.cmd`。需已安装项目依赖、Node.js 22+ 和 Git。入口自动寻找工具、切换到仓库目录，检查和构建 renderer/Electron，然后启动应用。成功后启动窗口退出；错误时保留窗口和日志路径。它只启动应用，不发送模型任务。

这个入口使用 `app://bundle` 的本地构建文件，**不启动或复用 Vite**，因此既有 Vite、5173 端口冲突或 Vite 停止都不影响这一入口。开发者仍可使用原 `npm run dev` / `npm run dev:electron` 和打包脚本；这些命令的 Vite/HMR 和等待 Electron 退出的行为保留。DevTools 改为显式 `VIBE_MEET_DEVTOOLS=1` 或原快捷键打开。

重启后项目显示“项目记录已恢复 · 会议未启动”，点击“继续会议”。启动中按钮禁止重复启动；收到真实主 Host 就绪事件后开放聊天和远端会话选择。失败显示实际错误，可重试或回首页选目录。恢复/继续不自动发欢迎模型指令。远端登录成功和会议启动是两个独立条件；按钮禁用时显示相应原因，不再把未启动表现成已加入/Ready。

多项目仍沿用原 TabStrip，可切换、继续、重试和关闭。单项目也有可见继续入口。“首页 / 选择目录”不强制结束其他会议；Leave 关闭当前项目，最后一个项目关闭后回首页。零项目任务看板也有返回首页入口。用户的首页/看板选择会使迟到的启动恢复读取失效，不立即被恢复记录替换。

## 确认原因与边界

恢复问题已由生产 meeting-store 和组件回归确认：hydrateRestore 只建立 placeholder，running=false，sessions.open 为零；原桌面单项目隐藏 TabStrip，恢复点击入口随之消失，SideDrawer 被禁用。这不是远端未登录或讯飞 ASR 未配置。修复保留按需恢复，并区分 restored / starting / ready / failed / ended。

`scripts/dev-electron.mjs` 最后的 spawnSync 会等待 Electron 退出，确实形成长驻启动调用及父子关系。**“Codex 停止任务清理了 Station”仍是推测**：没有捕获用户那次关闭的完整日志，不能据父 PID 或 Node detached 选项宣布 Codex 生命周期隔离已验收。

新入口由用户从资源管理器双击，不依赖当前对话的长驻命令。Node 启动 Electron 使用 detached、独立 stdio 和 unref；Windows 每用户/仓库内核 Mutex 避免双击并发构建，进程退出释放 Mutex。遵循 [Node 子进程文档](https://nodejs.org/download/release/latest-jod/docs/api/child_process.html#optionsdetached)，不承诺从任意外层 Job 强行脱离。没有添加 Job breakaway、进程注入或绕过自动审批的路径。

此前实际独立启动工具操作被自动审批以 **“blocked by policy”** 拒绝。本轮没有重试该操作或绕过拒绝；交付脚本与真实应用双击/停止 Codex 的验收分开记录。已运行的是独立临时目录中的 Node 进程 fixture，不是 Station GUI。

工具查找优先 PATH，然后常用当前用户/系统安装位置及现有 Codex 主运行时依赖位置；不固定用户名、PID 或版本哈希。检查 Node 版本和 Git --version。只调整子进程 PATH 和启动相关环境，移除继承的 ELECTRON_RUN_AS_NODE、NODE_OPTIONS、VITE_DEV_SERVER_URL、VIBE_MEET_DEVTOOLS；不修改全局环境、HOME、CODEX_HOME 或认证文件。Node/Git 缺失、依赖缺失、构建和 spawn 失败会显示错误；不会自动安装或改变登录。

## 日志

双击入口的每次日志保存在 `%TEMP%\AhaStation-launch\<时间>-<启动器PID>`：

- launcher.log：工具/构建阶段、退出码、Electron spawn 和启动失败。
- lifecycle.jsonl：主进程 PID/父 PID、窗口创建/关闭、加载成功/失败、renderer/子进程退出、before-quit、will-quit、quit 和 process-exit。

常规开发/打包启动使用 Electron logs 目录；无法取得该目录时回退 `%TEMP%\AhaStation-lifecycle`。已运行的单实例保留原实例的日志目录，后续双击会激活该实例。日志不记录参数、URL、环境、聊天内容、密码、Token 或配对码；不拦截默认异常退出。被系统直接终止可能没有 quit/process-exit 尾记录，缺少记录本身不能证明谁终止了应用。遇到再次关闭请保留最新两份启动日志和原实例生命周期日志。

## 核心调用链检查

| 触发条件 / 位置 | 影响与处理 | 证据 |
| --- | --- | --- |
| 单项目 placeholder，App/TabStrip/SideDrawer | 恢复入口被隐藏、假就绪标签；新增继续横条及会议状态门禁 | 生产组件静态渲染 + store 实际 open/send/addHost 调用 |
| 重复继续、启动 IPC 拒绝、异步启动失败，meeting-store | 共享每 cwd 的 in-flight；失败可见、保留原远端引用后重试 | 延迟/拒绝 IPC、连续点击回归 |
| open 回复前已发 ready，meeting-store | 早到就绪事件丢失会一直 starting；限量缓冲并按真实 sessionId 回放 | 生产 open 中同步发送 ready 的回归 |
| 启动期间关闭、快速切换，meeting-store | 迟到 open/event 不能复活项目；关闭只清理自己返回的会议，选择有版本保护 | 并发恢复/关闭/迟到选择回归 |
| Renderer 重载或首页立即打开已有目录 | main 仍有会议时 duplicate 过去丢掉 placeholder、只剩不存在的 active ID；现在查询实际 hosts/readiness 并接入原会议，不新启模型 | 两条 duplicate 接入回归 |
| 打开一个项目后保存、关闭占位、应用退出，sessions IPC/store/main | 保存仅 registry 会丢其他占位项目；退出先清 registry 会丢原成员；保留引用、显式按 cwd 移除，退出先捕获快照 | 生产 IPC/真实设置文件读写回归 |
| 附加 Host 先就绪/失败 | 不得改变整个会议主 Host 启动状态；仅更新对应成员 | ready/failure 和远端失败路由回归 |
| 切换默认 backend 设置 | 设置是未来会议的偏好，不能给正在运行的 Codex 改名为 Claude | 生产 store 回归 |
| 设置窗口启用/登录/退出，remote-control/preload/App/Lobby | 主窗口过去只依赖 focus；新增无敏感数据的变更事件，串行刷新，丢弃过时结果 | 合法设置窗口 IPC + renderer observer 回归 |
| placeholder 的邀请、popout、编辑器入口 | 不发送 placeholder ID 给要求真实会议的 IPC；聊天/远端选择等到主会议 ready | IPC 调用记录、入口门禁检查 |
| 主窗口关闭但设置/AhaBar 仍开，main | second-instance/activate 原来找不到主窗口便返回；现在完成初始化后重建/显示/恢复/聚焦 | 窗口 fixture；macOS 原生仍待验收 |
| 本地/远端 @、语音规范化点名、附件、精确取消 | 沿用原远端目标/hostId 绑定、文件拒绝和 submission 归属保护；无本机回退 | 原 renderer/adapter/orchestrator/语音/取消回归及全量测试 |
| Bridge 共用服务、队列、停止、断联、换代 | 未改变实现：同会话串行、不同会话并行、只停自己 turn/terminal、证据不足阻断、断网不自动取消或重跑 | 原共享协议及 Windows/WSL 进程测试；不是 GUI 验收 |
| 本地 CLI/Git/认证、IPC 调用方 | 原本地 backend 与安全环境隔离保留；合法设置窗口没有被改成 main-only；未删除校验/权限检查 | 后端/设置/IPC 现有测试与启动环境 fixture |

没有发现需要本轮修改 Hub、数据库、配对、Bridge 执行通道或取消协议的新增冲突。没有把 ASR 配置当作文本或远端问题。未做新安装体系、文件同步、语音播报或调度重构。electron/main.ts 仅作上述日志、焦点和退出快照的必要增量，未覆盖其他内容。

## 本轮实际验证

本轮修改文件（不含开始前已有的其他差异）：

| 文件 | 用途 |
| --- | --- |
| src/App.tsx、components/MeetingResumeBanner.tsx、SideDrawer.tsx、TabStrip.tsx、Lobby.tsx、src/styles.css | 单/多项目恢复入口、首页导航、状态标签、门禁与可见错误 |
| src/lib/meeting-store.ts、meeting-availability.ts、src/hooks/useWorkers.ts | 按需恢复、并发/迟到保护、保存原目标、真实会议 ID 与就绪状态 |
| electron/ipc/sessions.ts、electron/store.ts、electron/orchestrator.ts、src/types.ts | 懒恢复引用保存/移除、退出快照、已有 Host 就绪查询及类型 |
| electron/remote-control.ts、preload.cjs、src/lib/backend-refresh.ts | 设置变更通知及主窗口串行刷新 |
| Start-AhaStation.cmd、scripts/launch-station.mjs、electron/main.ts、main-window-focus.ts、lifecycle-log.ts | 独立构建启动、单实例窗口恢复、显式 DevTools、持久退出日志 |
| tests/meeting-restore.test.mjs、meeting-restore-ipc.test.mjs、station-launch.test.mjs、renderer-remote-sessions.test.mjs、electron-stub-impl.mjs | 18 项新回归、现有远端测试 fixture 补齐生产 API |
| 本文、本轮基线 JSON、POCKET_VIBE_BACKEND.md、PUBLIC_REMOTE_CONTROL.md；Bridge 的 BRIDGE_PRODUCT.md、SHARED_DESKTOP_ACCEPTANCE.md | 使用、冲突证据、当前失败比较与未验收条件 |

以当前工作树构建后执行测试，未使用历史结果代替基线。renderer/Electron 两套 typecheck 通过；renderer Vite 构建、清理后 Electron tsc 与 preload 拷贝通过。Vite 有既有大 chunk/动态静态混合导入提示，未为消除提示改动无关模块。

- Station 修改前：913 项，868 通过、40 失败、5 跳过。
- Station 最终：931 项，886 通过、40 失败、5 跳过。新增 18 项；失败名称逐项差集为空。详见 `MEETING_RESTORE_LAUNCH_BASELINE_2026-10-13.json`。
- Python Windows 修改前/后均：110 项，91 通过、1 失败、18 跳过。失败均为 `test_other_bridge_live_lock_and_current_task_state_priority`；目录测试单独 10 项重跑仍为同一失败（cleanup-unconfirmed 与 waiting 不符）。本轮未改 Hub/Bridge 代码或该测试，不将它称为通过，也不按历史零失败忽略。
- Python WSL Ubuntu：110 项，93 通过、17 跳过、0 失败，含既有 Linux 真实进程监管。
- Windows 临时 Node 进程：普通启动器退出和强制终止启动器后，子进程仍更新文件；发送测试自己的停止标记后核对其 PID 已退出。只操作测试进程；这不等于停止 Codex 对话或 Station 实窗测试。

Station 的 40 项失败涉及观察进程/平台解析、Kimi/Qoder、调度权限和部分会议流程等现有测试；具体名称保存在本轮 JSON，未为了全绿修改这些模块。上述 Windows Python 状态优先级失败是当前基线问题，若实际使用 LAN 目录出现未确认状态仍需另案定位，不能拿 WSL 结果代替 Windows。

## 中断后续修与独立复核（2026-10-13）

上节保留首轮实现的历史结果。后续先核对当前 Git 状态、差异与实际日志，确认恢复界面、设置刷新和独立启动入口已经落盘，但以下两个遗漏尚未修复。旧的审查全量日志没有最终汇总，未把中断前的口头进度算作验证结果。

1. 既有主 Host 已结束时，renderer 重载接回注册表会议，原 `ready=false` 无法区分启动与结束，导致一直显示“启动中”。现在 Host 查询返回明确的 starting / ready / ended / failed 和失败原因；初始化阶段尚无 backend 实例仍保持 starting。接回已结束会议显示“继续会议”，失败显示“重试会议”，按明确项目 ID 重试并保留远端引用。查询前的就绪事件先于快照应用，查询期间的退出/认证失败事件仍会关闭门禁，不自动发送模型指令。
2. 多项目恢复遇到迟到的 duplicate 回复时，主进程会切到回复中的会议，原接回分支却只保留 renderer 的当前项目。现在新增会议和接回既有会议共用焦点同步，恢复完成时将主进程同步到用户当前选中的真实会议；同步失败显示错误。分别覆盖 open 回复迟到和 Host 查询迟到的情形。

本次仅增量修改 `electron/host-group.ts`、`electron/orchestrator.ts`、`src/types.ts`、`src/lib/meeting-store.ts`，扩展恢复测试并新增 `tests/meeting-host-lifecycle.test.mjs`。保留其他已有修改；未修改 Bridge / Hub 业务代码、云端配置和启动生命周期实现。

实际证据：

- 修复前新增的三项回归全部复现失败：14 项中 11 通过、3 失败。
- 本次新增 6 项回归；恢复、Host 生命周期、IPC、独立启动、远端 renderer 共 27 项全部通过。
- renderer / Electron 两套类型检查通过；Vite 构建、清理后 Electron 构建和 preload 拷贝通过。Vite 仍有原有大 chunk / 混合导入提示。
- 指定本地 Bridge 虚拟环境 Python 后，全量 **937 项：892 通过、40 失败、5 跳过、0 取消**。40 个失败名称与首轮基线逐项一致，没有新增或消失的失败；三个 Bridge / Hub / Station 本地协议联调用例实际通过。联调用离线执行器，不代表真实 Codex Desktop 操作验收。
- 全量使用 Node 的 `--test-force-exit`，避免已知失败用例留下句柄使测试进程挂住；未修改测试断言。该结果不证明所有测试的资源退出均已修复。
- `git diff --check` 通过。可重跑命令、源文件 SHA-256、失败名称和日志位置见 `MEETING_RESTORE_FOLLOWUP_2026-10-13.json`；原始日志保存在本地 `audit/meeting-restore-followup-20261013/`。

这两个问题在代码与自动回归层面已修复；原有 40 项全量失败以及下述真实 GUI 验收仍保留，不宣称整个产品已经验收通过。

## 待人工/原生验收

真实 Windows GUI 双击、关闭启动窗口、继续当前 Codex 对话与点击“停止对话”；单/多项目的屏幕操作、目录选择、设置登录后的主窗口刷新；真实 Desktop ↔ Station 共用服务接续/停止/临时断联；macOS/Linux 原生 GUI、macOS activate、ARM64 包、MySQL、公网、Claude 登录/模型及麦克风均未在本轮验收。协议模拟、组件静态渲染和 Windows Node fixture 不能替代这些项目。本轮没有模型调用、云端部署、提交、推送或发布，没有新 Bridge 二进制；旧交付清单和 Hub/WSS/Bridge 包保留。
