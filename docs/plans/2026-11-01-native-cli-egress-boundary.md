# 原生 Worker：ConPTY 启动候选与联网决策边界

2026-11-01，Asia/Singapore。执行依据为协调工作区本地最新版 `2026-10-31-native-worker-completion-plan.md` 的“机制优化”和“现在就做的工作包”；原文件保留未改。本文件交付 P1 的具体边界判断和一项可运行的 Windows 启动原语，以及现有核心的审批/回报修复。**P1 尚未全部满足，P2/P3 生产链未完成；真实 Claude/Codex 工具回合与 B04 均 unknown。**

## 固定来源与独立范围

开始时刷新源仓库 `AhakeyAI/ahastation`，以下 head 均未漂移：

| 来源 | SHA | 状态 |
|---|---|---|
| main | `8770207ca4e41f3f31201d418a980593adf51efd` | 已含 #135 |
| #142 | `6ea1fc1a752967fa19d4ddf08a50b3f75d0fc706` | Open Draft；全局 hooks 依赖 |
| #146 | `ae9d27246e105c97ea72275a0cbbee91a2980fc8` | Open Draft；逐次审批依赖 |
| #147 | `42f1a51c0eb1ef481195ce0501e88b2d417da56c` | Open Draft；现有 Worker bridge |
| #148 | `8bbb7e07b9b3a375e6a8d28a3bf02c65e0a74008` | Open Draft；本轮直接基线 |

新分支 `codex/native-cli-egress` 从 #148 精确 head 建立；独立 diff 为 `8bbb7e0..本候选`。旧工作区干净且旧任务不活跃，但宿主拒绝重新附加，原因是归属另一 chat；因此使用宿主创建的新隔离 worktree。未改 #85/#130、Desktop 混合 checkout 或协调工作区未跟踪文档；没有合并、关闭 Issue 或联系成员。

保留 Claude 2.1.150 / SDK 0.3.150、Codex 0.156.1 / SDK 0.156.1 与现有 lockfile。没有升级版本、改登录产品契约或把 CLI 工具重写为一套 broker 工具。#148 的管道背压/UTF-8 修复保留；仅在改变 helper 入口后回归其现有用例。

## 已实现的真实启动边界

源码入口：`electron/native-worker/windows-conpty.ts:WindowsConPtyProcess.spawnOffline` → `native/worker-guard/WindowsConPty.cs:TerminalGuardian`；`scripts/build-worker-guard.mjs` 将新 partial 类编入现有 helper，并记录新源文件摘要。

实际顺序：

1. 宿主校验固定 helper/目标映像 SHA，创建自己持有的新临时根目录。只复制一个独立 `.exe`，复制期间禁止写/删共享，再核验暂存映像 hash；不使用 PATH、shell shim 或个人安装探测。
2. helper 创建独立 AppContainer SID、无网络 capabilities、独立 ConPTY。临时 image 仅授予该 SID 读/执行；新 workspace/home 单独授予 Modify 并设置低完整性标签。只降低自己新建目录的标签，不修改用户工作树、HOME 或全局 ACL。
3. 同一次 `CreateProcess` 传入 `SECURITY_CAPABILITIES` 和 `PSEUDOCONSOLE` 属性，带 `CREATE_SUSPENDED`。清空标准句柄，禁止继承宿主 JSON 控制管道。随后在挂起状态附加无 breakaway、`KILL_ON_JOB_CLOSE` 的 Job，核验真实 token SID、GetProcessTimes、boot identity 与 Job membership。
4. helper 返回 suspended 身份。宿主可先 attach 运行记录、`PtyHost.adopt` 接入现有缓冲/订阅；adopt 本身不 resume、不建立原生 sessionId、不授予任务输入。只有显式 `resume()` 才恢复目标线程；超时、EOF、前置输入、重复 resume 或协议错误触发封口与回收。
5. 原始终端字节走独立 ConPTY 管道，以 base64 封装进 helper 控制帧；Node 流式解码 UTF-8。终端打印的伪造 `tree-exit` JSON 仍是显示内容，不能充当守卫证据。
6. stop 同步封输入，独立控制线程执行 `TerminateJobObject`，仅匹配该运行身份且 `ActiveProcesses=0` 的帧可确认；EOF/根退出/PTY 内容不能确认。输入/输出各 32 项、2 MiB 有界队列，后台 writer 和 ConPTY close 不阻塞回收路径。

`PtyHost` 复用旧 PTY 接口；普通终端继续走 node-pty。对新 guarded PTY，`terminateTree` 使用对象持有的 Job 证据，不回落 `taskkill PID`。未确认时保留 sealed owner；`kill/killAll` 也不能静默 dispose 后显示成功。没有启动第二套调度器或同时派发 SDK 和 CLI。

这是**离线启动原语**，有意没有声明为 `NativeExecutionGuard` 实现：它缺保护 hook/回报入口、当前 attempt 绑定及模型/工具出口。不能将它传入旧 broker，把终端文本当凭据，或用新的 env/setting 开关绕过 admission。没有开启 renderer/daemon 远端 adopt API。

微软的 [ConPTY 创建顺序](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session) 和 [启动属性 API](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) 支持上述组合方式；Job 只承担归属与收树。[AppContainer 文档](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) 说明普通 AppContainer 仍可访问已向应用包公开的资源；本轮私有 sentinel 证据不能扩张为“任意外部文件全部不可达”。后续需要 LPAC/明确的资源策略及引擎兼容证据，不能以 Job 或 hash monitor 代替。

## 联网、凭据与工具执行的可实施选择

当前实现只提供 **no-network** 模式。拒绝忽略代理/直接连接的基础是 OS 受限 token，不是 `HTTP_PROXY`。没有创建 loopback 豁免、WFP 规则、TLS 根证书或真实联网账户；也没有验证 DNS、IPv6、重定向、Internet 直连、模型和登录刷新。

| 用途 | 必须区分的凭据/能力 | 实际约束方案与缺口 |
|---|---|---|
| 原生网页登录/设备流/刷新 | 用户选择的隔离登录目录、刷新凭据；与 GitHub token 分开 | 保留原生交互；不复制或映射个人 HOME。浏览器回跳、keychain/credential-store、刷新和退出撤权需要指定环境验证；当前新 home 未登录 |
| 模型推理 | 仅模型用途的账户凭据、受限推理出口和预算 | whole-CLI 无直连，出口需核完整协议/目标并保留原生认证。只允许 CONNECT 域名看不到路径/方法/正文；不能证明用途，更不能把这个代理给工具当通用出口 |
| 只读 GitHub/依赖下载 | 指定 repo/read scope；凭据不落任意 shell env | 有 OS 封网的原生工具进程，使用单独受控请求出口；只读 API 需 method/path/repo 结构化核验；重定向每跳重验，禁透传任意 Authorization。TLS 隧道或域名白名单不足 |
| push/发布/Issue 编辑 | 当次完整动作的最小权限凭据 | 外部写前核完整对象、远端、ref/commit/body/cwd/input hash、权限代次与期限，一次 permit 绑定整个动作；重放/变参拒绝。Git receive-pack 多请求须绑定同一完整事务，不能把批准 GET/CONNECT 当批准后续写 |
| 原生文件/Bash/MCP/插件 | 工具文件范围、后代身份和受限凭据 | native 写入本身受 OS ACL；获批 shell 的后代不能继承模型凭据或任意出口。未核实的插件/MCP 不开放；脚本命令名检查只作裁决输入，不能充当隔离 |

**关键未决点不是代理选项，而是调用来源的不可区分性。** 当前固定版本的 CLI 主进程同时执行模型通信和部分原生工具；子进程通常还继承同一凭据/环境。允许主进程的模型连接，不证明同一进程内工具没有借用该出口。透明 TLS 代理可按完整请求限制副作用，但单独不能证明哪个工具/permit 发起请求；自报 purpose/header/token 也不是来源证据。

当前官方 [Claude sandbox 文档](https://code.claude.com/docs/en/sandboxing) 指出原生 Windows shell 未受其内置 sandbox 约束，且文件工具、MCP、hooks 不在 Bash sandbox 内。这是当前产品边界参考，**不是** 2.1.150 的版本能力证明。[代理配置](https://code.claude.com/docs/en/network-config) 和 [认证方式](https://code.claude.com/docs/en/authentication) 也不提供本产品需要的工具来源 attestation。2.1.150 的失败阻断仍缺实际引擎证据，不能靠新文档字段解锁旧版。

| 路线 | 保留的能力 | 必须先交付/兼容影响 | 当前选择 |
|---|---|---|---|
| A：受支持的 CLI 工具执行边界 + 原生工具受限进程 | 保留登录/TUI/原生工具；不重写成 broker 工具产品 | 主 CLI、工具进程不同 OS 权限/凭据；原生内置网络工具也须在强制边界登记完整动作，禁缺 hook/未受信/禁用后绕过；Claude 需要可验证的供应商能力或认可的改造，Codex 可评估固定上游补丁；升级/补丁需 Shawn 接受 | 优先评估；固定版本能力仍 unknown |
| B：完整隔离环境 + 协议出口 | 保留环境内原生登录/工具；宿主原 PTY 仍作显示控制 | VM/WSL/隔离用户环境改变路径、凭据存储和工具安装；TLS 终止/隔离 CA 需适配原生登录/刷新，且仍需解决进程内工具来源与逐次外部写事务；环境本身不能补足这点 | 仅作为技术备选，未安装或启用 |
| C：只增加 env proxy/hooks/域名 allowlist | 改动少 | 无法证明强制分流、凭据隔离或完整外部写事前约束 | 拒绝作为准入依据 |

建议先确认 A 的固定版本/上游支持，ConPTY 原语可复用；若 A 的 Claude 能力不可获得，必须重新选择 B 的兼容范围并修订“进程内工具来源”要求或获得更强执行入口。此决定实质改变依赖、登录兼容与维护成本，不能由实施者默默接受更弱契约。当前不采购、不升级、不改全局配置，不因缺账户而停掉独立安全修复。

## 现有调度器接线与修复

真实链仍沿 `Orchestrator.resolveBackendSessionFactory` → `WorkerScheduler.spawnWorker` → `TerminalCliSession` → `PtyHost`。现有链包括 Host 派单/工作树/authority/原生 CLI；不能描述为只有手动终端。`TerminalCliSession.start` 的 Worker gate 继续在 binary resolution、配置写入和 spawn 之前拒绝。

- `nativeAuthorityPorts.askUser` 复用 `pendingAskCount` 与现有计划投影，让审批等待释放并发槽。resolve/abort/session dispose 会各一次清理和发送 `permission-cancelled`；仍不推广 task-wide，不用 UI 状态作 OS 证据。
- `NativeWorkerRun.report` claim 后立即禁输入、清未消费 permit、abort 未决审批；重复报告共用待持久化回执。候选回调完成后再核当前身份/权限/attempt，stop/revoke 竞态不能确认旧回执。
- scheduler 的 `handleWorkerSignal(delivery)` → DeliveryHarness 检查/候选流程保留。报告不是完成；`verifying/reviewing/awaiting-acceptance` 沿现有状态映射，返工需新 attempt。**新 ConPTY 尚无受保护报告客户端和真实执行证据；没有将普通终端 marker/Stop/EOF 接为 WorkReport。**
- 另一个实际接缝：scheduler 收报告会 `releaseWorkerSession`。真实原生 session 将来必须先封工具写权并完成候选/回执或明确失败，再结束通道；不能直接把 `session.end()` 实现成先杀回报树后等待回执。本轮未用延时/假成功掩盖该接缝。

停止 `stopping/confirmed/unconfirmed` 是守卫投影，不能把 task 的“待验收”改成“进程退出”。当前 guarded 对象确认失败时保留 sealed owner；完整 renderer 停止状态和接管单写者仍待真实 BackendSession 接通，未为界面另建业务状态机。

## IF-2 / Station 的实际阻塞

`NativeWorkerProfileService` 仍仅允许新临时验收 profile；其中 `fixture-*` 只登记离线 broker。新 ConPTY 不伪造 sessionId，也不把 provider CLI 启动 PID 当作 sessionId。真实链需在受保护 peer 上取得有效原生 session 证据，reserve→spawn suspended→attach OS identity→resume 至登录/信任/SessionStart→bind；bind 和 authority 就绪前不开任务输入。启动自身与输入任务分开，不能要求 CLI 从未运行就能产生 session ID。

#83 [已确认的 Station 责任](https://github.com/AhakeyAI/ahastation/issues/83#issuecomment-6495138162) 与 [结项说明](https://github.com/AhakeyAI/ahastation/issues/83#issuecomment-6517382900) 保留。该关闭只完成契约，不是运行时接线完成。所选源码 `electron/collaboration/station-service.ts:startTask/authorize` 有实际本机授权、workspace authorizationRef/校验和执行回执；没有把这些调用注册为 IF-2 `permissionOwnerRef` 的可核验授权 owner。

缺的具体运行时输入为：拥有实际授权的服务提供 owner ref、profile/subject/task-attempt 绑定、授权代次/撤权通知与重绑定 CAS；统一 profile writer 支持 Station/user-adopted schema、来源保留、失败恢复和迁移备份。责任仍是 eternal904（Station owner）、Dryoung95（扫描授权契约），Leo 提供 OS runtime/进程/凭据证明。现有 `WorkerOwnershipService` 不覆盖/迁移旧 Station 清单；没有用 role、Hub account、cwd、approvalDecisionId 占位映射成 Station owner。缺这些接口的启动保持不可用，其余守卫工作已继续完成。

## 可运行驱动、证据与指定实机缺口

隐藏入口：`node scripts/verify-native-conpty.mjs`。两端 typecheck、Electron/renderer/helper build，定向运行 ConPTY、PtyHost、native core、scheduler ports、admission 与已改 helper 的 transport 回归。结果写新目录 `docs/evidence/native-worker-conpty/local-validation.json`，不覆盖 #148 证据。源码/lock/helper hash 独立记录；记录中的 headAtRun+dirty/sourceHashes 描述实际执行源，不将未提交结果伪称已经来自最终提交。

本轮本地结果：上述检查均 exit 0，6 个定向测试文件共 **45/45**，0 skipped。Windows 自有 ConPTY 的 stop 样本为 3 ms、Job active=0；这是单次隐藏样本，不作跨平台延迟承诺。未执行真实 provider、模型、账户、可见 PTY、全量本机测试或真实远端动作。最终提交的完整 CI 另以 PR head 记录；本地样本不继承为 CI/引擎证据。

提交后自审另修一项启动时序竞态：先将 suspended 身份帧入队，再开启 ConPTY 输出 reader，避免极早终端字节先于身份帧到达宿主。仅重建受影响 helper 并运行 ConPTY/transport 两文件 **7/7**；新 ConPTY stop 2 ms，旧 transport stop/EOF 各 12 ms，均 active=0。当次新源/helper 摘要、命令及工具返回证据在 [guard-followup.json](../evidence/native-worker-conpty/guard-followup.json)；其余 TypeScript、两端检查和构建沿未改内容的 e93efb6 证据，不重复整套本机验证。

`b646dd9` 的 [CI 41300109411](https://github.com/AhakeyAI/ahastation/actions/runs/41300109411) 三平台全量测试均 0 失败（Mac 1330 pass/28 skip，Linux 1337/21，Windows 1356/2）；Mac/Linux 打包成功，但 Windows 随后的旧 broker 驱动失败，**该 run 整体为 failure，未完成 Windows 打包**。日志精确定位到第二次 report：驱动在 report claim 后继续调用宿主任务输入 API，新封口正确返回 false。修正 fixture 在第一次受控输入后自行通过原有私有子进程通道发送重复 report 和后续工具请求；不重新开放任务输入、不放宽 guard。新增 `--no-cli-probes`，本地 broker 回归可以完全不启动 CLI；默认 CI 的隔离版本探测保持。验证器也补入此无 CLI broker 入口，避免只测核心 mock 漏掉驱动接缝。

修正后隐藏本地：broker 允许/拒绝/journal 失败/变参/过期/重放/重复报告/回报后封口/stop/EOF 均通过，reportDeliveries=1、cliVersions=[]；受影响 ConPTY/transport **7/7**（stop 样本 1/11/10 ms、active=0），两端 typecheck 通过。新源/helper hash 和实际结果保存在 [broker-followup.json](../evidence/native-worker-conpty/broker-followup.json)。最终 head 的全量 CI/打包结果另记在 PR，不把上述失败 run 改写为通过，也不把未改核心的旧结果冒充最终 head 全量执行。

`tests/native-worker-conpty.test.mjs` 仅编译并隐藏运行自有 `tests/fixtures/native-conpty.cs`：宿主正对照可达的 TCP 目标、独立私有 sentinel、新临时 home/workspace；测试 suspended 阶段零执行、中文文件及输入、根/后代越界目标未变、无本地连接、伪造终端控制帧无效、Job 整树停止、宿主 EOF 在挂起态封口和映像 hash mismatch。网络观察有时限，不声称测试了全部协议/Internet；普通 AppContainer 可达公开资源的限制另列。

| 故障集 | 本候选证据 | 真实 CLI/指定环境 |
|---|---|---|
| 范围内/升级审批/拒绝/完整外部写 | 现有 native core/ports 定向协议证据；未给新终端发原生 permit | unknown；需路线 A/B 的真实执行边界 |
| stop 与批准/journal 竞争、旧凭据/代次/重放 | 现有 core/transport 离线回归；新终端用匹配 OS 身份确认 | 真实工具回合 unknown |
| 挂起启动、原生文件和控制台、后代、停止/EOF | 新 ConPTY 自有映像的 OS 证据 | Claude/Codex 均未执行 |
| 断线/宿主重启/CLI 重启恢复 | EOF 收树证据；不恢复旧 authority | 同原生 session 恢复 unknown，不重复派工能力未验收 |
| 重复/迟到报告、候选 I/O 与 stop | 同回执幂等、失败封口、stop 后不确认旧回执的核心回归 | 真实 WorkReport/Host 接受或返工 unknown |
| hook 缺失/禁用/未受信/崩溃/无效/超时 | OS 启动原语不依赖 hook；没有这六项 CLI 引擎运行证据 | 全部 unknown，不能由 fixture 绿色推导通过 |

最小实机任务沿 B04 的 sum 小仓库：只允许 src 编辑、读 test、运行指定测试；连续范围内动作应自动核验，新增依赖/新目标升级授权，拒绝 test 写后 hash 不变，独立 attempt 停止，带 diff/test/unresolved 的 WorkReport 先作候选。原始证据须含固定 CLI/helper/config hash、原生 sessionId、profile/task/attempt/runtime/owner 及权限代次；无法取得则 unknown。没有能够安全运行的生产 BackendSession 前不提供会放宽边界的“实机启动开关”。

本机不跑全量、不运行个人 CLI/登录扫描、不改真实配置、不自动信任、不调用模型/付费服务、不向真实外部目标写入。完整三平台测试与打包交候选精确 head 的 CI；Mac/Linux 的新 Windows OS 用例显式 skip。CI 绿不能取代 Shawn 指定 Mac Claude→WorkReport，及 N5095 对 Claude/Codex 各 S1–S6/S8/S11；B04 前 native 默认关闭。

## 0bf8508 复审 P2：正常退出码与整树退出分开

独立复审指出 `WindowsConPtyProcess` 将所有 confirmed 的退出硬编码为 `1`；原有隐藏用例只覆盖强制 stop/EOF，未覆盖程序正常返回。此问题已修正：helper 从持有的真实根进程 handle 读取 Windows DWORD 退出码，Node 不再用 helper 自己的退出码或常量代替；取不到值时明确为 `null`。

退出通知现在分别包含 `exitCode`、`stopReason`、`rootExitedBeforeStop` 与匹配运行身份的 `treeExit`（confirmed、activeProcesses、forcedTermination）。`PtyHost.onExit` 保留原来的首参数数值，并通过第二参数传递完整元数据。根返回 `0` 不证明后代已退出；仅 Job active=0 确认整树。根已成功退出、仍有后代被回收时，保留根的 `0`，同时记录强制回收事实。停止原因与根结果不能互相替代，也不代表任务成果已验收。

使用 [进程句柄等待](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject) 判定进程结束，再读取 [GetExitCodeProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess)，避免把 `259` 与仍运行混淆。自然退出结果在任何后代收树前保存；Job 计数清零与根进程对象完成置位分别核验，后者只做有界等待。控制台 EOF 先封输入，允许至多约 1 秒的正常退出核对；显式 stop/宿主 EOF 仍由独立控制线程立即触发收树，不等待该核对窗口。被动监测使用已持有的进程 handle，身份仍在启动及每次控制操作前核验，不把进程销毁中的瞬态误判成身份替换后强杀。

新增隐藏自有回归：正常返回 `0`、`37`、`259`、`0xffffffff`；主动关闭控制台后返回 `0`；根返回 `0` 并遗留真实后代。全部经生产 helper/ConPTY 和 Job 核验；同时保留 stop、宿主 EOF、终端伪造帧、未知停止、饱和管道和 UTF-8 回归。两端 typecheck、Electron/helper/renderer build 通过，相关三文件 **31/31、0 skip**。当次源/helper/lock 摘要和实际结果见 [exit-preservation-review.json](../evidence/native-worker-conpty/exit-preservation-review.json)。生产准入、CLI/模型、Station owner 和 B04 的未知边界不变；最终新 head 的三平台 CI 另记 PR。
