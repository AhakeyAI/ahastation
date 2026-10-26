# Station 原生远端会话目录

> 2026-10-10：新增可选公网 `device/public_hub.py`（MySQL、owner/device 鉴权）和 `device/bridge_app.py`（独立后台设置/托盘/交付包）。见 [PUBLIC_REMOTE_CONTROL.md](PUBLIC_REMOTE_CONTROL.md)、[BRIDGE_PRODUCT.md](BRIDGE_PRODUCT.md)、[WEIXIN_CLOUD_DEPLOY.md](WEIXIN_CLOUD_DEPLOY.md)、[ACCEPTANCE_PUBLIC.md](ACCEPTANCE_PUBLIC.md)。下文原有 Tool Token/控制台/只停止等待语义适用于明确 LAN 兼容模式；公网停止经持久取消、任务 marker、平台整链退出证明，未确认不放行。当前源码未部署或发布。历史路径与真实模型验证不能替代本轮 Windows/WSL/冻结包/云端分项验收。

Hub 和电脑端 Bridge 更新后，Station 可选择电脑端已有 Codex / Claude 会话。启动、配对、导入 Bridge 与停止操作继续使用现有控制台；已运行的旧 Hub/Bridge 需要重启。无需为每个历史会话创建新 Bridge。

Windows：在本仓库用 `.venv\Scripts\python.exe device\device_hub.py` 启动 Hub，用 `scripts\start-agent-gateway-site.ps1` 打开电脑端控制台。先应用现有配对码，或填写实际 Hub 地址与 Desktop Bridge Token，再导入对应 provider 的 Bridge。Station 使用另一个 **Tool Token** 查询目录和发送指令。

新增 `GET /v1/remote-sessions`（现有 Tool Token 鉴权）：

```json
{
  "ok": true,
  "status": "connected",
  "agents": [{"agent_id": "codex-worker", "device_id": "persistent-device-uuid", "computer_name": "Desktop", "display_name": "Codex Worker", "provider": "codex", "status": "ready", "error": "", "scanned_at": "..."}],
  "sessions": [{"agent_id": "codex-worker", "device_id": "persistent-device-uuid", "provider": "codex", "session_id": "native-session-id", "title": "Existing session", "cwd": "C:\\project", "computer_name": "Desktop", "execution_status": "unknown", "native_client_status": "unknown"}],
  "count": 1
}
```

`?refresh=true` 在已有 WebSocket 连接发送 `refresh_sessions`，Bridge 复用 `desktop_control_panel.discover_sessions`，回复 `session_catalog`。首次连接也发布目录。刷新在 10 秒未回复时显示失败；断连电脑的会话不继续提供给 Station。状态包括 scanning、ready、empty、failed、unsupported；无已连接 Bridge 时顶层为 disconnected。旧 Bridge 不必处理新消息，现有 `/v1/sessions`、任务消息和串行执行队列保持兼容。

同一 Agent 的并发刷新合并为一个共享任务，取消/超时某个调用不会取消其他调用的扫描。刷新只改变 `refresh_status`，保留上一次有效目录的 `catalog_status`、`revision` 和会话；每个请求组装自己等待得到的完成快照，避免随后刷新使响应变成 scanning/空目录。扫描失败保留旧行用于显示，`status=failed`、`refresh_status=failed` 与 error 说明失败，显式目标的新请求仍拒绝。加入、发送与交付使用相同的有效目录校验，不因另一个请求正在刷新而拒绝；真实断连、已完成刷新删除会话、设备/provider/cwd 不匹配仍拒绝。

目录只传最小引用和状态，不含文件内容、完整历史、预览或凭证。电脑端以 available / error 标记项目目录不存在或无法访问，Station 禁止选择这类目标；实际启动前还会检查 cwd。Codex 的 strict 扫描保留目录中的空格；Claude 从原生 JSONL 的顶层 cwd 与 user message 获取目录和标题。严格扫描失败只影响 Bridge 目录反馈，电脑端控制台原有的尽力扫描行为保留。

任务仍使用 `/v1/turns`，选中的 `target_agent_id`、provider、原生 session_id、cwd 与 `turn_options.mode=resume` 经 Hub 原样传给现有执行器。真实编辑权限仍由电脑端配置控制。中断 Station 等待不会取消电脑端进程。

## 本轮修复的执行约束

原生身份为 **device_id / provider / 原生 session_id**，Agent ID 只表示执行入口。稳定设备 ID 保存在同电脑、同 OS 用户的 `~/.pocket-vibe/device-id`；同用户多个 Bridge/仓库共用。可用 `POCKET_VIBE_STATE_DIR` 指定一个共同目录，相关 Bridge 必须一致；不同 OS 用户/状态目录不属于同一互斥范围。不要按电脑名称或历史文件 mtime 推断设备身份/空闲状态。

电脑端通过共享文件锁（Windows 字节锁、POSIX flock）跨 Bridge **进程**串行执行同一会话，同时保留既有单 Bridge 队列。已知 ID 的旧固定会话配置（任务参数、命令行或 provider 的 SESSION_ID 环境配置）也受保护；旧的无 ID / `--last` 行为保留，但不宣称有可靠的原生会话身份锁。Station 显式选择始终传同一个原生 ID，旧引用通过在线目录补齐设备身份，恢复不使用 Hub turn_id。

目录的 execution_status 表示 Bridge 管理的任务：idle、running、waiting、cleanup-unconfirmed 或 unknown。原生客户端是否正在占用无法可靠判断，native_client_status 始终 unknown，Station 显示“未知”。**执行期间不要在其他 Codex/Claude 原生客户端同时操作同一会话。**本轮没有全电脑客户端监控。

状态合并优先读取当前连接有效任务和同设备/原生身份最新可靠共享锁扫描：退出未确认 > 执行中 > 等待；正在执行不会被另一等待任务掩盖，旧 Bridge 的 unknown 也不覆盖其他 Bridge 的可靠锁状态。历史结果只在缺少可靠实时信息时补充，旧 Station 完成记录不能覆盖旧接口/另一 Hub/Bridge 的实时执行锁。Hub 本地递增的接收版本比较任务状态、结果和扫描先后，不依赖远端时钟同步；后续已确认空闲扫描可清除旧退出未确认，更新的失败回执不会被更早的空闲扫描隐藏。

明确选择的请求增加可选 `require_online: true` 与 `remote_target: {agent_id, device_id, provider, session_id, cwd}`。Hub 检查在线、provider、设备、原生 ID 和目录，刷新目录后再检查，并在异步路由与交付时复查。Bridge 在执行前及取得共享锁后使用现有 scanner 再校验；引用与任务/turn_options 参数不匹配则拒绝。离线/失效的显式目标不会进入 waiting_for_agent，断连交付失败不会重连后自动执行。没有该可选参数的旧调用继续使用原等待队列。Station 明确远端点名失败也不会改投本机。

远端本轮只支持文本。Station 的 renderer 与 Electron 会在本机附件落盘前拒绝远端点名的图片/附件，要求移除后发送；普通本机附件不变，没有新增文件同步。

### Codex 权限与恢复

本机实际检查 `codex-cli 0.160.0`：`resume` 不支持自身的 --sandbox 选项。产品适配器把权限参数放在 **exec 选项位置**，审批策略以 TOML 配置覆盖传入：

```text
codex exec --sandbox workspace-write -c approval_policy="never" resume --json <原生 session_id> ... -
```

上例必须对应操作员实际 Bridge 配置；默认仍是 read-only / never，不自动提升权限，不接受 Hub turn_options 覆盖沙箱/审批。CLI 在选中的电脑端 cwd 启动；显式 session_id 优先于 --last，连续两轮恢复同一原生 ID。

### 超时、异常与停止等待

`device/task_process.py` 是每任务启动、完成后退出的监管子进程，不是新服务。它持有共享会话锁，执行配置的适配器，并监管实际 CLI 及其后代。超时、异常及正常返回后的遗留进程均需整条任务后代链退出确认，才能写 `idle / cleanup_confirmed=true` 并放行同会话下一任务；仅原 session 已空不构成证明。只操作归属本任务的进程，不按名称结束用户其他 CLI。

| 平台 | 清理机制与恢复边界 |
| --- | --- |
| Windows 10 / Server 2016+ | `STARTUPINFOEX / PROC_THREAD_ATTRIBUTE_JOB_LIST` 创建时原子加入专属 kill-on-close Job，然后验证成员关系并恢复挂起线程。创建前持久化 Job 名称和监管 PID/创建时间，随后保存根 PID/创建时间；写根元数据前崩溃也没有未绑定子进程。正常清理等待 Job 活跃进程归零。恢复核对原子归属记录、监管/根进程身份及 Job 状态；Job 不存在本身不是退出证明。旧分阶段记录缺少证明时继续阻断。 |
| Linux | 启动前验证 `/proc`、subreaper 和 Python/kernel pidfd 能力，不需要管理员权限。监管进程成为 subreaper，按所有线程的内核后代关系追踪；覆盖 setsid、新进程组、双重 fork 和父进程先退出。保存 PID/启动 ticks/boot ID，核对父子关系防止枚举期间 PID 重用，用 pidfd 校验并结束实际进程，回收全部后代后才确认退出。 |
| Linux 监管进程强杀后的恢复 | 清理已记录且仍同一身份的进程及其可追踪后代；无法证明最后一次记录后的未知 fork 已退出。未保存完整退出证明时 `cleanup_confirmed=false` 并保留阻断记录，原 session 已空也不能放行。新的 kernel boot ID 可证明前次进程链结束。 |
| macOS | 专用 `macos_task.py`：每任务临时 launchd 作业运行现有监管进程，启动前实际核验独立 resource coalition；清理按内核组归属，充分退出证据为内核任务计数。保留原配置、启动入口、无目标/固定 ID/显式原生 ID 调用。需真实能力探测通过，当前实现待真实 macOS 验收。 |
| 其他 POSIX | 尚无可靠监管机制，启动前明确拒绝；旧不确定记录不自动放行。 |

Windows 机制与平台版本见 [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)，Job 生命周期/kill-on-close 见 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。

无法确认退出时显示 cleanup-unconfirmed 并保留恢复信息；下一任务取得 OS 锁后先恢复，失败则拒绝启动。监管崩溃时 OS 释放锁，但持久化记录仍阻止后续执行；不要删除不确定记录绕过保护。Bridge 断连/退出后，监管子进程继续持锁直到完成或执行超时。**Station 的“停止等待”及轮询超时只停止接收结果，电脑端任务可能继续执行。**本轮清理不是新增用户取消远端进程功能。

运行离线测试：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

`tests/remote_session_fixture.py` 是供相邻 Station 仓库集成测试使用的临时回环 Hub/Bridge，仅读取测试会话并模拟执行，不调用 CLI。Station 测试设置 `POCKET_VIBE_TEST_PYTHON` 为本仓库虚拟环境的 Python 后即可验证真实 WebSocket 链路。

修改文件：

| 文件 | 作用 |
| --- | --- |
| `device/desktop_agent.py` | 复用扫描，发布/刷新最小目录；执行异常沿原有队列反馈失败 |
| `device/session_runtime.py` | 共享持久化设备 ID、原生会话 OS 锁和任务清理状态 |
| `device/task_process.py`、`device/task_ownership.py` | 每任务持锁监管、Windows 原子 Job、Linux subreaper/pidfd 整链清理和保守崩溃恢复 |
| `device/device_hub.py` | 共享刷新、独立完成快照、保留有效目录；接收版本与实时锁状态优先；保留旧接口 |
| `device/desktop_control_panel.py` | 可选严格扫描错误；补充 Claude 原生目录/标题，保留 Codex 路径中的空格 |
| `examples/codex_cli_adapter.py` | 显式选中会话 ID 优先于 `--last`；exec / resume 正确应用配置的沙箱和审批 |
| `tests/test_remote_sessions.py` | 7 个离线功能/兼容测试 |
| `tests/test_remote_repairs.py` | 8 个修复回归：真实进程树与跨进程锁、父进程/监管进程崩溃、清理未确认、离线/失效/参数不匹配及旧调用 |
| `tests/remote_session_fixture.py` | Station 集成测试用真实回环 Hub/Bridge 与模拟执行器 |
| `tests/test_remote_catalog_concurrency.py` | 真实 HTTP/WebSocket/scanner 并发刷新、双成员发送、取消/超时、断连/失效及状态优先级 |
| `tests/test_task_process_ownership.py` | Windows 三阶段崩溃故障注入、创建时间核对；Linux setsid/双重 fork/父进程退出及锁放行、崩溃阻断、PID 身份保护 |
| `README.md`、本文件 | 功能入口、启动和验证说明 |

2026-10-05：7 个测试、Python compileall 和 git diff --check 通过；相邻 Station 的实际 WebSocket 回环测试通过。未调用真实模型或执行修改用户项目的任务；未提交或推送。

## 上一轮验证（2026-10-08，历史记录，未覆盖本次四项缺陷）

- Windows，实际使用 `.venv\Scripts\python.exe`（3.13.5）；15 个 Python 测试通过，compileall 与 diff 检查通过。进程测试只创建临时测试脚本/文件，不调用模型。
- 相邻 Station 的 renderer / Electron typecheck、Electron 构建通过；相关 31 个测试通过，包含真实 WebSocket **回环** Hub/Bridge 与模拟执行器。
- 同环境全量对照：修改前 899 / 854 通过 / 40 失败 / 5 跳过；修改后 903 / 858 通过 / 40 失败 / 5 跳过。40 个失败名称相同，无新增失败；未修改无关失败模块。
- 使用已登录 Codex 0.160.0 的**当前产品 LocalAgentRunner 与 Codex 适配器**，在独立临时项目/测试会话中连续恢复两轮：同一原生 ID、电脑端 cwd、配置 workspace-write / never，两份文件内容为 ROUND1 / ROUND2，第二轮读取第一轮文件成功，反馈 ROUND1_OK / ROUND2_OK，cleanup_confirmed 成功，Station 文本提取通过。首次验收脚本遇到临时文件读取权限拒绝，重新准备隔离目录后完成两轮；CLI 的 MCP/遥测网络警告没有导致执行失败。没有替换临时适配器、提升权限或修改用户真实项目。
- 当时待验收：macOS/Linux 实际进程清理；跨电脑 LAN（缺少第二台电脑/实际 Hub 地址）；真实 Station GUI 和声音输入；Claude 实际调用。更正环境记录：本机有 Station 捆绑的 Claude CLI，独立认证显示未登录，未自动登录。执行器验证不等于完整 LAN/GUI/语音验收。
- 本轮临时 Hub/Bridge 和测试进程已退出，未发现残留。自动审批检查拒绝删除临时项目/固定文件（blocked by policy，未给具体原因），故保留 `C:\Users\79142\AppData\Local\Temp\station-codex-smoke-dei1l08n` 及同 Temp 目录的 smoke 脚本/结果日志。测试原生会话记录保留，没有修改用户历史数据库。未提交、推送或发布。

## 上轮四项审查修复验证（2026-10-08，历史结果）

- 本轮基线实测：Windows Python **15 项通过**；Station **903 / 858 通过 / 40 失败 / 5 跳过**。
- 修复后 Windows Python **35 项，30 通过、5 个 Linux 专用跳过**。并发协议测试使用真实 uvicorn/HTTP/WebSocket Bridge 和实际临时会话扫描，仅替换模型执行器；会话删除、断连和文件读取失败改变真实扫描结果，没有用固定目录 mock 掩盖并发问题。覆盖共享刷新、完成快照、两目标发送、刷新交错、一个调用取消/超时、在线/失效检查与实时状态优先级。
- Windows 原生 Job 测试覆盖创建后但根元数据前、根元数据后、Job 校验启动后监管崩溃；检查挂起/运行适配器已退出、下项任务放行安全、旧无证明记录阻断和创建时间不匹配不误杀。相关真实进程均由测试创建并清理。
- WSL Ubuntu：Python 3.14.4、Linux 6.18.33.2；直接读取此工作树运行 `python3 tests/test_task_process_ownership.py -v`，**10 项，7 通过、3 个 Windows 专用跳过**。覆盖 setsid 逃离原 session、双重 fork、父进程先退出、超时后不继续写文件、确认退出后才启动下一任务、subreaper 崩溃/创建后元数据前崩溃阻断、PID 身份核对；harness 回收故障注入的孤儿并确认退出。Windows/Linux 均额外注入原生进程创建成功但 Popen 返回前异常，验证清理完已创建进程后才发布 idle。
- Station renderer / Electron typecheck、Electron 构建和相关 **32 项全部通过**。全量 **904 / 859 通过 / 40 失败 / 5 跳过**；40 个失败名称与本轮基线完全一致，无新增失败。未为追求全绿修改无关模块。Python compileall、两仓库 diff 检查通过。
- 本轮没有付费模型调用、用户项目写入或 GUI 自动化；上一节两轮 Codex 为旧版本真实执行器历史记录，本轮的进程/协议自动化不等于重新完成模型执行器、完整 LAN/GUI/语音验收。
- 更正 Claude 环境：Station 捆绑的 `node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` 存在，版本 **2.1.150**；独立 `auth status` 显示 **未登录**（`loggedIn=false`，`authMethod=none`）。没有自动登录或调用 Claude。
- 当轮仍待真实第二台电脑/实际 Hub 的 LAN、Station GUI、麦克风声音输入、Claude 登录后执行；非 WSL Linux 与 Windows Server 未实测。当轮 macOS 未实现，现已加入下述专用路径，仍待真实原生验收。
- 当轮临时服务、进程和目录已清理；历史保留 smoke 文件未动。未修改 Station `electron/main.ts`，未提交、推送或发布。旧无目标调用/配置/引用入口保留；缺少整链退出证明的恢复会拒绝。当轮 macOS 执行受限，本轮实现与验收范围见下节。

WSL 本机进程测试命令（直接使用当前仓库，不复制源码）：

```powershell
wsl -d Ubuntu --exec python3 /mnt/c/aha/ahastation/pocket-vibe-agent/tests/test_task_process_ownership.py -v
```

## 语音与 macOS 兼容修复（2026-10-08）

Station 生产语音处理现在直接使用唯一匹配的 hostId，保留语音全文；规范化忽略大小写、空格、连字符、下划线，不使用规范化下标截取原文。重名、规范化同名或多个命中提示文本选择并停止发送，已点名远端连接中/失败时不改投本机。测试调用 App 使用的生产函数，并进入真实 Orchestrator 验证远端及默认主持人输入。

macOS 不再交给 LinuxTaskTree，也不再默认禁用执行。`macos_task.py` 通过当前用户临时 launchd 作业启动现有 `task_process.py` 监管进程；不安装常驻服务，不要求 sudo，不改电脑端配置或配对。沿用配置命令、环境、cwd、JSON stdin、原生 ID、结果文本与 SessionLock。原有无目标调用、命令行固定 ID 和选中的会话恢复路径保留；同一设备/provider/原生 ID 仍跨 Bridge 进程串行。启动入口继续为已有 `scripts/start-control-panel.sh` 和 Codex/Claude Bridge 脚本。

启动顺序：先取得既有会话锁，保存临时作业启动保留记录，再启动监管进程；监管进程核验 resource coalition 不同于调用者且仅有自身，保存独占组 ID、boot UUID、PID/unique ID/PID version，然后启动适配器。创建与元数据之间崩溃也有启动/归属记录，未知结果保持阻断。临时文件权限只开放给当前用户；正常完成后 bootout 并清理，失败时保留恢复资料。Bridge/代理断连不会结束活着的监管进程。

原生故障注入分别覆盖提交作业前、监管进程已启动但身份记录前、适配器创建后但根元数据前，以及根元数据保存后。前两者没有完整启动结果时必须保留 reservation，不能因未找到 PID 而解除；后两者必须取得内核退出证明，否则下一任务不会启动。

fork/spawn/exec 默认继承 resource coalition；setsid、新进程组和 reparent 不改变该内核归属。枚举只用于寻找已核验组成员，核对 unique ID/boot UUID，并通过原生 audit-token 信号 API 由内核校验 PID version；不对裸 PID 或同程序名用户进程清理。退出充分证据是内核 `tasks_started - tasks_exited == 1`（只剩监管进程），此后才发布 idle/cleanup_confirmed 并放行下一任务。扫描空、根适配器退出、SID/PGID 空、记录 PID 不存在都不能代替该证据。

监管崩溃恢复要求可信独占组记录，清理该组并读取内核计数为零；计数查询失败、组消失、缺少记录或未知启动结果均返回未确认并阻止后续任务，不能删除记录绕过。boot UUID 已变化可证明旧内核上的任务链结束。只覆盖任务实际 fork/spawn/exec 的进程，不监控其他原生客户端或独立外部服务；“停止等待”语义不变。

Bridge 启动时实际探测所需 API、用户 launchd domain、独占组和精确身份信号能力。失败时撤下执行 capability，保留 provider 目录能力与原因，将会话 available=false/error；选择、加入、发送不会显示必然失败的目标为可用。system.info/browser 演示以及未配置执行器的 echo 保留。环境授权修复后重启 Bridge 重试。

机制依据 Apple 官方源码：[coalition 继承](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_fork.c)、[内核计数](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/coalition.c)、[PID version 信号校验](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c)、[API 包装](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/coalition.c)。[XNU kqueue](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_event.c) 明确不支持 NOTE_TRACK，因此没有使用它假定自动追踪全链。launchd 的实际独占组由运行时核验，不只凭作业名称推断。

新增文件 `device/macos_task.py`、`tests/test_macos_supervision_policy.py`、`tests/test_macos_native.py`；`task_process.py` 明确分开 Windows、Linux、macOS，保留前两者实现；`desktop_agent.py` 加能力探测/目录可用性，`session_runtime.py` 识别启动保留状态。没有新数据库或通用配置重构。

当前本机结果：Windows Python **51 项，37 通过、14 平台跳过**；其中 **7 项为 macOS 策略/分支模拟，不能称 macOS 原生通过**。Windows 实际 Job 故障注入/进程回归通过；WSL 现有原生进程监管 **10 项，7 通过、3 个 Windows 专用跳过**。Station renderer/Electron typecheck、两侧构建、相关 **33 项**通过，全量从 **904/859 通过/40 失败/5 跳过** 到 **905/860 通过/40 失败/5 跳过**，具体 40 个失败名称一致。compileall/diff 检查通过，无模型调用或用户项目写入。

**待真实 macOS 验收**：9 项原生测试涵盖原有无目标/固定 ID、原生会话两轮及反馈、两个不同 Agent ID Bridge 实际执行串行、正常返回遗留子进程、超时/setsid/双重 fork/父进程退出、监管崩溃/启动及创建元数据窗口、身份/PID version 不匹配不误杀、未确认时下一任务不启动。在 macOS 上必须实际能力探测成功，不能跳过不支持的环境冒充通过。当前 Windows/WSL 跳过这些测试；可在已有 macOS CI runner 执行：

```bash
cd /实际路径/pocket-vibe-agent
.venv/bin/python -m unittest discover -s tests -p 'test_macos_native.py' -v
.venv/bin/python -m unittest discover -s tests -p 'test_macos_supervision_policy.py' -v
```

本轮未触发 CI、提交、推送或发布。完整 LAN、真实 GUI/麦克风及 Claude 模型执行仍单独待验收；代码实现、模拟分支、Windows/WSL 原生进程验证与 macOS 待验收不能混称。


## 当前桌面共享执行增量

桌面模式已改为同一常驻服务的原生 thread/turn 通道，不再独立 exec resume 或要求日常声明释放。上一版归档/恢复与独立监管结果属于历史验收。首次联动启动、权限、按会话排队、准确停止和崩溃阻断见 BRIDGE_PRODUCT.md；本轮真实/模拟证据与待验收项见 [SHARED_DESKTOP_ACCEPTANCE.md](SHARED_DESKTOP_ACCEPTANCE.md)。已部署 Hub 的协议、数据库与云端没有改动。
