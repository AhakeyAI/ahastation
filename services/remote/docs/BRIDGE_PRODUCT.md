# AhaStation Bridge 0.2.0：远端电脑

Bridge 使用现有扫描器、Codex/Claude 适配器、执行队列和原生会话锁。公网身份是 Hub 所有者身份；CLI 认证是电脑本地认证，两者不同。代码提供独立本地设置及托盘入口，不需要每天打开网页控制台。

## 普通使用

1. 安装/解压对应 **OS 和架构**的 Bridge 交付包，Windows 双击 `AhaStationBridge.exe`，macOS 将 `.app` 放入 Applications，Linux 解压运行 `AhaStationBridge`（桌面环境和托盘支持需本机验证）。交付包自带 Python。Windows/macOS 可选择已安装并登录的 Codex 桌面版，无需另装 CLI；独立 Codex CLI 和 Claude 的原有配置仍可使用。
2. Station 设置 → 远端控制 → 注册/登录远端身份，保存原生系统窗口展示的一次性恢复码，点击添加电脑。Bridge 中输入短时配对码与运营者提供的 HTTPS 地址。
3. Codex 选择“Codex 桌面版”，点击“识别 / 检查登录”，确认组件版本、来源和登录；普通用户不用填路径。首次启用在合适时机自行退出旧桌面，再点击“启动联动桌面”。选择允许访问的项目根目录、只读或 workspace-write 授权上限并确认，不再勾选手动释放会话。桌面模式保留原生服务中的模型、权限和审批；配置无法确认或超过授权时拒绝执行。独立 CLI / Claude 或手工组件路径在高级设置，两种 Codex 路径分开保存；独立 CLI 仍使用外层 `exec --sandbox ... -c approval_policy="never" resume 原生ID`，Claude 保留 plan/default 及原生审批。当前 Windows 有 Station 捆绑 Claude CLI，但独立认证检查未登录。
4. 可选择“登录电脑后自动启动”，只修改当前用户启动入口：Windows HKCU Run、macOS user LaunchAgent、Linux XDG autostart。关闭设置窗口保留后台 Bridge，托盘可重新打开。只有托盘后端就绪且图标显示成功后才隐藏窗口；创建对象或 `run_detached` 返回不等于就绪。无托盘、启动异常、图标显示失败或尚未就绪时，关窗和后台启动均最小化，保留任务栏恢复入口，也可重新打开程序显示设置。托盘错误独立显示，不被连接状态覆盖；失败后清理部分托盘状态及固定版本 pystray 等待就绪的 setup 线程。显式退出仍等待任务监管清理。
5. Station 参与者 → Pocket Vibe → 选择远端会话，按电脑/provider/原生会话筛选并加入。文本或唯一会话标题语音点名沿用原会议；远端不接受附件。新增授权根下项目和可识别原生会话可直接刷新；根外项目需在 Bridge 设置增加授权。保存设置会停止本 Bridge 的当前任务并在退出核对后重新连接。
6. 更新检查仅查询协议、版本和运营者下载地址并提示安装，不静默安装。明确退出/解除配对会请求停止本 Bridge 管理的任务并等待监管处理；无法确认退出的记录不删除，后续相同原生会话仍阻断。关闭 Station/网络断开不等于取消。

设备身份/凭证/项目配置位于当前 OS 用户 `.pocket-vibe/remote`，稳定设备 ID 和会话锁沿用 `.pocket-vibe`；Windows Token 用 DPAPI，POSIX 用户目录 0700、文件 0600。恢复记录绑定服务 URL+owner；换 Hub/重新配对不会向别的所有者补交历史反馈。结果需 Hub 持久化 ACK；默认七天后只保留防重复执行所需收据、启动意图和最小退出证据，不复制原生会话历史。不要手删未确认记录。

换服务或所有者后需要逐个provider重新确认根目录/权限，不自动沿用另一个所有者的provider授权；同一所有者同一服务的凭证旋转可保留已有授权。公网HTTP/WS拒绝重定向以避免凭证转交到另一地址，运营迁移使用同一域名/DNS而非认证端点HTTP跳转。

## 构建和平台验收

开发者在每个平台安装对应 Python、Tk、原生打包依赖；普通用户不需要这些。使用本机实际 Python 路径：

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-bridge.txt
.\.venv\Scripts\python.exe scripts/build_bridge.py --output runtime/packages --service-url https://实际已部署且验收的地址
```

未部署时省略 `--service-url`，包和设置准确显示尚未配置。服务地址只有集中资源配置/运营环境入口；不会把 `hub.ahastation.com` 假设为已上线。原生平台范围：Windows x64、Linux x64/ARM64（包括 RK3588，需对应 glibc/桌面/Tk）、macOS Apple Silicon。在原生机器运行同一个脚本；PyInstaller 不能把本机包当成跨平台产物。见 [官方说明](https://pyinstaller.org/en/stable/usage.html)。使用 console **onedir**，以保留监管/CLI stdin/stdout；GUI Windows 启动后重启为隐藏控制台子进程，不能用 windowed/onefile 破坏子组件协议。

Windows 打包后自动执行 `--self-test`、`--component task_process --probe`，还应对解压包运行 `scripts/frozen_smoke.py --exe ...`，验证无外部 Python 的真实监管、结果、取消和退出证明。macOS 包是同一 console 可执行器外包 `.app`，与 launchd 监管共同验收后再签名、公证、分发；当前没有真实 macOS，未声称签名/托盘/自动启动/执行已通过。Linux 原生和 ARM64 也需实机，WSL 不能代替桌面及 ARM64 交付。

POSIX ZIP保留PyInstaller onedir的符号链接和可执行权限。macOS用Finder/ditto、Linux用支持UNIX链接的unzip/桌面解压器；不要用默认Python ZipFile.extractall将链接变成普通文本文件，再据此判定原生运行通过。

GUI 首次配对、关窗后台、托盘、自动启动、断网重连、两个电脑跨公网和麦克风分别依 [验收清单](ACCEPTANCE_PUBLIC.md)。旧电脑端控制台和 `device/desktop_agent.py` 脚本仍是高级维护入口，旧无目标/固定 ID 配置继续适用。

2026-10-11 无托盘降级回归使用生产 `TrayWindow`，注入启动异常、图标显示异常、延迟就绪及 pystray 部分 setup 状态，验证关窗/后台启动最小化、成功就绪后隐藏及显式停止。未打开原生桌面，不将这些测试称为 Windows/macOS/Linux 托盘实机通过；各平台原有构建入口和监管能力保留。

## 2026-10-12 桌面联动共享执行（当前实现）

桌面模式改用 `codex_shared_service.py` / `codex_shared.py` / `codex_shared_rpc.py`，不再调用独立 exec resume。独立 CLI、Claude 和原 LAN 调用保留。前一版独立恢复、归档/恢复释放 writer 的验证只是历史记录，见 ACCEPTANCE_PUBLIC.md，不能替代本版验收。

首次启用：在合适时机自行结束工作并退出旧桌面实例；Bridge 选择“Codex 桌面版”，检查自动识别/登录，点击“启动联动桌面”，确认授权项目目录及执行权限并配对。此入口拒绝自动退出、重启或接管运行中的非联动桌面，仅为此次联动启动移除会禁用 WebSocket 的 FORCE_CLI 环境覆盖，不修改全局环境。以后通过同一按钮打开桌面；Station 刷新、选择“Codex 桌面联动”会话并加入会议，使用现有 @ 成员聊天/语音文本流程。日常无需归档、恢复或勾选手动释放。桌面权限高于 Bridge 授权时明确拒绝，不能自动提升权限。

服务按当前 OS 用户使用现有内核锁管理单实例，自动发现当前桌面组件；独立 CLI 与桌面高级路径分别保存，切换模式不复用隐藏旧路径。原生服务只绑定 127.0.0.1，使用 capability bearer 验证；本机网关使用随机私有路径且拒绝 Origin。Windows 端点凭据用 DPAPI，原生 token 文件限制当前用户 ACL；POSIX 使用 0700/0600。凭据、历史、项目文件不传给 Hub。Bridge 退出处理自己的任务，保留仍可被桌面使用的共享服务。

本机安装包 26.1007.2314.0（客户端握手版本 26.1007.21434）、组件 0.162.0-alpha.17.2 提供内部 `CODEX_APP_SERVER_WS_URL` 接入。联动入口检查当前安装而不修改 app.asar、不注入进程。该桌面入口不是公开稳定接口；官方 [App Server](https://learn.chatgpt.com/docs/app-server) 的 WebSocket 仍属实验传输，不能据本机结果宣称所有版本支持。

两端使用同一常驻原生执行器。网关按原生 thread 串行准入，阻止 turn/start 把另一端指令当成 steer；桌面自己已有的 steer 保留。不同 thread 不共享全局执行锁。运行中的桌面任务完成且执行命令退出已确认后，等待的 Station 指令执行；Station 完成后桌面可再次提交。使用实际创建/恢复该 thread 的桌面 socket，已加载会话不重复 resume，以免重置权限；模型/权限沿用原生配置，超出授权拒绝。目录显式包含 vscode/appServer 等来源，并核对原 ID、真实 cwd 和本地恢复数据。命名权限配置只在有对应原生 turn_context 元数据时补充，未知则拒绝猜测。

停止等待项仅移除对应 Station 指令。执行中的停止绑定准确 threadId/turnId；本机组件单独 turn/interrupt 可能留下 CLI，因此先终止实时命令项所关联的原生 terminal，再请求该 turn 中断。桌面自己的停止同样经过此检查。不会 clean 整个 thread 的终端，不会杀整个执行服务或其他会话。收到请求/terminated 标志都不是退出证据：还须结束事件、完整任务项/实时命令项的真实 exitCode、以及该 thread 无未确认 terminal。历史缺少运行中命令项不能作为退出证明。证明不足显示“停止未确认”，保留收据、映射和阻断，后续不执行。脱离原生执行器管理的子进程与外部工具完整退出树仍需专项验收，不能用旧独立进程 Job 测试替代。

共享记录把 Hub task ID 映射到 threadId/turnId 与服务 generation。断网/Station 关窗不自动取消，重连只核对并补报，不重跑已交付任务。服务崩溃前写入的 Desktop/Bridge 准入记录在新 generation 保持未确认；PID 不存在、原 SID 空或服务重启都不是退出证明。恢复只核对原 turn，不删除记录绕过保护。Windows 服务创建原生后端沿用原子 Job；macOS/POSIX 服务故障不承诺任意子进程清理，原有独立执行监管不变。

本轮验证分类、实际结果、原生停止问题及待验收项见 [SHARED_DESKTOP_ACCEPTANCE.md](SHARED_DESKTOP_ACCEPTANCE.md)。完整 Desktop GUI ↔ Station GUI 接续没有验收通过；RPC 测试客户不能冒充桌面 GUI 操作。macOS 原生桌面联动、Linux/ARM64 打包、MySQL、跨公网、麦克风与 Claude 登录/模型仍待验收。

## 2026-10-13 临时断联后的自动核对

桌面连接断开时，已返回原生 turn/start 的任务也标记为待核对，保留准确 threadId/turnId、同代服务身份和实时命令记录。断联不取消任务，也不释放占用。重连、按会话查询 bridge/status、以及 Station 等待期间的自身 threadId 心跳均可触发核对；每会话只运行一个核对协程，核对后默认至少间隔 2 秒重试，单次查询预算 3 秒（独立恢复 WebSocket 的关闭收尾限 1 秒）。不依赖桌面再次发消息或补发丢失通知。

原生 turn 仍为 inProgress 时保持等待。终态还必须通过既有命令退出码、完整任务项、实时命令记录及后台终端检查；缺记录、超时或未退出显示“原生退出尚未确认/核对超时，保留占用，将自动重试”。确认前后检查当前占用对象、threadId/turnId、generation 和原生连接实例；证明成功后写本机 desktop-exits.json 的最小退出引用，再释放该会话并唤醒等待项。迟到通知与超时后的私有响应不会复活旧占用或清除新任务。

桌面重连后立即提交的新输入也必须先等待旧 turn 核对，不能按旧 running 记录误当成 steer。原连接中已知仍在执行的桌面自身追加输入保持原有行为；不同连接、待核对或已结束的任务走同一会话的现有准入队列。

即使桌面尚未重连，同一原生实例仍可只读查询并确认旧 turn 的退出。新指令仍沿用桌面 socket：连接尚未恢复时保留原 taskId、回执和等待项；同代桌面重新初始化后自动重新绑定连接并发送一次，不需归档、配对、手动释放或再打开原会话。此等待不是新增执行进程或重新提交。服务换代、原生身份冲突或缺少 turnId 仍保留无法确认的占用，不用新实例的 idle 猜测旧任务已退出。核对不修改模型/权限，不发模型指令，也不终止其他任务。CLI、Claude、Hub 协议/数据库及配对不变。

本次仅协议自动化与冻结程序验证；真实桌面 GUI 断联/重连后接续尚未验收。最新测试与交付路径见 SHARED_DESKTOP_ACCEPTANCE.md 和 runtime/delivery-manifest.json。

## 2026-10-13 Station 会议恢复与启动冲突检查

Station 重启后的项目记录需要点击“继续会议”，不等于 Bridge 未登录、配对失效或桌面仍占用。单项目现在也有恢复入口，会议就绪后选择远端会话；已保存的 device/provider/native thread/cwd 与每成员 hostId 沿用原引用。设置窗口启用/登录会主动通知主窗口刷新。

本轮仅 Station 会议/UI/启动和日志增量，Bridge/Hub/共享服务业务源码未修改；共享服务的精确 turn 停止、同会话锁、断联核对和换代阻断继续沿用原实现，未重建或替换现有交付包。Windows Station 双击入口是相邻仓库的 Start-AhaStation.cmd，不能拿 Bridge 取消或独立进程监管当作 Codex 启动对话生命周期隔离的证明。具体检查表、基线与未验收项见相邻 Station docs/MEETING_RESTORE_AND_WINDOWS_LAUNCH.md。
