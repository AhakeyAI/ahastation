# 桌面共享执行验收记录（2026-10-12）

当前代码已实现本机共享服务、联动启动、目录、按原生会话准入、桌面 socket 执行、原生停止、幂等/重连与故障阻断。**没有完成 Desktop GUI ↔ Station GUI 的完整验收，不能宣称该目标已全面通过。**

## 实际原生证据

- 本机 Windows Store 包 26.1007.2314.0，实际客户端握手 26.1007.21434，自动发现组件 0.162.0-alpha.17.2，已登录。安装包只读检查发现 CODEX_APP_SERVER_WS_URL；未修改安装文件/注入进程。
- 用新临时 profile 启动真实桌面实例，原用户桌面 PID 37220 始终未退出/重启；真实桌面 initialize 到达生产本机网关并转发同一个原生 app-server PID。使用同一 CODEX_HOME 本身不是证明；这里有独立桌面握手及单个执行服务的连接记录。
- 同一服务中的新原生测试会话连续保留 ID、cwd、marker 上下文，并在临时项目写 SHARED_ONE/GATE_ONE/GATE_TWO 文件，生产 Bridge 通道得到文本，之后原生 RPC 测试客户再次续发成功。对已加载会话改用原桌面 socket，避免额外 resume 把权限重置为只读。测试客户驱动的 turn 不冒充 GUI 中创建/发送的 turn。
- 首次真实停止测试揭露组件缺陷：turn/interrupt 返回、历史项完成，却仍写 heartbeat；有些运行中命令根本未进持久化历史。旧阶段返回的 cleanup=true 属于失败证据，不是最终产品通过。新代码记录实时 item，精确终止本 turn 的原生 terminal，核对真实 exitCode 和会话剩余终端；不以“历史中没命令”确认退出。
- 最后修正后的原生 Bridge 停止：会话 01a1306c-f965-79a1-b1de-e163e6870248，turn 01a1306c-fad3-7912-9ca9-d98ee98a35dc；35 秒 foreground PowerShell heartbeat 在确认后 3 秒内不再变化。相同 ID 随后返回 AFTER_CANCEL_OK。只操作新临时项目，未归档、fork、建替代会话或停止整个桌面/执行服务。桌面停止使用同一个精确 terminal/turn 路径，故障及不误停其他任务有协议测试；**真实桌面 GUI 点停止仍待验收**。
- 原始证据目录（本机）：%TEMP%/ahastation-shared-native-20261012-d（上下文/文件），%TEMP%/ahastation-shared-native-production-20261012（生产接续），%TEMP%/ahastation-shared-native-final-20261012 与 ahastation-shared-native-stop-20261012（失败），%TEMP%/ahastation-shared-native-proof-20261012（最终停止/后续指令）。URL/token 文件在测试退出时清理；记录保留，不打入交付包。

## 自动化与平台

生产代码的真实异步 WebSocket fixture 覆盖：桌面完成/停止后等待项执行、不同 thread 并行、几乎同时发送不跨端 steer、精确 turn 停止/ack 不代表退出、live item 与缺失历史、旧后台终端不被误停、未确认阻断及恢复、崩溃 generation 记录、重连/重复提交不重跑、权限不提升、CLI/桌面高级路径分离。fixture 模型不是原生 GUI 或模型验收。

本轮修改前 Station 912/867/40/5；修改后 913/868/40/5，具体 40 个失败名差集为空；renderer/Electron typecheck、两侧构建通过。最终 Windows Python 100 项：82 通过、18 跳过、0 失败；WSL Python 100 项：83 通过、17 跳过、0 失败。新增共享通道回归 19 项，全部通过，含桌面断线后在同一原生实例补报结果以及联动启动移除 FORCE_CLI 覆盖。Windows 原子 Job、WSL Linux subreaper/pidfd 原有真实进程测试保留。一次并行负载下 Windows 既有 cancel_snapshot_race 测试的 queued 门等待超时，未改业务或该测试；独立重跑9项通过，后续全量96/98/99/100项通过，记录此中间失败，不将其直接称为原始基线失败。

Windows 共享服务创建原生后端仍是原子 Job；服务崩溃保留活跃准入/收据，缺证明不放行。macOS/POSIX 共享服务正常执行使用原生 thread/turn 接口，但监管进程崩溃后任意脱离原生管理的后代不承诺完整清理；generation 不同保持阻断，PID/SID 消失不算退出。旧独立 CLI 的 Windows/Linux/macOS 监管不变。没有用 WSL 或模拟 darwin 宣称原生 macOS、Linux 桌面或 ARM64 打包通过。

待真实验收：GUI 桌面创建会话 → Station 选择/两轮修改 → 回桌面原会话可见并继续；GUI 桌面运行中停止 → Station 接续；GUI 两端同时提交及其他会话；Bridge/桌面重启和桌面更新后的发现；外部工具/脱离原生管理的子进程、原生子会话完整退出；macOS 桌面联动；Linux/ARM64 交付；MySQL、跨公网、GUI 配对/托盘、麦克风。Claude CLI 存在但未登录，不自动登录。

## 可重复检查

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe device\bridge_app.py --self-test
.\.venv\Scripts\python.exe device\codex_shared_service.py --probe
```

冻结包运行 `AhaStationBridge.exe --self-test`、`--component task_process --probe`、`--component codex_shared_service --probe`，后者明确为离线协议 fixture。原生握手诊断为 `scripts/probe_shared_desktop.py --directory 新临时目录 --desktop 当前可信安装exe --binary 当前发现组件`；该脚本仅独立 Windows profile，不自动发送模型任务，stop 文件触发只清理它创建的 Job。不要把登录、自检、只读查询或模拟平台当成上述 GUI 全链路通过。

本轮没有修改 Hub 协议/数据库/云端/DNS、部署、提交、推送或发布；Hub/WSS 交付条目原样保留。

## 2026-10-13 完成通知丢失后的恢复修复

本次先把协议 fixture 改为仅向该 thread 的订阅连接发通知，非订阅的 Bridge 查询连接不会收到完成事件。新增原复现场景在修复前失败（通知接收数为 0，Station 等待超时），修复后同一回执、taskId 和原生 thread 自动接续且只启动一个 Station turn。重连只需要 initialize，不增加 thread/resume、归档、配对或手动释放步骤。

新增 10 项回归，加上原有共享测试共 29 项：覆盖丢失 completed/interrupted/failed、无桌面连接时只读确认并保留等待项、任务仍执行、命令退出码/后台终端未确认后的自动重试、不同 thread 执行、重复重连及迟到通知、查询超时/证据缺失、占用对象/turn/generation 改变期间的迟到查询结果、私有查询迟到响应不进入桌面客户端，以及桌面刚重连即提交的输入先等退出核对而非误当 steer。真实异步 WebSocket 和可变状态用于测试；generation/占用替换是故障注入，不是原生进程换代实测。

Windows Python 修改前 **100：82 通过、18 跳过、0 失败**；最终 **110：92 通过、18 跳过、0 失败**。WSL 最终 **110：93 通过、17 跳过、0 失败**，包含原有 Linux 真实进程监管测试。Station 本次只改说明，renderer/Electron 两套 typecheck 通过；未重跑 Station 全量/构建，上一节 913/868/40/5 属于 2026-10-12 的验证，不冒充本次结果。

冻结协议探测新增“完成通知丢失 → 同代查询确认 → 等待槽位唤醒”检查，明确输出 fixture_only；交付包另核对源码哈希与冻结模块代码，并运行自检、原有 Job 探测/执行取消烟测。最新路径、SHA256 和冻结检查结果以 runtime/delivery-manifest.json 为准，旧包及 Hub/WSS 条目保留。

状态与重试条件见 BRIDGE_PRODUCT.md 的“临时断联后的自动核对”。已退出但桌面 socket 未恢复时等待项继续保留；实际发送仍等同代桌面连接，不改为新的独立执行器。查不到准确 turn、缺退出证据、原生身份冲突或服务换代不能宣称空闲；其中同代可核对的查询失败/证据不足按间隔重试，换代仍保留无法确认的占用。

**本次没有操作真实桌面 GUI、没有调用模型或连接已部署 Hub**。未完成真实桌面任务运行/停止中断联后重连接续、原生组件重启/换代、macOS/ARM64、公网、GUI 配对/托盘及麦克风验收。上一轮原生 RPC/模型测试和 Windows Job 探测不能代替本次桌面 GUI 断联验收。

## 2026-10-13 Station 恢复/独立启动本轮核对

Bridge 业务代码、Hub 协议、配对和 runtime/delivery-manifest.json 未变，本轮没有重打 Bridge 包或模型调用。Windows Python 修改前/后全量均为 110 项：91 通过、1 失败、18 跳过；同一失败 test_other_bridge_live_lock_and_current_task_state_priority（cleanup-unconfirmed != waiting），单独目录测试 10 项也复现。不能沿用上一轮 Windows 零失败作为本轮结果。WSL Ubuntu 全量 110 项：93 通过、17 跳过、0 失败，包含 Linux 真实进程测试。

Station 恢复和启动的当前全量/失败名逐项比较见相邻仓库 docs/MEETING_RESTORE_LAUNCH_BASELINE_2026-10-13.json；使用和跨调用链冲突检查见 MEETING_RESTORE_AND_WINDOWS_LAUNCH.md。Windows 独立 Node fixture、生产会议存储/IPC 测试和组件静态渲染均不等于真实 Desktop/Station GUI 接续或 Codex 停止对话验收。此前实际独立启动工具操作曾被自动审批拒绝，本轮没有绕过。真实双击与 GUI、macOS/Linux/ARM64、公网/MySQL、Claude 登录/模型及麦克风仍待验收；原执行证据和包哈希作为有日期的历史记录保留。
