# Pocket Vibe：选择远端已有会话

> 2026-10-10 公网可选模式已在当前工作树实现，见 [公网使用与交付](PUBLIC_REMOTE_CONTROL.md)。设置中的远端身份/添加电脑接入独立 `public_hub.py` 和产品 Bridge，不需要普通用户部署 Hub/Python。下面原有操作与历史实测是 **LAN 兼容模式**；其中 Token/模型栏和“只停止等待”不能用于描述公网模式。公网停止必须等 Bridge 监管的 cleanup_confirmed，断网或关闭 Station 不自动取消；未确认任务保留引用并阻断重跑。保存引用另带可选 service_url/owner_id，换身份或服务不能静默切换成员目标。

在当前两个本地仓库上补充目录与成员目标参数；不需要重新克隆。Hub 与电脑端 Bridge 均需要运行更新后的源码，并沿用现有配对、Token 和控制台。

## 使用

1. 启动现有 Hub。电脑端打开已有控制台，应用配对码或填写 Hub 地址、Desktop Bridge Token，导入并启动 Codex / Claude Bridge。已在运行的旧 Bridge 需要重启。
2. Station 设置 → Pocket Vibe (远程)：保存 Hub Base URL 与 API Key（Hub 的 **Tool Token**，不是 Desktop Bridge Token）。
3. 打开当前会议的参与者入口，在 Pocket Vibe 一行点 **选择远端会话**。
4. 按电脑、Agent 筛选，选择已有会话，点 **加入当前会议**。窗口可刷新目录，分别显示未连接、扫描失败、无会话与旧 Bridge 不支持目录的状态。无法识别项目目录的会话不可加入。
5. 聊天输入 `@` 后选具体会话成员，连续发送指令；语音可说出该成员的唯一会话标题来点名。重名会话请用聊天的具体成员选择。回复显示在该成员与当前会议的聊天时间线，切换标签不会改回复归属。

语音标题按大小写及空格、连字符、下划线规范化比较。唯一命中时直接添加实际 `@hostId` 并保留语音全文，例如“远端项目 帮我修改README”可以点名标题为“远端 项目”的成员。标题重名、规范化后同名、与本机名称同时命中或文本命中多个远端成员时，提示通过文本选择具体成员并停止发送。显式 `@` 保留；目标连接中、失败或离线仍走远端错误处理，不改投本机主持人。

会议继续使用原有容量上限：**共 3 个成员**，包含默认主持人。同一 `device_id / provider / 原生 session_id` 不重复加入，即使通过不同 Agent ID 的 Bridge 提供；不同会话可以分别加入。Agent ID 是执行入口，不是原生会话身份。无需改全局 Model/Agent 设置来切换成员目标。

文件由电脑端执行器在所选会话的电脑端 `cwd` 中读取、修改、测试；实际写权限沿用电脑端 Bridge 配置。此功能没有远端编辑器、文件同步或自动安装。选中的原生会话直接执行指令，不自动创建 Station 本机 Worker。

**停止等待只停止本地轮询；远端进程可能仍在运行。**

明确 `@` 远端成员时，连接中、启动失败、离线或会话引用失效会返回该目标的错误，不会交给本机主持人。加入及每轮发送都会刷新并校验 Agent、设备、provider、原生 ID 和 cwd；电脑端目录标记不存在/无法访问的项目，选择器不可加入。Hub 在路由和交付时再次检查，Bridge 在执行及取得锁后也检查。明确绑定的任务不会静默进入离线等待队列；交付时断连会报告失败/交付不确定，不自动重试。原有无目标调用保留其等待队列行为。

远端会话本轮仅支持文本。远端点名附带图片或附件时，renderer 和 Electron 均要求移除附件后发送，校验发生在本机 materials / `.vibe-attachments` 写入之前。普通本机附件流程不变。

## 身份、互斥与进程清理

Bridge 在同一电脑、同一 OS 用户的 `~/.pocket-vibe/device-id` 保存一个 UUID；同用户的多个仓库/Bridge 共用它。`POCKET_VIBE_STATE_DIR` 可指定共享状态目录，相关 Bridge 必须指向同一目录；不要各自生成设备 ID。旧设置和快照中没有 device_id 的引用，在目录可用时按原 Agent/provider/session/cwd 补齐；恢复时可确认的重复引用合并。离线引用保留并报错，不凭电脑名称猜设备，也不自动改换执行入口。

电脑端按同一身份使用 OS 文件锁（Windows 字节锁；macOS/Linux flock），跨 Bridge **进程**串行执行；保留原有 Bridge 内队列。已知原生 ID 的旧固定会话配置也使用此锁。未指定 ID 的旧 `--last` 调用仍按原行为执行，不宣称其具有可靠的原生会话互斥；选择器始终发送显式 ID。不同 OS 用户/不同共享状态目录、其他 Codex/Claude 原生客户端不在该锁范围内。

弹窗区分 Bridge 任务空闲、执行中、等待执行、退出未确认和未知；其他原生客户端占用始终显示“未知”。历史文件修改时间仅用于既有扫描排序，不用于推断占用。**执行期间不要在其他原生客户端同时操作同一会话。**本轮没有全面电脑进程监控。

同一 Agent 的并发刷新共享一次扫描；刷新中保留已完成的有效目录。接口的 `catalog_status` / `revision` 表示有效目录，`refresh_status` 表示当前刷新。每个刷新请求使用其完成结果的独立快照；取消或超时一个等待请求不取消共享扫描。其他请求正在刷新不会使有效目标被拒绝，但真实断连、新完成目录中会话失效、设备/provider/cwd 不匹配仍拒绝。扫描失败保留旧目录用于显示，明确选中目标的新请求会报告刷新失败。

执行状态按 Hub 接收顺序比较，不依赖电脑时钟同步：当前连接上的任务和最新共享锁扫描优先，退出未确认优先于执行中，执行中优先于等待。历史完成记录仅在没有可靠实时状态时补充，不能将新的执行中/等待覆盖成空闲；更新的已确认空闲扫描可清除旧的退出未确认记录。

每个任务由短暂的电脑端监管子进程持锁并执行配置的适配器。只清理该任务拥有的进程，不按程序名称结束用户其他 CLI。退出确认覆盖整条任务后代链，不能用“原 POSIX session 已空”代替；超时、启动/执行异常以及正常返回后的遗留子进程都要完成清理，才能写 `idle / cleanup_confirmed=true` 并放行同会话下一任务。

- **Windows 10 / Server 2016 及以上**：使用 `STARTUPINFOEX / PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建挂起适配器时原子加入专属 kill-on-close Job，再验证成员关系并启动。启动意图和监管进程 PID/创建时间在创建子进程前保存；根进程 PID/创建时间随后保存。创建后、写 PID 前崩溃也不会出现未绑定的挂起子进程。恢复综合原子归属记录、监管/根进程身份与 Job 活跃进程计数；不会仅凭旧 Job 不存在判断退出。旧版本分阶段创建留下的运行记录没有完整证明时继续拒绝任务。
- **Linux**：需要可用 `/proc`、subreaper 和 Python/kernel pidfd 支持（本轮在 WSL Ubuntu 实测）。监管进程在启动适配器前成为 subreaper；内核后代关系覆盖 `setsid`、新进程组、双重 fork、父进程先退出。遍历全部线程的后代，保存 PID/启动 ticks/boot ID，并使用 pidfd 校验身份后结束进程。回收全部子孙后才确认退出，不按 SID 判断。
- **Linux 监管进程被强杀**：只能清理已记录且身份仍匹配的进程及其可追踪后代；最后一次记录后的 fork 可能遗漏。因此没有已保存的完整退出证明时返回 `cleanup_confirmed=false`，保留记录并阻止新任务。原子锁释放不代表恢复成功；新的内核 boot ID 可证明前次进程链已消失。不要手工删除不确定记录来绕过保护。
- **macOS**：已实现专用监管路径，详见下方“语音与 macOS 修复”。每任务临时 launchd 作业启动现有监管进程，实际核验独立 resource coalition；子进程清理按该内核归属，退出证据使用内核任务计数。原命令、配置、启动入口、无目标/固定 ID/选中 ID 调用保留。需要实际能力探测通过；真实 macOS 验收尚未运行，Windows/WSL 或模拟 darwin 结果不能替代。
- **其他 POSIX**：未实现可靠监管机制，启动前明确拒绝，旧不确定记录不自动放行。

无法确认退出时，保留恢复信息并显示“进程退出未确认”；后续任务获取 OS 锁后先恢复，失败则拒绝启动，不宣称空闲。Bridge 断连/退出时，监管子进程继续持锁直到执行完成或超时。这是执行故障清理，**没有新增用户取消远端进程功能**；Station 轮询超时和“停止等待”也不会触发电脑端取消。

Windows 原子 Job 归属的支持范围见 [Microsoft API 文档](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)，恢复依赖的 Job 生命周期见 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。

## Codex 恢复权限

本机检查的 CLI 为 `codex-cli 0.160.0`。其 `exec resume` 不接受 `--sandbox` 子命令参数；产品适配器使用：

```text
codex exec --sandbox <Bridge 配置> -c approval_policy="<Bridge 配置>" resume --json <原生 session_id> ... -
```

适配器在电脑端选中的 cwd 启动 CLI，显式 ID 优先于 `--last`，连续发送恢复同一 ID。沙箱与审批策略只来自电脑端 Bridge 配置，不从 Hub turn_options 提升权限；默认仍是 `read-only` / `never`。需要写文件时由电脑端操作员明确配置 `workspace-write`，本轮不会自动提升权限。

## 现有启动方式

Windows 本地 Hub（另一个终端；环境变量和 Token 沿用现有配置）：

```powershell
Set-Location C:\aha\ahastation\pocket-vibe-agent
# 首次准备环境：py -3.13 -m venv .venv
# .\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe device\device_hub.py
```

电脑端控制台：

```powershell
Set-Location C:\aha\ahastation\pocket-vibe-agent
.\scripts\start-agent-gateway-site.ps1
```

打开 `http://127.0.0.1:8790`，使用现有配对与“导入 / 启动 Bridge”操作。局域网 Hub 使用其实际地址；Linux/RK3588 继续使用 `./start-linux-control-app.sh` 或 `./scripts/start-rk3588-pairing.sh` 的既有流程。

Station 源码开发版（两个终端，先退出旧安装版以释放单实例锁）：

```powershell
Set-Location C:\aha\ahastation\station-ctrl
npm run dev
# 第二个终端，同目录：
npm run dev:electron
```

`dev:electron` 会重新构建 Electron 与 preload。Node/npm/Python 需使用本机实际路径；不要套用交接说明中的 macOS/Linux 路径。

## 接口与引用

- `GET /v1/remote-sessions?refresh=true` 使用现有 Tool Token，经 Bridge 请求刷新原生目录。
- `/v1/sessions` 保持返回注册 Bridge/Agent 的原有行为。
- Bridge 复用电脑端 `discover_sessions`，只发送 provider、原生 session ID、标题与 cwd；Hub 补充 agent ID 与电脑名称。
- `sessions.addHost(sessionId, 'pocket-vibe', hostId?, remoteTarget?)` 的新参数可选。未提供时原有行为保持不变。
- 每个 Host 独立绑定 `{agent_id, device_id?, provider, session_id, cwd, title, computer_name?}`，覆盖全局目标与冲突的 `turn_options`，始终恢复同一原生会话。Hub `turn_id` 只用于轮询。
- 显式选择的 POST 添加向后兼容的 `require_online: true` 与 `remote_target` 引用；未绑定目标的 POST 不添加这些字段，保留原行为。新版选择器要求 Hub/Bridge 同步更新；旧 Bridge 缺少设备 ID 时提示更新。
- 引用通过现有 `openTabs[].remoteHosts` 设置与 Meeting `hosts[].remoteTarget` 快照保存；恢复不复制电脑端历史，也不自动执行新任务。

## 离线验证

```powershell
Set-Location C:\aha\ahastation\pocket-vibe-agent
.\.venv\Scripts\python.exe -m unittest discover -s tests -v

Set-Location C:\aha\ahastation\station-ctrl
$env:POCKET_VIBE_TEST_PYTHON = 'C:\aha\ahastation\pocket-vibe-agent\.venv\Scripts\python.exe'
npm run typecheck
npm test
```

跨仓库集成测试仅在 `POCKET_VIBE_TEST_PYTHON` 已设置时运行。它启动临时回环 Hub 与真实 WebSocket Bridge，扫描临时会话文件，使用模拟执行器；不会调用付费模型或修改用户项目。未设置时跳过此项，其他远端功能测试仍运行。

新测试覆盖目录、刷新/失败、目标优先级、连续两轮、两个成员隔离、切换标签、设置与会议快照恢复、原有无目标调用及禁止远端回复派发本机 Worker。

## 修改文件

| 文件 | 作用 |
| --- | --- |
| `electron/backends/pocket-vibe-target.ts` | 最小目标引用、去重身份、显示名称与引用校验 |
| `electron/backends/cli-backend.ts` | 可选 per-member remoteTarget 类型 |
| `electron/backends/pocket-vibe-adapter.ts` | 目录查询、目标优先级、原生会话连续恢复、远端 cwd、Claude 结果文本；选中会话不派发本机 Worker |
| `electron/orchestrator.ts` | 按 hostId 绑定、去重与容量限制、快照及恢复；远端启动进度不触发另一成员模型回合 |
| `electron/orchestrator-types.ts` | 远端启动事件携带可选引用，避免异步失败影响本机会话 |
| `electron/ipc/sessions.ts`、`electron/preload.cjs` | 加入参数、目录 IPC、设置/快照恢复入口 |
| `electron/ipc/session.ts`、`electron/ipc/attachments.ts` | 失败点名反馈；图片/附件在解析和本机落盘前拒绝 |
| `electron/store.ts` | 现有 openTabs 可选远端引用落盘 |
| `src/types.ts`、`src/hooks/useWorkers.ts` | renderer/API 的可选类型和参数 |
| `src/lib/meeting-store.ts` | 成员引用与名称、还原、标签路由、独立远端失败状态 |
| `src/components/RemoteSessionPicker.tsx`、`src/styles.css` | 小型选择弹窗、筛选、刷新与真实状态 |
| `src/components/SideDrawer.tsx` | 现有入口按钮、具体成员 @ 选择、远端反馈时间线 |
| `src/App.tsx` | 唯一会话标题语音点名，远端点名不套用本机派活指令 |
| `src/components/AgentDetailPanel.tsx`、`src/components/ParticipantPanel.tsx` | 显示具体远端引用；选中会话不展示本机编辑器/目录入口 |
| `tests/pocket-vibe-remote-sessions.test.mjs`、`tests/renderer-remote-sessions.test.mjs` | 功能、兼容及跨仓库回环测试 |
| `docs/POCKET_VIBE_BACKEND.md`、本文件 | 当前功能说明与历史交接文档入口 |

电脑端文件详情见相邻仓库 `docs/STATION_REMOTE_SESSIONS.md`。

## 本机验证记录（2026-10-05）

- Windows，Node v24.19.0、npm 10.9.4、Python 3.13；使用实际可执行路径，没有照搬历史路径。
- Station renderer/electron typecheck、Electron 构建及 renderer 生产构建通过（Vite 有既有大 chunk 提示）。
- Station 本功能及既有 Pocket Vibe 的 27 个测试全部通过；Agent 的 7 个离线测试全部通过，Python 编译与两仓库 `git diff --check` 通过。
- 全量测试用 `--test-force-exit --test-concurrency=4` 完成收集：899 项，854 通过、40 失败、5 跳过。普通 `npm test` 在协作流程测试报错后存在未退出句柄，首次运行被停止。失败涉及观察进程解析、Windows 符号链接权限、后端选择和权限断言等；尚未用修改前基线确认全部原因，本次不修复无关内容。
- 未验证真实 Codex/Claude 模型调用、真实项目编辑、跨电脑 LAN 和人工 GUI/麦克风操作；这些不属于默认无付费/无副作用测试。
- `electron/main.ts` 未修改；没有提交、推送或发布。

## 上一轮修复验证（2026-10-08，历史记录，未覆盖本次四项审查缺陷）

- Windows：Node v24.19.0（实际位于 `<local-evidence-path>`）、Python 3.13.5（相邻仓库 `.venv\Scripts\python.exe`）。原始 PATH 无 npm，本轮沿用已有临时 npm 10.9.4 wrapper 加入测试 PATH；它不是产品依赖或永久启动路径。日常启动使用本机有效的 Node/npm PATH。
- renderer / Electron 两端 `npm run typecheck` 和 `npm run build:electron` 通过。
- Station 相关 31 项全部通过（包含真实 WebSocket 回环 Hub/Bridge + 模拟执行器）；Pocket Vibe 15 项全部通过，包括 Windows 实际进程树超时、跨进程锁、Bridge 退出、监管进程崩溃恢复、清理未确认保护及引用参数校验。默认测试没有模型调用或用户项目写入。
- 同环境全量：修复前 899 项 / 854 通过 / 40 失败 / 5 跳过；修复后 **903 项 / 858 通过 / 40 失败 / 5 跳过**。40 个失败名称逐项一致，无新增失败。两次均用 `--test-force-exit --test-concurrency=4 --test-timeout=120000` 完成收集；既有失败包括 Observe 平台进程解析、Windows 符号链接权限和协作/权限断言，本轮未修改这些模块。
- 已登录的 Codex 0.160.0：仅在独立临时项目和测试会话中，用**当前产品 LocalAgentRunner / Codex 适配器**连续恢复同一原生 ID 两轮。配置为 `workspace-write` / `never`；两份文件分别为 `ROUND1`、`ROUND2`，第二轮读取第一轮文件成功；退出码与 cleanup_confirmed 成功，Station 结果文本提取分别为 `ROUND1_OK`、`ROUND2_OK`。没有使用替代适配器或提升权限。首次验收脚本读取临时文件遇到权限拒绝而中止，重新准备隔离目录后完成上述两轮。CLI 有 MCP/遥测网络警告，未改变登录或配置。
- 当时待验收：第二台电脑及实际 Hub 地址下的跨电脑 LAN；真实 Station GUI / 麦克风声音输入；真实 Claude；macOS/Linux 进程清理。更正环境记录：本机有 Station 捆绑的 Claude CLI，独立认证检查显示未登录，未代用户登录。回环测试不等于 LAN 验收，执行器实测不等于完整 GUI/语音链路验收。
- 本轮临时 Hub/Bridge 和测试进程已退出，未发现残留。自动审批检查拒绝删除临时项目及固定测试文件（返回 blocked by policy，未给更详细原因），故保留 `<local-evidence-path>` 及同 Temp 目录的 smoke 脚本/结果日志。测试原生会话记录保留，没有修改用户历史数据库。`electron/main.ts` 未修改，未提交、推送或发布。

## 上轮四项审查修复与验收记录（2026-10-08，历史结果）

- 本轮修改前实测基线：Station **903 / 858 通过 / 40 失败 / 5 跳过**，Windows Python **15 项通过**。基于当前工作树继续修复，没有重置或覆盖既有功能。
- 修复后 renderer / Electron 两端 typecheck、Electron 构建、相关 Station **32 项全部通过**。全量 **904 / 859 通过 / 40 失败 / 5 跳过**，40 个失败名称逐项一致，无新增失败；沿用 `--test-force-exit --test-concurrency=4 --test-timeout=120000` 完成收集，不修改无关模块。
- Windows Python **35 项：30 通过、5 项 Linux 专用跳过**。包含真实 HTTP/WebSocket Bridge 与动态临时 JSONL scanner：并发刷新、两会话同时发送、刷新/发送交错、等待者取消/超时、文件读取失败、实际会话删除与实际断连；包含旧完成结果/其他入口实时锁/等待与执行并存/未确认及恢复/扫描先后交错。Windows 进程测试实测创建后写元数据前、写元数据后、Job 校验启动后崩溃，确认挂起进程退出且下一任务安全运行；旧无证明记录保持阻断，创建时间不匹配不误杀测试进程。额外故障注入验证原生创建成功、Popen 对象返回前异常时仍先清理子进程再发布空闲。
- WSL Ubuntu（Python 3.14.4，Linux 6.18.33.2）直接运行本仓库 `tests/test_task_process_ownership.py`：**10 项，7 通过、3 项 Windows 专用跳过**。真实 setsid 子进程超时后未继续写文件；下一任务开始时旧进程已退出；双重 fork/父进程先退出也被回收。监管崩溃及子进程元数据前崩溃保持未确认并阻止下一任务；核对 PID 身份避免误杀；Popen 返回前异常仍清理已创建进程。测试 harness 作为 subreaper 回收故障注入孤儿并核对测试进程退出。
- Python compileall 与两仓库 diff 检查通过。本轮只用临时目录、模拟执行器和测试自建进程；没有调用付费模型或重新进行 Codex 两轮实测。上一节是真实执行器的**历史验证**，不是当前进程清理实现的模型验收。
- 本机有捆绑 Claude：`node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`，版本 **2.1.150**，独立 `auth status` 返回 `loggedIn=false / authMethod=none`。未登录、未调用模型。
- 当轮尚未验收：真实第二台电脑/实际 Hub 的 LAN、Station GUI、真实麦克风声音输入、Claude 登录后的执行；原生 Linux 非 WSL 发行版和 Windows Server。当轮 macOS 尚未实现，现已加入下述专用路径，仍待真实原生验收。
- 本轮启动的临时 Hub/Bridge 和测试进程均已关闭；临时目录由测试清理。前一节保留的历史 smoke 文件未动。`electron/main.ts` 未修改，没有提交、推送或发布。

本轮 Station 只新增 `tests/pocket-vibe-remote-sessions.test.mjs` 的并发跨仓库回归，并更新本文件及 `POCKET_VIBE_BACKEND.md`。电脑端修改集中在 `device_hub.py`、`task_process.py`、新增 `task_ownership.py`、`session_runtime.py`；调整已有恢复测试、回环 fixture，新增并发目录和真实进程测试。会议、其他 backend、轮询队列、持久化入口和目标引用字段保持原有行为；只有缺少完整退出证明的任务恢复更严格。

## 语音与 macOS 修复（2026-10-08）

Station 的 `src/lib/voice-final.ts` 是 App 使用的生产语音处理函数。远端标题唯一命中直接使用成员 ID，保留全文；不再通过原始标题 indexOf 二次定位。原有本机 skill/backend 名称处理保留。回归执行该函数并进入真实 Orchestrator，核对具体远端发送及默认主持人没有收到输入，包含匹配差异、重名、多候选、连接中/失败、显式 @ 和普通语音。

macOS 的 `device/macos_task.py` 沿用现有任务监管框架、JSON 输入/文本反馈及 SessionLock。每个任务通过当前用户 `launchctl bootstrap user/<uid>` 临时启动同一个 `task_process.py` 监管进程，无常驻新服务、无安装或提权；环境、配置命令、cwd、原生 ID 和恢复选项沿原流程传递。作业使用随机唯一名称，正常完成后 bootout 并清理临时文件；代理或 Bridge 消失时不会结束正在执行的监管进程。

启动实际适配器前核验资源组不同于调用者、内核计数仅有监管进程；先保存启动保留记录，再保存核验后的 coalition ID、boot UUID、监管进程 unique ID/PID version，随后创建适配器。资源组由内核跟踪 fork/spawn/exec 后代，不依赖 SID、进程组或当前父 PID。清理只枚举该已核验组的成员，核对稳定身份后通过 `proc_signal_with_audittoken` 交给内核验证 PID version 并发送信号，避免 PID 重用误杀。

原生故障注入覆盖提交作业前、监管进程身份记录前、适配器创建后但根元数据前、根元数据保存后。启动结果未知时保留 reservation；后续同会话任务等待活着的前序监管进程，缺少退出证明时保持阻断。

只有内核 `tasks_started - tasks_exited == 1`（仅监管进程）才发布 idle 并释放同会话下一任务；正常退出、超时和异常均如此。扫描空、根进程退出、PID 不存在都不是证据。监管崩溃后，仅凭保存的独占组身份清理，并要求内核计数为零；无法查询、组已消失、缺少启动/归属记录或计数仍非零时继续退出未确认并阻止新任务。新 boot UUID 能证明旧任务链结束。旧不确定记录不自动解除，不能删除记录绕过保护。范围为任务直接 fork/spawn/exec 的进程，不扩展到用户其他原生客户端或独立外部服务。

Bridge 启动时用真实临时作业探测 libproc 身份/信号 API、coalition 计数与用户 launchd 隔离。已知缺少能力时撤下执行能力，保留目录说明，标记会话 `available=false` 和准确 error；加入/发送校验会拒绝。system.info/browser 演示及未配置执行器时的 echo 行为保留。恢复授权/环境后重启 Bridge 重新探测。

能力边界核对了 Apple 官方源码：[fork/spawn 的 coalition 继承](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_fork.c)、[任务计数](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/coalition.c)、[身份验证信号](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c)。XNU 不支持 kqueue NOTE_TRACK，因此没有将它当作完整后代追踪方案。launchd 是否提供实际独占组由运行时检查，不能只凭作业名称推断。

本次实测基线 904 / 859 通过 / 40 失败 / 5 跳过；修复后 **905 / 860 通过 / 40 失败 / 5 跳过**，40 个失败名称逐项一致。renderer/Electron typecheck、两侧构建、相关 Station **33 项**通过；Windows Python **51 项，37 通过、14 跳过**（5 个 Linux、9 个 macOS 专用），其中 7 项 macOS 分支/策略模拟通过；WSL 现有原生进程回归 **10 项，7 通过、3 个 Windows 专用跳过**。compileall 与 diff 检查通过。没有付费调用；临时服务/进程只属于测试。

**待真实 macOS 验收**：`tests/test_macos_native.py` 的 9 项原生测试，包括原有无目标/固定 ID、选中会话连续两轮和文本反馈、不同 Agent ID 的 Bridge 串行、正常返回遗留进程、超时/setsid/双重 fork/父进程退出、监管崩溃/创建与元数据故障、PID version 不匹配、未确认后阻止下一任务。在真实 macOS 上此套件要求实际能力探测成功，不能以缺少能力为由跳过；当前 Windows/WSL 跳过不算 macOS 通过。

```bash
cd /实际路径/pocket-vibe-agent
.venv/bin/python -m unittest discover -s tests -p 'test_macos_native.py' -v
.venv/bin/python -m unittest discover -s tests -p 'test_macos_supervision_policy.py' -v
```

可在已有 macOS CI runner 上运行相同命令；本轮没有触发 CI、提交、推送或发布。完整 LAN、GUI 和真实麦克风输入仍需单独验收，语音处理函数测试不等于真实声音验收。具体启动继续使用电脑端已有 `scripts/start-control-panel.sh` / provider Bridge 脚本，Station 入口不变。没有修改 `electron/main.ts`、其他 backend 或通用配置/持久化体系。


## 2026-10-12 桌面联动共享执行增量

Bridge 桌面模式使用同一常驻原生服务和桌面 socket；Station 仍用现有配对、目标引用、参与者、@、轮询和语音文本流程。选择器显示“Codex 桌面联动”来源与桌面执行/等待/Station 执行/停止未确认。首次由用户自行退出旧桌面，在 Bridge 点击“启动联动桌面”；之后不需日常归档、恢复、手动释放。没有共享连接或原生配置/退出证明不足时明确拒绝，不能回退独立 exec、本机或另一个会话。停止请求精确绑定原生 turn；断网和关窗不自动取消。

完整 GUI 双向接续仍待验收。当前已部署 Hub 未改动；本轮不部署、改 DNS 或数据库。实现、平台边界和实际测试分类见相邻 Pocket 仓库 docs/BRIDGE_PRODUCT.md 与 docs/SHARED_DESKTOP_ACCEPTANCE.md；旧独立恢复测试不替代本版共享服务验收。
