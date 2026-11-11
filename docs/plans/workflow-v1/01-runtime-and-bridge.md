# 01 原生执行与桥接

## 边界与代码入口

RuntimeService 拥有进程启动、轮次控制、会话恢复和资源租约。NativeAdapter 处理各 CLI 的参数、hooks 和原生事件。BridgeServer 认证成员消息并调用工作流服务。TerminalService 只处理显示和输入。

复用并改造 electron/backends/terminal-cli-adapter.ts、claude-terminal-adapter.ts、codex-terminal-adapter.ts、worker-cli-bridge.ts、worker-cli.ts、pty-host.ts、agent-process-scope.ts、agent-resource-pool.ts。建议新增 electron/workflow/runtime.ts 与 contracts.ts，避免复制一套 CLI 启动逻辑。

## 适配器契约

```ts
interface NativeAdapter {
  probe(binary: string): Promise<CapabilityEvidence>;
  prepare(input: LaunchSpec): Promise<PreparedLaunch>;
  spawn(input: PreparedLaunch): Promise<ProcessIdentity>;
  inspect(executionId: string): Promise<RuntimeObservation>;
  deliver(input: NativeInstruction): Promise<DeliveryReceipt>;
  interruptTurn(executionId: string, turnId: string): Promise<StopEvidence>;
  stopProcess(executionId: string): Promise<ExitEvidence>;
  resume(input: ResumeSpec): Promise<PreparedLaunch>;
}
```

LaunchSpec 含执行 ID、Worker ID、预期委派版本、cwd、模型、原生配置来源、运行目录和权限档案。PreparedLaunch 含可执行文件绝对路径、argv 数组、环境、hooks 清理清单和配置摘要。敏感环境变量不进入日志。

ProcessIdentity 至少包含 PID、启动时间或平台创建标识、可执行文件、所属进程作用域和本次执行 nonce。PID 单独不足以辨认进程。Windows 使用现有进程树证据，子进程脱离后状态标记为需核对。

CapabilityEvidence 按后端、版本、平台、配置模式存储 verified / unsupported / unknown 与证据路径。以下能力分别验证。

| 能力 | 接受依据 |
|---|---|
| ready | 原生会话/提示输入就绪的明确事件或已验证 hook |
| resume | 精确原生会话 ID、实际 cwd 和恢复结果 |
| instruction | 同一会话原生协议、已认证 inbox 或可靠边界终端注入 |
| idle-wake | CLI 停在输入提示时投递指令：原生协议，或经验证的空闲注入（输入框为空、提交被接收的证据） |
| resume-with-instruction | 结束进程后用原生恢复命令按会话 ID 重启，并通过参数或文件携带指令；接收由提交 hook 或首个轮次证据确认 |
| turn-start / turn-stop | 绑定原生会话及轮次的事件 |
| subagents | 原生内部执行标识及可观察的开始/结束 |
| process-exit | 根进程和相关子进程退出证据 |
| input-scope | 原生权限与工作流实际可实现的约束 |

### P0 实测能力结论（win32-x64，2026-11-10）

已在 Windows 11 (`win32-x64`) + ConPTY (`@lydell/node-pty`) + 本地回环 Mock 模型服务下对真实二进制完成 P0-A、P0-B、P0-C、P0-H 实测：

| 能力 | `claude-code 2.1.318` (`win32-x64`) | `codex-cli 0.167.0` (`win32-x64`) | 实测证据与约束 |
|---|---|---|---|
| `ready` | **verified** | **verified** | 两者均触发 `SessionStart` hook，上报 `session_id`、`transcript_path`、`cwd`；交互式 TUI 还需结合输入框就绪与无模态弹窗（如 Claude 自定义 `ANTHROPIC_API_KEY` 确认框）后才允许注入 |
| `resume` | **verified** | **verified** | `claude --resume <session_id>` 与 `codex resume <session_id>` 均保持原 `session_id` 不变，且向模型请求完整携带前序轮次历史 |
| `instruction` | **verified** | **verified** | 首轮参数/粘贴提交与运行中 `aha-worker inbox` 均由 `UserPromptSubmit` hook 回传 `session_id` + 轮次标识（Claude 为 `prompt_id`，Codex 为 `turn_id`）及 `prompt` 原文确认 |
| `idle-wake` | **verified** | **verified** | 交互式 ConPTY 在上一轮 `Stop` 到达且 `draftPossible=false` 时，通过 bracketed paste + `\r` 注入可稳定触发下一轮 `UserPromptSubmit` → `Stop`，并拿到新的 `prompt_id` / `turn_id` |
| `resume-with-instruction` | **verified** | **verified** | `claude --resume <session_id> ... <prompt>` 与 `codex resume <session_id> ... <prompt>` 均在同一 `session_id` 下携带历史上下文直接启动新轮次，并依次触发 `SessionStart` → `UserPromptSubmit` → `Stop` |
| `turn-start / turn-stop` | **verified** | **verified** | `UserPromptSubmit` 与 `Stop` 成对到达并携带同一 `session_id` 与轮次 ID（Claude `prompt_id` / Codex `turn_id`）及 `last_assistant_message` |
| `subagents` | **unknown**（默认降级） | **unknown**（默认降级） | Claude `Stop` payload 虽含 `background_tasks` 字段，但两者均不能在通用进程/shell 派生下单独证明所有子写入已静止；按 P0-C 结论统一走 `scope=process` 冻结降级 |
| `process-exit` | **verified** | **verified** | 修正 ConPTY 异步 `pid=0` 启动登记后，`taskkill /pid <rootPid> /t /f` + `Win32_Process` 进程树枚举可确认根进程、子 agent 与脱离轮次的后台写入进程全部退出 (`survivors=0`) |
| `input-scope` | **verified** | **verified** | 工作流独立 worktree + 受保护运行时目录 + 轮次绑定凭据句柄 |

**P0 实测暴露的关键实现约束（实现批次 2/3 必须遵守）**：
1. **Windows ConPTY 异步 PID 登记（P0-C）**：`@lydell/node-pty` 在 Windows 下调用 `spawn()` 的同步瞬间 `pty.pid === 0`，真实 PID 在异步 `_completePtyConnection` 后才填入。`PtyHost` 与 `RuntimeService` 必须在异步拿到真实 `pid > 0` 后再调用 `trackAgentProcess`，否则进程作用域漏记根进程。
2. **Codex Windows Hook 配置与命令语法（P0-B）**：`codex-cli 0.167.0` 中 `hooks` 是 TOML 表（`[hooks]`），开关位于 `[features] hooks = true`（0.167.0 默认开启），禁止再传 `-c hooks=true`（会报 `cannot extend value of type boolean with a dotted key`）。Windows 下 `codex.exe` 通过 `powershell.exe -Command` 执行 hook 且默认过滤环境变量，hook 命令必须使用 PowerShell 兼容调用（如 `$env:ELECTRON_RUN_AS_NODE='1'; & '<execPath>' '<hookScript>'`），并在隔离排除工作区不受信任 repo hooks 的前提下传入 `--dangerously-bypass-hook-trust`。
3. **Windows 扩展路径前缀归一化（P0-B / P0-H）**：`codex resume` 触发的 hook 中 `transcript_path` 带有 `\\?\C:\...` 前缀，适配器比对路径前必须剥离 `^\\\\\?\\`。
4. **原生轮次 ID 字段映射（P0-A / P0-B）**：Claude Code 在 `UserPromptSubmit` / `Stop` 中使用 `prompt_id` 作为原生轮次标识，Codex CLI 使用 `turn_id`；适配器统一归一化为 `nativeTurnId`。

仅检测到输出或固定等待超时不足以判定可以注入。需要用户完成登录、信任配置或 hooks 时显示原生终端并等待能力就绪。缺少轮次停止证明的组合，冻结或交接自动降级为结束进程后执行（见“中断、冻结与后台执行”）；连进程树退出也无法确认时才返回 CAPABILITY_UNAVAILABLE。

## CLI 版本与能力漂移

Claude Code 按设置的来源解析（electron/claude-cli/resolve.ts）：默认使用用户安装的版本（PATH 及常见安装目录），找不到时回退到应用内置版本；来源设为 bundled 时优先内置版本，此时版本随应用固定。Codex 只从 PATH 解析。用户安装的版本会因手动升级或 CLI 自动更新而改变，已验证的能力可能失效。处理规则：

1. **每次启动都记录版本**：prepare 阶段记录可执行文件的绝对路径、版本输出和文件指纹（哈希，或大小加修改时间），写入 Execution。能力查找按后端、版本、平台和配置模式精确匹配，不按“最近一次验证”套用。
2. **未验证的版本暂停自动投递**：spawn 前运行 probe 中不需要模型调用的项，包括版本输出、启动参数、hooks 配置加载和恢复命令形式。快速探测失败时不启动该后端，返回 CAPABILITY_UNAVAILABLE 和具体失败项。快速探测通过后：
   - 需要真实轮次才能证明的能力（ready、instruction、idle-wake、turn-start/stop、subagents、resume-with-instruction 的接收证据）在新版本上标为 unknown。自动降级也只能使用该版本已验证的能力，因此 resume-with-instruction 同样不能用于自动投递。
   - 该版本上的 Worker 暂停自动投递：首个委派、答复、continue、修订和新目标都保持 deferred，原因为 VERSION_UNVERIFIED，并通知 Host。
   - 不依赖 CLI 轮次证据的操作仍然可用：用户在原生终端中的人工操作；结束进程以及基于进程树退出的冻结，它们依据 agent-process-scope 的进程证据，与 CLI 版本无关。
   - 界面提供三个入口：运行该版本的能力验证（涉及模型调用的项在执行前列出）；改用已验证的版本（Claude Code 切换为应用内置版本，或指定已验证版本的可执行文件路径）；人工投递（显示待投递指令全文和复制按钮，用户自行粘贴并提交，然后在界面确认“已提交”，记为来源为用户的人工投递回执，不当作原生接收证据）。
   - 验证通过后恢复自动投递，deferred 消息按顺序投递。
3. **执行期间版本不变**：工作流启动的 Worker 进程关闭 CLI 自更新。Claude Code 通过环境变量 `DISABLE_AUTOUPDATER=1`；Codex 及其他 CLI 使用各自的配置项或环境变量，按锁定版本核实，没有关闭机制的记录在 CapabilityEvidence 中。只对本次启动的进程生效，不修改用户的全局安装和配置。
4. **恢复时重新检测**：恢复或创建替代执行前重新解析并记录版本。与原 Execution 版本不同时写入 cli-version-changed 事件，原生会话恢复的兼容性按新版本的能力证据判断；恢复失败按 NativeSession 替换规则处理并告知 Host。
5. **按成员各自取能力**：同一工作流中的 Worker 可能运行不同版本，各自按自身 Execution 记录的版本取能力，界面在成员详情中显示版本与验证状态。

## 启动与恢复

1. 在数据库事务中创建 Execution starting、session 租约和 spawn 意图。
2. 创建 userData/workflow-runtime/<executionId>，生成凭据和配置，权限仅当前用户可读。
3. 启动真实 CLI PTY，保存原生会话绑定和进程身份，再标为 running。
4. 等待 ready 证据，先原子预留 execution-slot 并登记本次投递意图，再投递首个完整委派。
5. 原生输入接收事件登记 Turn active，并将预留槽位转为该 Turn 的占用。只有证明指令未被接收且不会执行时才释放未使用预留，结果未知时保留占用。用户直接输入产生的轮次也登记实际资源状态。
6. 任一步崩溃时依据 operationId、运行目录和进程身份核对。启动意图存在而结果不明时保持 unknown，禁止盲目重启。

恢复沿用 Worker ID。只有实际原生恢复成功时沿用 NativeSession 引用。无法附着旧 PTY但旧 CLI 仍存活时显示待核对，停止旧进程确认后才能恢复或创建替代执行。新执行使用新的 Execution ID 和凭据。

旧执行身份始终无法核对时（进程证据缺失、作用域丢失或平台无法枚举），只有用户可以确认“放弃旧执行”，Host 不能发起。服务先尽力结束仍可识别的进程树，再把旧 Execution 及其未结束的 Turn 标为 abandoned，记录放弃人、时间、已尝试的停止动作和剩余风险，然后释放唯一执行约束与资源。旧凭据随之失效，旧执行目录在重新分配写入前标为 retired-write-scope。abandoned 之后才允许创建替代执行。

## 双通道

真实 CLI 的 PTY 是显示与交互通道。桥接服务器仅监听 loopback，使用随机端口、带有效期的执行凭据及请求体上限。通过受保护的运行时文件发现地址，端口不作为身份。

每次 aha-worker 调用读取凭据文件，环境中仅保存运行目录和工具入口。调用时锁定所用版本，调用重试保持相同 requestId。hooks 引用轮次绑定的凭据句柄，避免旧轮次重新读取文件后冒用新版本。

```ts
interface WorkerReportEnvelope {
  protocolVersion: 1;
  requestId: string;
  executionId: string;
  delegationVersion: number;
  nativeTurnId?: string;
  kind: 'accept' | 'progress' | 'question' | 'candidate'
      | 'failure' | 'instruction-ack' | 'lifecycle';
  body: unknown;
}
```

服务根据凭据解析 workflowId 与 workerId，再核对报文中的执行与版本，从准确委派查出 workId。数据库保存令牌哈希和权限状态，明文仅在受保护文件。历史上报保留原工作和委派归属。

Worker 主动发送的 progress、candidate 或“已经停止”是声明。状态服务仅接受适配器核对后的生命周期事实推进进程和轮次终态。模型调用的桥接权限与适配器生命周期回执权限分别校验，生命周期报文核对原生身份、来源及操作 nonce。V1 同用户环境下仍不承诺防恶意篡改，但不能让普通 Worker 报告被当作停止证明。

| 桥接操作 | 输入与结果 |
|---|---|
| inbox | afterMessageSeq、limit；返回有序消息及游标，读取本身不确认处理 |
| ack | messageId、received/consumed、nativeTurnId；返回持久化回执 |
| question | questionId、说明、选项、阻断操作；立即返回已登记，不长期占住工具等待用户 |
| progress | 简短摘要、证据引用；按量限流并允许摘要合并 |
| candidate | 预备成果描述；返回冻结请求 ID，冻结完成后服务发布 Candidate |
| failure | 错误类别、可恢复信息和证据；由 Host 决定继续方式 |
| lifecycle | hook 类型、原生身份、关联子执行；由适配器核对可信来源 |

question 返回后 Worker 结束当前轮次或停止受影响操作，服务等待 stop 证据。答复已经到达但旧轮次未停止时可以入队，投递仍遵守能力和输入所有权。收到答案只解决对应问题，全部阻断条件解除后才允许恢复自动执行。

候选请求采用异步冻结，避免桥接工具阻塞期间等待自身退出的循环。只有实际停止并完成冻结核对后，才进入业务 candidate 状态。

## 指令投递路径与降级

指令包括用户答复、continue、修订和新目标。投递路径按 CLI 当前状态选择：

| CLI 状态 | 可用路径 | 说明 |
|---|---|---|
| 轮次进行中 | 原生 steer、已认证 inbox | 只作为提前通知；修订仍在轮次边界激活 |
| 空闲，停在输入提示 | 原生协议，或经验证的空闲注入 | inbox 不会被调用，因为模型没有运行 |
| 空闲且不能注入，或注入结果不可验证 | resume-with-instruction | 结束进程并确认退出，再用原生恢复命令带指令重启 |

空闲注入的前提：
- 适配器的 idle-wake 已验证为 verified。
- 没有人工输入所有者。
- TerminalService 的 draftPossible 为 false，即用户自上次提交以来没有向该终端输入过字符。草稿可能存在时不注入，消息保持 deferred 并提示用户。
- 注入后需要提交 hook 或轮次开始证据作为接收确认，固定等待不算确认。

resume-with-instruction 是两种 CLI 的通用降级。它用于答复、继续和修订，代价是 TUI 重启一次，界面显示“为投递指令已重启会话”。原生恢复失败时不静默改用新会话，按 NativeSession 替换规则处理并告知 Host。具体命令形式（例如按会话 ID 恢复时附带首条提示）按锁定的 CLI 版本在 P0-H 验证。

## 委派版本切换

一个 Turn 固定一个委派版本及其 workId。对当前工作的普通留言和补充说明保留当前版本，涉及目标、路径、验收或交付要求改变时，在同一 workId 下创建 pending 修订。排队的新工作按 02 领取后才准备新版本和凭据。

运行中可提前送达修订通知，但新版本在安全轮次边界生效。紧急修订先 interruptTurn；支持 steer 也不能直接把旧 Turn 改写成新版本。

切换流程为 old turn stopped → prepared revision → native input acceptance → 原子激活 → new turn active。接收确认优先使用同一会话的提交 hook 或原生协议，hook 在模型继续执行前回传新版本标识。事务同时更新 currentVersion、旧版本状态、新旧凭据权限及事件。

无法提供接收门禁的后端，使用 resume-with-instruction：结束旧进程后带新版本恢复会话，新 Execution 以新版本开始；该能力差异显示给用户。

修订处于 pending 时，用户在终端手动发起的轮次绑定当前（旧）版本，并记为人工轮次；修订在该轮结束后的下一个边界激活。用户的这次输入不会被当作修订的接收确认。pending 修订撤回或投递失败时旧版本仍为当前。最多保留一个 pending 修订，第二次修订只有在前一修订尚未投递时才能用预期版本替换。前一修订已经投递或结果未知时返回 REVISION_IN_FLIGHT，先核对或确认撤回，避免旧接收回执把已替换的修订激活。

崩溃在原生接收和事务提交之间时查询消息接收标识及会话证据；不能核实时保留 unconfirmed。旧令牌历史报告保留，旧权限操作拒绝。

## 中断、冻结与后台执行

interruptTurn 返回 requested 只说明已发出中断。Turn stopped 需要主轮次结束、内部 subagent 核对及本轮写入进程结束的组合证据。Stop hook 是线索，不能单独证明所有子执行已停止。[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Claude hooks](https://code.claude.com/docs/en/hooks)

允许驻留的开发服务器在 Execution 中登记。可能写入候选路径的 watcher 仍需暂停，冻结必须取得写入静止条件。冻结期间暂时禁止自动输入及原生终端新提交，用户可选择解除冻结并使候选作废。

交接原工作区时，需要保证旧驻留 CLI 再次接受人工输入不会写入已交出的目录。V1 默认从 Candidate 创建接手者的新 worktree，并将旧 Worker 标为 retired-write-scope。再次启用旧目录写入前需服务明确重新分配；无法执行该限制时结束旧 CLI。

冻结降级：适配器无法证明内部 subagent 与本轮写入进程已停止时，冻结、交接和版本切换改用 scope=process。服务结束 CLI，依据 agent-process-scope 确认整个进程树退出，以此作为写入静止证据后再采集；之后按原生会话恢复 CLI，或在不需要继续时保持停止。进程树退出同样无法确认时，Turn 保持 unconfirmed 并返回 CAPABILITY_UNAVAILABLE，由用户决定是否放弃该执行。

## 资源与超时

session 统计真实 CLI 常驻数量，execution-slot 统计 active/interrupting/unconfirmed Turn。Host 有保留容量，桥接回复、查询、停止不竞争模型执行槽。用户接管终端执行也计入统计；V1 对无法在模型前阻断的手动启动显示超额，停止自动派发。

session 按进程生命周期独立分配，尚未取得会话容量时不占执行或独占资源。CLI 就绪后，同一次自动轮次需要的 execution-slot 和 exclusive 租约作为一个资源请求分配，条件不足时不持有这两类资源的部分租约等待另一类。驻留 CLI 等待执行资源时仍计入 session，其空闲回收规则用于避免常驻进程长期挤占新成员容量。

Host 保留容量按实际会话及执行槽分别计算。闲置会话回收需要确认无活动轮次、无人工接管、无运行中外部操作且会话可恢复。资源队列按入队顺序与显式优先级调度，已等待的独占请求保留排队位置，防止短任务持续抢占导致长期饥饿。

所有超时只触发核对或用户可见异常，不把进程标记为已退出。常量通过 RuntimePolicy 配置，测试通过可注入时钟覆盖。默认不自动杀死仍有未知副作用的执行。

## 验收

RT-01 登录界面不被误注入；RT-02 原生会话恢复；RT-03 问题即时持久化且不阻塞收件；RT-04 旧版本在修订接收前可回报；RT-05 修订中崩溃不双启动；RT-06 中断保留 TUI；RT-07 子 agent 未停止时不做轮次级冻结，降级为结束进程后冻结；RT-08 用户输入与 Host 输入不混写；RT-09 进程 PID 重用不被误认；RT-10 空闲提示符注入在输入框有草稿时拒绝注入；RT-11 resume-with-instruction 投递答复与修订，会话上下文保留；RT-12 无法核对的执行经用户放弃后可创建替代执行，旧证据保留；RT-13 修订 pending 期间的人工轮次绑定旧版本；RT-14 未验证的 CLI 版本快速探测通过后，自动投递暂停，界面提供验证、改用已验证版本和人工投递三个入口，且不使用未验证的 resume-with-instruction；RT-15 执行期间 CLI 不自动更新，用户全局配置不被修改；RT-16 用户升级 CLI 后恢复成员，版本变化被记录并按新版本取能力。

`win32-x64` 下的 `claude-code 2.1.318` 与 `codex-cli 0.167.0` 已完成 P0 真实 CLI 能力实测（见上表），其余平台或未验证版本仍须按實際版本证据决定启用。

