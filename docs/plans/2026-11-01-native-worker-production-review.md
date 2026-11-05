# Native Worker 最小生产链候选：独立复审与接缝

> 2026-11-02：本文记录旧 Host 工具裁决方案的候选复审。当前实施依据为[原生 CLI 接线规划](2026-11-02-native-cli-worker-integration.md)；不再以本文的“后续路径选择”派发定制守卫/网络隔离或逐工具许可工作。保留缺陷修复及证据，不将旧 broker/fixture 当作真实 CLI 任务完成。

日期：2026-11-01，Asia/Singapore。范围：P0、P1 与最小 P2；不是 #86/B04 完成声明。

## caa8f9e 独立复审后的两项修复

- **P1 管道背压阻塞停止：** 原 helper 在同一线程读取宿主命令并同步向 worker 写入；worker 停读会让该线程卡在 WriteLine，stop/EOF 无法进入 Job 回收。本轮将控制读取、输入转发、输出转发和整树回收分离。输入/输出均使用 32 帧、2 MiB 有界队列；写入阻塞只影响后台 writer，溢出或异常触发封口与回收。回收先于任何 fatal/退出诊断；宿主不读输出时仅有限等待诊断，不能阻塞收树。没有从 writer 队列为空推断停止，confirmed 仍只接受真实 Job ActiveProcesses=0。
- **P2 UTF-8 分块损坏：** 原 Node 接收每个 Buffer 单独 toString，会替换跨块汉字。本轮 `Utf8Frames` 使用严格流式 TextDecoder，跨块保留字节序列；非法/截断 UTF-8、未结束帧或超限均拒绝。helper 两侧也使用严格 UTF-8，避免在 .NET 中先发生替换。
- **实际回归：** `tests/native-worker-transport.test.mjs` 令自有隐藏 AppContainer 进程创建后代后永久停读，填入超过管道容量的数据；先连续核对 writer 仍处于 blocked，再分别 stop/宿主 EOF，要求 3 秒内返回匹配 OS identity 的 ActiveProcesses=0。UTF-8 覆盖中文/emoji 的每个分割点、逐字节、多帧、无效与截断数据；实际审批/permit/文件写入另核对中文原样。
- **反例：** 固定 `caa8f9e` 守卫，仅向旧 worker 增加 pauseInput 测试行为、保留旧控制转发代码；两种停止路径均在 3 秒后无 tree-exit。失败后只结束测试持有的确切 helper 进程句柄，由 Job 关闭回收自有树。未运行真实 PTY、模型、个人配置或真实远端写。
- **CI 排障：** 新传输用例曾在 AppContainer 创建后代前失败；不是管道回收断言失败。补充不含私密数据的错误类型/码后观察到 `Win32Exception / 267 (ERROR_DIRECTORY)`。测试改为规范化自有临时目录，后代显式指定执行目录，并隔离其标准流；自身映像路径用已加载程序集位置取得，不额外依赖进程模块枚举。helper 对非对象子进程帧仍 fail-closed。Windows CI 将传输故障专项前置，保留此前失败日志，完整矩阵结果按最终 head 单独记录。
  修正后的 `2141309` 已在 [CI 41288467526](https://github.com/AhakeyAI/ahastation/actions/runs/41288467526/job/124794607367) 通过前置专项。旧版阻塞反例与最初本机样本保留在 [764d229 的固定证据](https://github.com/AhakeyAI/ahastation/blob/764d229bee451f5f0f9b89ecd2d4dbde1b7e0890/docs/evidence/native-worker-production/local-validation.json)；当前验证器每次从当次测试输出提取 transportFaultEvidence，不将历史样本冒充当次执行。

## 后续路径选择

用户本轮已选择“保留原生登录与工具，补受控网络出口和现有 PTY 接线”，不改为 API key 专用或仅自定义 broker 工具。本轮两项缺陷修复不改变原生准入，也不把 fixture ID 升格为原生 sessionId。

这条后续链必须先解决实际执行边界：当前 AppContainer 不授予网络/用户凭据；`PtyHost` 的 node-pty 启动接口不能在恢复前注入 AppContainer/Job 身份。下一阶段需在同一现有 TerminalCliSession/PtyHost 的 spawn seam 实现受控 ConPTY 启动，并补按运行身份约束的网络出口与原生凭据访问。CLI 的 `HTTP_PROXY`/`--settings`/hook 本身只能配置流量，不能证明脚本无法直连；不会仅增加这些环境变量就开放 Worker。登录或 OS 出口所需的实机配置动作与模型消耗没有在本轮执行，保留 G13/真实引擎/B04 验收门。

## 固定基线与判断

实时查询源仓库 `AhakeyAI/ahastation`：main `8770207ca4e41f3f31201d418a980593adf51efd`；#142 `6ea1fc1a752967fa19d4ddf08a50b3f75d0fc706`、#146 `ae9d27246e105c97ea72275a0cbbee91a2980fc8`、#147 `42f1a51c0eb1ef481195ce0501e88b2d417da56c` 均仍为开放 Draft。#147 独立新增范围 `1ff0468392cfef710c13be52e9a086bd94f84b00..42f1a51`。本候选新分支继承 #147，不修改旧任务分支；独立 diff 从 `42f1a51` 起算，依赖尚未合入 main。

复审通过的结论是“可继续实现，不能开放 native 默认”。本轮由实施者重新沿源码审查上个候选；最终独立接受仍由主对话完成，没有让另一个代理背书。

## 已有链路与复用

| 实际入口 | 已有行为 | 本轮处理 |
|---|---|---|
| `electron/orchestrator.ts:resolveBackendSessionFactory` | Host 规划、后端配置与派单入口；SDK 与交互终端均可能使用本地 CLI | 保留路由与授权来源；不新建调度系统 |
| `electron/worker-scheduler.ts:spawnWorker` | 准备工作区、编译/持久化 authority，调用 BackendSession，发送首个任务 | 在相同 factory 传递受信任的 `nativeWorkerAuthority` 回调；不传 role/token 充当 owner |
| `electron/backends/terminal-cli-adapter.ts:TerminalCliSession` | 既有本地 CLI、PTY、Stop 进度、持久会话、人工确认/接管与输入 | 全部保留。Worker/taskProfile 在 spawn 前仍被 admission 拒绝；不是“原来只有手动终端” |
| `electron/pty-host.ts`、`electron/terminal-daemon/`、`electron/ipc/worker-pty.ts` | daemon、持久终端与人工键盘路径 | 保留；未将普通 PTY 写入口改造成守卫，也未宣称已接通 AppContainer ConPTY |
| `electron/worker-scheduler.ts:handleWorkerSignal` | WorkReport 进入既有候选/验收流水线 | 新 ports 调用同一个函数并等待 `flushEvents`；无 EOF/Stop 自动成功 |
| `electron/orchestrator.ts:persistPermissionDecision` | MeetingRepository 追加并 flush 裁决 | 新 ports 复用；失败不发行 permit |

## 具体发现

1. **已修 P1：异步回报过早确认。** #147 的 `electron/native-worker/run.ts:report` 将 `onReport()` 当同步调用；真实 journal/scheduler 返回 Promise 时，拒绝可能发生在回执已经发出之后。改为 await 异步交付；相同 report 并发复用同一 Promise/receipt，失败封口。新增延迟/失败回归。
2. **已修 P1：回报后仍可申请/消费工具。** 原核心没有回报封口条件。本候选 `canTool` 拒绝 reportReceipt 已存在的运行，旧 permit 也不能执行；相同报告仍可取回幂等回执。新离线 OS 驱动覆盖该行为。
3. **保留 P0 阻塞：hook 不是独立执行边界。** #142 `relay.ts:runRelay` 的 controlled 路径仍只返回 deny，`host.ts:GlobalHookHost` 仅收观察事件；#147 `hook-router.ts` 只返回内部 permit。它们均不能证明 CLI 没有绕开 hook。没有把 observe token 接到审批入口。
4. **保留 P0 阻塞：IF-2 非整个 profile 的统一 owner 服务。** #147 `ownership.ts` 对 Worker schema2 有 writer 排他、reserve/attach/bind、CAS 与未知格式拒绝；仍没有 Station/user-adopted schema 的授权迁移和 rebind。本候选注册主进程唯一 Worker 服务；已存在旧 schema 直接失败，绝不用空清单覆盖。崩溃遗留 writer/launch 保留待人工恢复。
5. **保留 P0 阻塞：事后检查不能替代隔离。** `boundary.ts` 只比较有限文件 hash；旧 process-tree/PTY 也不能阻止 shell 间接写入/联网。本轮使用真实 AppContainer 资源边界，Job 仅管理生命周期。测试结果只覆盖本次私有目标，不概括全部 Windows 可访问资源。
6. **#146 复审：逐次外部写裁决保留。** `canonical-execution.ts:commandApprovalRisk` 与 `task-authority.ts:evaluateTaskAuthority` 每次重新识别外部副作用；不使用工具名/fingerprint/同 provider ID 跨会话复用。本候选 broker 不执行任意 shell 或远端写，即使 UI 批准也不扩展该能力。
7. **#142 复审：私有文件创建与受控准入保持。** `file-security.ts` 在 Windows 创建文件时设置 DACL/owner；不接受先写再改 ACL。本轮私有通道同样在 CreatePipe 时设 DACL，HANDLE_LIST 只继承两个 worker 端句柄。旧终端 daemon 的事后 pipe ACL 脚本不能作为本次新通道证据。
8. **已修：Windows DOS 设备目标。** 仅限制 basename/`.txt` 后缀不能排除 `CON.txt`、`NUL.txt` 等设备名；broker 在审批/打开文件前显式拒绝此类目标。真实受保护通道回归确认拒绝后整树停止。

补充实时状态：[#83 已结项](https://github.com/AhakeyAI/ahastation/issues/83#issuecomment-6517382900)，其关闭只代表契约确认，未代表运行时 owner/守卫接线完成；下文“缺接口”指所选代码基线缺运行时接线，不重新把已确认字段列为待定。

## 最小真实调用链

这里“真实”指 OS 守卫、私有通道及实际 broker 副作用。驱动使用显式 `fixture-*` 会话 ID，只写新建的隔离验收 registry，不是 Claude/Codex 原生 ID；工厂拒绝普通 profile。真实 CLI sessionId 的取得与核验、terminal adapter → guard 仍未接通。不能把下列 IF-2 事务回归称为原生 CLI 已登记或最小生产任务链已完成。

指定离线验收：`scripts/accept-native-worker.mjs` → `NativeWorkerProfileService` → 既有 `NativeWorkerRun.start` → IF-2 reserve → `WindowsAppContainerGuard` → C# helper 创建独立 AppContainer、私有管道、挂起进程、Job attach、校验真实 TokenAppContainerSid/GetProcessTimes/boot GUID → resume → protected bind → IF-2 bind 持久化 → 才开放输入。

动作：受限 relay → 私有继承管道 → helper 每帧核验持有的进程 handle/start/token/Job → opaque peer + 每运行随机凭据 → `NativeWorkerBrokerChannel` → `requestTool` → 真实 authority journal flush → 私有 run journal fsync → 一次 permit → broker 核验完整 call/cwd/输入摘要/期限/代次并 `consume` → 同一事件循环同步 `wx` 创建并 fsync 精确 UTF-8 内容。没有将 allow 交还任意 shell。

回报：同一受保护通道 → 当前 attempt + schema + 实际已创建文件 hash（本边界没有执行测试，拒绝声称 passed/failed）→ 私有候选日志 fsync → 调度器 ports 的当前 attempt 检查 → 既有 delivery/flush → receipt 日志 fsync → 回执。重复请求复用回执；进程重启不恢复旧 authority/permit。

停止：同步 invalidate/撤销 permit、seal 输入与审批 → 中断/关闭宿主通道 → TerminateJobObject → QueryInformationJobObject 的 ActiveProcesses=0 加匹配的 OS start/boot 身份 → `confirmTreeExit`。helper 消失只得到 unknown；根退出/EOF/Stop 本身从不充当 confirmed 或成功回报。

## 生产接缝表

| 调用方 → 实现/责任方 | 输入 → 输出 | 失败行为/当前状态 |
|---|---|---|
| main → `registerNativeWorkerProfileService`（Leo） | OS userData profile → 惰性服务 | 启动不改 registry、不启动 Worker；退出先关闭服务 |
| scheduler → `nativeAuthorityPorts`（Leo） | 捕获的真实 handle/attempt/grant → 当前裁决、审批卡、journal、candidate callbacks | 旧 attempt、缺 flush/journal、停止均拒绝；单次 UI 回复不扩为 task-wide |
| terminal adapter → profile service（Leo，P3） | 受信任 ports + 已验证 CLI/ConPTY 启动配置 → BackendSession | **未接通**。本候选只传递 ports，原生任务 gate 仍关；不并行启动 SDK 和第二个 CLI |
| profile service → IF-2 Worker writer（Leo） | approved grant 的 approvalDecisionId + runtime/task/attempt/credential ref → 原子绑定 | 一个服务持 writer lease；外部 writer/未知 schema 拒绝；不是整个 Station 的统一写者 |
| Station authority → IF-2 owner（eternal904 #83，Dryoung95 #72） | 实际 owner 授权、授权代次/撤销、Station 记录 schema、迁移/rebind CAS → 可验证 owner | **缺接口，不支持 Station 启动/rebind**；没有伪造权限 owner/Hub 身份 |
| native hook → protected broker（Leo） | 完整动作/目标/cwd/input + 当前身份/代次 → one-shot permit/实际结果 | 新 broker 已实装；现有全局 controlled relay 仍 deny-only。原生工具到 broker 的接线属于 P3 |
| runtime → credential/peer（Leo） | AppContainer SID + 持有 OS handle/创建 FILETIME/boot GUID + 私有管道 → opaque capability | 不能用 PID/env 伪造；凭据不写磁盘/argv/env；每运行独立。允许同 Job 后代分享本次权限，不声称逐后代归因 |
| engine → report（Leo + scheduler） | 当前 attempt 的报告、真实文件 hash → durable candidate receipt | 离线通道已跑通；真实 Claude/Codex tool turn/WorkReport 尚未验收 |

## 边界选择及成本

首个 guard 选择 Windows 离线 AppContainer broker，复用原有 execution core、IF-2 与 scheduler/journal 接缝。它仅支持私有工作区顶层新建 `.txt` 文件，拒绝覆盖、链接、任意命令和联网。隔离工作区要求创建时私有 ACL。普通工作树、交互终端和现有 CLI 登录配置不能直接套用本边界。

官方 AppContainer 允许系统/显式授权资源及容器自身存储；本候选不是“所有宿主文件绝对不可写”的通用沙箱证明。它不授予 workspace/用户配置/网络 capability。真实任意 CLI 方案需要进一步验证 LPAC/出口与凭据 broker、ConPTY 句柄继承及配置映射，或者受控执行服务。不能通过放宽到 ALL APPLICATION PACKAGES、映射整个 HOME 或直接联网来消除兼容问题。

维护成本：Windows helper 使用系统 .NET Framework 编译，不引入运行期编译器；构建/CI 编译并打包 helper。维护 Win32 ABI、签名/安装路径完整性、临时 AppContainer profile 清理与 OS 版本兼容。威胁模型信任宿主同用户程序/调试器和管理员；不试图防御已控制宿主账号的恶意进程。

G13：没有读取/复制个人 `~/.claude`、`~/.codex` 或系统登录状态。受限子进程使用白名单环境；每运行 profile 不复用登录。官方二进制仅在隔离配置下执行 `--version`，同时在同一个真实 AppContainer/Job 内验证可启动；不等于 OAuth、Keychain、模型和插件兼容。升级 CLI 或改登录/出口方案需要单独确认与真实引擎验收，不能自动升级依赖。

验收证据、能力矩阵见 `docs/c0/native-worker-capability-matrix.md` 与 `docs/evidence/native-worker-production/local-validation.json`。主对话负责独立复审；Shawn 负责指定 Mac Claude 与 N5095 上 Claude/Codex 各 S1–S6、S8、S11 的 B04。未授权模型、可见 PTY 和全局配置动作没有执行。
