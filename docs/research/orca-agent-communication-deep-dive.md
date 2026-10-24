# Orca 多 Agent CLI 通信协调调度机制 —— 架构深度解析

> 探索日期：2026-10-24
> 对象：Orca 主仓库（`C:\Users\JHJ\Desktop\orca`）
> 方法：源码静态探索，所有结论附文件路径与行号（代码演进后行号可能有偏移）
>
> 归档：2026-10-24 由 Orca 仓库根目录复制到 AhaStation，作为「Aha 多 CLI 通信/编排」的设计输入。
>
> 对照基线：
> - Orca：`8e350554480ac5b77d3050a2040541fd334dad7c`（2026-10-15，`main`）
> - AhaStation：`c134de22efed4fbf17bb5af1c727f6f7c36a15f6`（2026-10-04），分支 `codex/multi-cli-phase1` 加当前未提交改动
>
> 阅读顺序：§0–§8 是 Orca 机制原样记录；§9–§12 是落到 AhaStation 的补充（映射、目标架构、不变量、许可边界）。只关心实施时直接看 §9。

> **抽验修正（2026-10-24）**
>
> - 启动目录 45 种 ≠ hook 覆盖 45 种。`MANAGED_AGENT_HOOK_INSTALLERS` 实际 23 家；结构化运行时只有 Claude / Codex / Pi + 3 个 ACP（grok / opencode / omp）。其余 CLI 只有 PTY，状态信号弱得多。
> - `orchestration coordinator-start` 已退役（`command_retired`），但 `Coordinator` 类仍可被 `orchestration.run` RPC 驱动。「自动 Coordinator 退役」指产品路径，不是类被删除。
> - tick 常量已核对：2s、并发 4、每 tick 最多建 1 个终端；`decompose()` 无任务时直接抛错。
> - 本文行号基于上述 Orca commit；跨版本引用前先重新定位。

---

## 0. 总览

Orca 不让各 agent CLI 之间直接互联，而是以自己为中枢，用「统一注册表 + 两条控制通道 + 一个 hook 状态回流 + 一套编排数据库」把 45 种 agent CLI（Claude、Codex、Gemini、Grok、OpenCode 等）纳入同一张调度网。**CLI 之间从不直接对话，所有协调都经 Orca 中转并持久化。**

```
                 ┌────────────────────────────────────────────┐
                 │              Orca 宿主（Electron）           │
                 │                                            │
  Orca → CLI ────┤  PTY 写入（终端形态） / 结构化会话 JSON-RPC     │
  CLI → Orca ────┤  hook 脚本 → 回环 HTTP hook server           │
  CLI ↔ CLI ────┤  编排子系统（SQLite 邮箱 + coordinator）        │
  CLI → Orca ────┤  orca CLI 命令（worktree ps / agent launch…） │
                 └────────────────────────────────────────────┘
```

| 层 | 方向 | 机制 | 核心代码 |
|---|---|---|---|
| 注册与启动 | Orca → CLI | 声明式注册表 + 统一启动管线 | `src/shared/tui-agent-config.ts` |
| 进程运行 | — | PTY（终端守护进程）/ 受管子进程 | `src/main/daemon/`、`src/main/provider-process/` |
| 感知 | CLI → Orca | 托管 hook → 回环 HTTP 状态服务 | `src/main/agent-hooks/server/` |
| 控制 | Orca → CLI | PTY 字节写入 / 结构化会话 JSON-RPC | `src/shared/pty-write-settlement.ts`、`src/main/acp/` |
| 协调 | CLI ↔ CLI | 编排：SQLite 邮箱 + coordinator/worker | `src/main/runtime/orchestration/` |
| 调度 | Orca 内部 | automations 定时、并发 claim、保持唤醒 | `src/main/automations/` |
| 反控 | CLI → Orca | `orca` CLI 命令面 | `src/cli/` |

---

## 1. 统一注册表与启动管线

### 1.1 注册表结构

所有支持的 agent 定义在一张声明式注册表里：`src/shared/tui-agent.ts:3` 的 `TuiAgent` 联合类型（45 种），`src/shared/tui-agent-config.ts:27` 的 `TUI_AGENT_CONFIG`。每个 CLI 一个 `TuiAgentConfig`（`src/shared/tui-agent-config-types.ts`，23 个字段），核心字段：

- **`promptInjectionMode`** 六种提示词注入模式：
  - `argv`：提示词作命令行参数追加
  - `flag-prompt` / `flag-prompt-interactive` / `flag-interactive`：启动标志
  - `hermes-query`：hermes 专有
  - `stdin-after-start`：TUI 起来后再敲入（作为 followupPrompt 由 PTY 延迟输入）
- **`argvPromptSeparator: '--'`**：grok/trae 等需要选项终止符，防止位置参数被当成 CLI 语法
- **`preflightTrust`**：7 家 CLI（claude/cursor/copilot/codex/antigravity/qoder/qoder-cn）首启的「信任此文件夹？」菜单会吃掉括号粘贴，Orca 在 spawn 时预写信任标记（`src/main/agent-workspace-trust-spawn.ts`，注释称其为「Orca 预写信任的唯一位置」）
- **`draftPasteReadySignal`** 六种字节级作曲框就绪信号：`codex-composer-prompt`、`grok-composer-prompt`、`dsh-composer-prompt`、`zcode-composer-prompt`、`render-quiet-after-bracketed-paste`、`render-cursor-after-bracketed-paste`，配 `composerReadyCaptures`（捕获的真实启动证据列表）与 `draftPasteReadyTimeoutMs` 硬超时
- **预填通道二选一**：`draftPromptFlag`（Claude 的 `--prefill`）优先于粘贴路径；无此标志的用 `draftPromptEnvVar`（如 pi 的 `ORCA_PI_PREFILL`）避开粘贴竞态
- **Windows 怪癖**：`windowsShiftEnterEncoding: 'csi-u'`（pi/omp/droid/grok）、`windowsInputRecordPasteNewline: 'alt-enter'`（codex 读控制台输入记录而非 VT 粘贴帧）、`ctrlEnterEncoding`
- **提交时序微调**：`submitRetryDelayMs`（codex 渲染作曲框先于 Enter 可用，补一次盲 Enter）、`submitLineSettleMsPerLine`（antigravity 多行粘贴展开慢，每行加时）

### 1.2 进程识别

`src/shared/agent-process-recognition.ts:41` 从注册表派生 `PROCESS_TO_AGENT` 表，外加版本化二进名的正则回退（`codex-aarch64-ap`、`qodercli-<n>`、`muse-bin-<version>`、`grok-*`）。`recognizeAgentProcessFromCommandLine` 处理 node/python 解释器入口。无头单发命令（`claude --print`、muse、zcode…）的匹配在 `src/shared/agent-headless-command.ts:18`。

### 1.3 启动排序（一次架构修复的自白）

`src/main/agent-launch/agent-launch-executor.ts:78` 的 `executeAgentLaunch` 是「agent 启动序列化的唯一地方」，服务 `agent.launch`、`worktree.create`、编排 worker、服务器 automations。头注释记录了曾有的 bug：

> create the worktree agent-first → its startup terminal IS the agent → the structured branch below it is unreachable

即「先建 worktree 里的 agent」导致其启动终端就是 agent，结构化分支永远不可达——每个新 worktree 启动都成了 PTY。修复后的顺序是**反的**：偏好结构化时，先建**无** startup agent 的 worktree → 问执行主机能否为已存在的工作区承载会话 → 能则建结构化 surface，**拒绝降级为刚建的 worktree 里的终端 agent，永不失败启动**。主机裁决无法提到创建之前：`agentSession.createSupport` 只能对它能解析的工作区回答，所以决策天然分两半。各 surface 真正不同的只是「怎么建」（编排 worker 的会话要带重驱订阅和邮箱，普通启动不能带），以工厂注入而非分支。

### 1.4 模式决策

`src/main/agent-launch/agent-launch-mode.ts`：「没有调用者传模式进来」。用户的原生聊天默认是**偏好不是要求**——不适用的启动回落 PTY，回执（receipt）写明实跑模式与降级原因（`remote_execution_host`、`reused_terminal`、`agent_without_structured_session`、`wsl_execution_runtime`、`codex_on_windows` 等）。回执名词参数化（`AgentLaunchModeVocabulary`）：编排回执说「worker」，手机创建说「chat session」，一份决策服务所有 surface。已注册结构化运行时的 agent 列表直接从 `STRUCTURED_AGENT_RUNTIME_REGISTRATIONS` 派生。

### 1.5 启动管线（渲染器 IPC → 进程）

`pty:spawn` → `src/main/ipc/pty/spawn-run.ts:41` 依序：`planPaneAgentLaunch`（经 runtime 规划 agent 面板启动）→ 预检（provider 选择、WSL 会话上下文、Codex home、Claude 认证）→ 组装环境 → 构建选项（env 删除项、OpenCode 预备、Codex no-daemon、信任预写）→ 执行 → 提交。本地落地 `src/main/providers/local-pty-spawn.ts:29`：先按 sessionId 重挂载，否则建启动计划（Windows shell 族解析含 pwsh 探测与回退链；cwd 是 WSL UNC 路径时选 `wsl.exe` + 发行版）。

启动命令不直接 spawn，而是等包装过的 shell 发出 **OSC 777 就绪标记**（`\x1b]777;orca-shell-ready`，`src/main/shell-ready-marker-scanner.ts`；shell 用 ZDOTDIR 包装/rcfile/-C/EncodedCommand 各法注入）后，以括号粘贴单次写入（`local-pty-shell-ready-startup-command.ts`）。

---

## 2. 终端守护进程与 provider 子进程监管

### 2.1 终端守护进程

`src/main/daemon/daemon-entry.ts`：独立 Node 进程，`--socket` + `--token` 文件双因子启动，经 IPC 报 `{type:'ready'}`，发布 PID 文件。**持有全部 PTY 使应用重启不掉线**（稳定 sessionId + incarnation id，`serialize`/`revive`，`attachOnly` 重挂载）。平台细节：

- Linux：每个终端跑在自己的 systemd cgroup scope（一个 OOM 不再连坐全部终端）；
- macOS：处理 TCC 登录 shell 与登录会话死亡监视（GUI 拉起的守护进程随会话死，headless serve/SSH 的不死）；打包版从签名的 terminal host helper 副本经 launchd 运行，更新不会切断隐私授权（详见 `docs/reference/macos-daemon-tcc-attribution.md`）；
- Windows：预热 ConPTY；守护进程从 `%LOCALAPPDATA%` 下的运行时副本运行（自动更新后仍存活）。

主进程经 `DaemonPtyAdapter`/`DaemonPtyRouter`（`src/main/ipc/pty/provider/registry.ts`）路由 PTY 操作到守护进程，本地直跑 `LocalPtyProvider` 回退。PTY 提供方契约 `src/main/providers/pty-provider-contract.ts:127` 的 `IPtyProvider`：`spawn/attach/write/writeWithSettlement/resize/shutdown/sendSignal/getForegroundProcess/serialize/revive/listProcesses` 等。

### 2.2 Provider 监管器（结构化子进程的生死契约）

`src/main/provider-process/provider-process-supervisor.ts:16-31`。POSIX 上 spawn 一个 **detached 的内联 Node 监管脚本**（无依赖、base64 规格经环境变量传入）：

- 以 `process.ppid !== spec.ownerPid` 判定 Orca 已死（被 reparent 到 PID 1 或 subreaper 即无主），随即杀掉 provider 进程组；
- 「Orca 可能死在脚本运行前；那时再 spawn 就会启动一个无人看管的 provider」——所以脚本**先查再 spawn**；
- 停止阶梯有精确预算：stdin 关闭宽限 `1s` → SIGTERM 宽限 `3s` → SIGKILL 收割超时 `1.5s`，输出排干最长 `1s`；`PROVIDER_SUPERVISOR_MAX_STOP_MS` 为三段之和——提前 SIGKILL 会孤儿化进程组；
- spawn 失败（Node 对 ENOEXEC 等是 throw 而非 emit error）写入带 `PROVIDER_SPAWN_FAILURE_MARKER` 标记的 stderr 行 JSON，让属主能区分「从没启动」与「启动后死了」。

### 2.3 终止与验证

agent PTY 走 `killWithDescendantSweep`（`src/main/pty-descendant-termination.ts:256`）：POSIX 先 `ps -axo pid=,ppid=,pgid=,lstart=` 快照后代（PID 复用安全：`hasUnambiguousStartTime`），SIGTERM 后代再杀根，2s 宽限后身份核对的 SIGKILL；Windows 先终止 PTY job object，回退身份门控的 `taskkill /T /F`。验证器 `src/main/pty-descendant-exit-verification.ts:115` 返回 **`'exited' | 'live' | 'unverifiable'`**——从不把读不到的进程表当死亡。

---

## 3. Hook 状态上报全链路（CLI → Orca 感知层）

### 3.1 装进 CLI 的是什么

23 家 CLI 各有 hook-service（`src/main/agent-hooks/managed-agent-hook-registry.ts` 的 `MANAGED_AGENT_HOOK_INSTALLERS`），把回调写进各 CLI 自己的配置。以 Claude 为例（`src/main/claude/claude-managed-hook-events.ts`）注册 13 个事件，每条带 why：

| 事件 | 为什么 |
|---|---|
| `SessionStart` | 恢复/空闲会话在首个提示前唯一会发的事件；没有它侧栏行要等用户输入才存在（STA-3386） |
| `UserPromptSubmit` / `Stop` | 轮次起止 |
| `StopFailure` | OpenClaude 在 API/模型错误后跳过 Stop 只发这个；缺了轮次永远转 |
| `SubagentStart/Stop`、`TeammateIdle` | 喂侧栏子行；TeammateIdle 不信任 background_tasks 的永久 running 条目 |
| `PreToolUse`/`PostToolUse`/`PostToolUseFailure`（matcher `*`） | 仪表盘的实时工具读出（名 + 输入预览） |
| `PermissionRequest` | 权限等待 |
| `PostCompact` | 手动 `/compact` 结束在空闲提示符不发 Stop，这是唯一能清面板的信号（STA-2915）。**故意不注册 PreCompact**：压缩校验前就发，中止的压缩只发它，映射成 working 会把面板搁浅（STA-4613） |

另装 **statusline 脚本**（`src/main/claude/statusline-script.ts`）：Claude 每轮把 `rate_limits` 管道给 statusLine 命令，Orca 转发获得实时用量而不花 OAuth usage 端点的紧预算，且不产生 stdout 保持终端视觉不变。

### 3.2 Hook 命令本体

`src/main/agent-hooks/installer-utils.ts:139-161`：Windows 上**故意不用 PowerShell**（每次 POST 约 300ms 启动 + 代码页转换毁 UTF-8），而是全限定路径的：

```
"%SystemRoot%\System32\curl.exe" -sS -X POST "http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/<source>"
```

全限定是为了防止仓库里的 curl.exe 劫持 hook 载荷。stdin 承载 CLI 原生 hook JSON（`hook-stdin-contract.ts`、`posix-hook-json-stdin-reader`）。端口与 token 来自 `~/.orca/agent-hooks/endpoint.env`（Windows 为 `endpoint.cmd`），字段 `ORCA_AGENT_HOOK_PORT/TOKEN/ENV/VERSION`，原子写入（`src/shared/agent-hook-listener/endpoint-publication.ts`）。

### 3.3 Hook server

`src/main/agent-hooks/server/`，类继承链分层（Lifecycle → StatusHookLifecycle → … → State）。监听 `127.0.0.1` 随机端口（`listen(0)`），每启动生成随机 UUID token；请求头 `x-orca-agent-hook-token` 不匹配 403（先认证再花功夫读不可信 body）；slowloris 防护限制请求时长；路径 `/hook/<source>` 路由来源。

### 3.4 事件归一化（23 家）

`src/shared/agent-hook-listener/providers/`（60+ 文件），每家一对 `*-events.ts` + `*-tool-fields.ts`，收敛到统一状态 **`working` / `blocked` / `waiting` / `done`**（`src/shared/agent-status-types.ts`：「状态来自 hook，绝不从终端标题推断」）。Claude 映射细节（`claude-events.ts`）展示设计深度：

- AskUserQuestion 通常在 PreToolUse 时 blocked、新版也可能报 PermissionRequest——把该 PreToolUse 映射为 `waiting`，侧栏显示琥珀色注意而非会衰退成灰的转圈；
- 子代理 roster：waiting 的主代理 stash 自己的状态等特定 `toolUseId`；别的工具事件来了恢复 stash 的 lead 状态，而非用子代理的 working 覆盖（「lead 可能已经 done，done-gate 在 roster 排干后绝不把 working 升回 done」）。

### 3.5 状态裁决与抑制

`server-status-disposition.ts`：关闭标签页触发 retired pane fence（`RETIRED_PANE_FENCES_MAX = 1024`，超限逐出最旧）；fence 记录圈住了哪些 paneKey 和别名，重挂载时**精确解除那一组**。launchToken 哈希与持久 authority commitment（`PersistedAgentHookAuthorityCommitment`）对比防身份冒用；`getAgentStatusDisposition` 可返回 `suppress` 静默事件。

### 3.6 持久化与水合

`last-status.json`（v2；v1 缺 receivedAt/stateStartedAt，不匹配按损坏水合为空），写入节流 `STATUS_PERSIST_MIN_INTERVAL_MS = 5s`，水合最长 `HYDRATE_MAX_AGE_MS = 7 天`；非终态行盖 `restoredUnconfirmed` 直到活事件确认；死终端清扫 `restored-status-dead-terminal-sweep.ts`；退出时间对账 `ended-process-reconciliation`。

### 3.7 远程/SSH 中继的不变量

`src/shared/agent-hook-relay.ts:1-22` 头注释定义 wire 契约：**「relay 归一化，Orca 路由」**——

- envelope 的 payload 已在 relay 侧过 `normalizeHookPayload`，但 Orca 的 `ingestRemote` 在 SSH 信任边界**再跑一次**规范归一化才能缓存/持久化，「relay 偏移或有 bug 的远端进程不能毒化主进程状态」；
- 线上 `connectionId` 恒为 null（那是 Orca 本地 ssh2 句柄而非 wire 身份），接收时从 mux 身份盖真值，用于断线重连后丢弃被取代连接的在途事件；
- relay 缓存重放的事件标 `isReplay`；`evidenceObservedAt` 与 `receivedAt` 分离，重连重放只重戳后者以保持单调。

### 3.8 tmux 与结构化会话的汇入

- **tmux**（`server-tmux-status.ts`）：`TmuxAgentHookOwner` 把 tmux 内层 pane 的 hook 状态聚合提交到托管 PTY 根行（`commitTmuxSelectedStatus`），清面板时保留内层主体状态。
- **结构化会话**（`server-ingest-structured.ts`）：`AgentSessionStatusSummary` 汇入同一存储；subject（sessionId+workspaceId）必须与可信属主完全匹配否则拒绝；行上 `structuredHost` 在 provider 子进程存活时为 `owned`、死后会话仍开为 `held`（永不持久化——一个运行时的 handle 对下一个运行时无意义）。

---

## 4. Orca → CLI 控制通道

### 4.1 PTY 写结算（三值逻辑）

`src/shared/pty-write-settlement.ts`——镜像执行边界 `live/unverifiable/exited` 词汇：

- `accepted`：仅证明传输接收，**从不证明 agent 消费了字节**；
- `refused`（10 种已证明拒绝）：`transport_disposed / transport_queue_full / transport_rejected_before_handoff / payload_exceeds_transport_limit / endpoint_disconnected / endpoint_awaiting_recovery / encode_failed / provider_unavailable / provider_refused_write / provider_cannot_settle`；
- `unverifiable`（5 种）：`transport_settlement_lost / settlement_timeout / endpoint_write_threw / provider_threw_after_handoff / partial_write`，**必须携带 `bytesHandedToTransport`**——持久预约需要的那个事实。

头注释点名历史事故：「把三臂中任何一个压平成 boolean，正是曾让丢失的 SSH 结算清掉持久邮箱预约、把同一指针字节写两次的原因。歧义是一个值：绝不是 rejected promise、不是裸 false、不是缺失的可选标志。」

### 4.2 ACP（Agent Client Protocol）

`src/main/acp/`，生成协议 `generated/acp-protocol.generated.ts`（schema-v1.21.0，协议版本 1）。方法面：`initialize` / `authenticate` / `session/new` / `session/load` / `session/prompt` / `session/cancel` / `session/fork` / `session/resume` + 通知 `session/update`。连接即 spawn 受管子进程、stdio 走 JSON-RPC（`acp-agent-connection.ts`：「**执行主机拥有子进程和协议生命周期；adapter 拥有轮次和 Stop**」）。

Launch spec 是数据（`acp-launch-specs.ts`：「加一个 agent 就是多一行数据加一个方言；`acp-dialects/` 外的代码不按 agent 名分支」）。当前 ACP 成员：grok、opencode、omp。方言示例（`acp-dialects/grok-dialect.ts`）：`x.ai/session_notification` 扩展通知、后台任务与子代理工具的 zod schema、模型 efforts 目录、`promptId`/`turnStartMs` 轮次元数据、失败停止原因集（error/rate_limit 才把结果文本当失败详情）。

### 4.3 统一 adapter 契约

`src/main/native-chat/agent-session-wire/structured-agent-session-adapter.ts:287` 的 `StructuredAgentSessionAdapter`，注册于 `src/main/runtime/structured-agent-runtime-registrations.ts:281`（Claude 走 Agent SDK、Codex 走 `codex app-server`、Pi 走自有 RPC、其余 ACP）。关键方法及其契约语义：

- `acquire` / `releaseAcquisition`：带 spawnToken 与 **fence 栅栏**的租约（「store 拒绝在任何其他 fence 铸造的链接」）；释放只在子进程退出**被证明**后返回 true，或抛 `AgentSessionAcquisitionRootExitObservedError`（亲见根退出但后代未证明消失）；
- `dispatch`：写前 `beforeDispatch` 复验（准备后、写给 provider 前立即重验）；
- `cancelTurn`：取消一轮而非全会话——「会话级中断会杀掉客户端从没要求停的轮次」；
- `answerPrompt`：claim 活回调 → 构建回复 → **CAS 提交 journal** → 应答；取消抢同一回调，故只有一个操作能提交；
- `stopBackgroundTasks`：批量停止，`acknowledge` 回调逐个确认，「后续批量失败也保住它」；
- `compact` / `rewind` / `recoverRewind` / `setOption` / `readOptions` / `holdsLiveProviderProcess`（续租的一手活性证明）。

会话全程记 journal（`src/main/native-chat/agent-session-journal/`：崩溃边界、游标、命令回执表、损坏检测、上下文回卷）。

---

## 5. 编排子系统（agent ↔ agent 协调核心）

代码在 `src/main/runtime/orchestration/`（下称 ORT），SQLite WAL（`busy_timeout=5000`），schema 到 v43（`ORT/db/contract-constants.ts:19`），方法经 `attach-orchestration-db-methods.ts` 挂到原型。

### 5.1 数据表

| 表 | 要点 |
|---|---|
| `runs` | `objective`、`home_database`（this_database/remote）、coordinator 句柄、`consumer_generation`（重绑即 +1 栅栏旧投递）；触发器维护 `run_coordinator_handles` 历史 |
| `messages` | 9 种类型（status/dispatch/worker_done/merge_ready/escalation/handoff/decision_gate/question/heartbeat）、优先级、线程、`to_handle` 邮箱地址、指针预约列 `pointer_enter_pending`（0/1/2/3）、`pointer_pty_id`、`pointer_process_incarnation` |
| `deliveries` | `outstanding/acknowledged/fenced`，批量 ≤50 条/邮箱，`outstanding_deliveries` 视图 |
| `tasks` | `deps` JSON；插入时 SQL 判 `ready`（全部依赖 completed）或 `pending`；creator 血统列 |
| `dispatch_contexts` | 派发尝试全记录：launchToken 哈希、能力哈希、进程化身、`retry_of_dispatch_id`、`creator_dispatch_id`（嵌套深度）、`failure_count`、`last_heartbeat_at` |
| `attempt_observation_facts` | additive 证据日志，`UNIQUE(dispatch_id, sequence)`；facet：process_turn/artifact_git/worker_report/coordinator_ack/liveness/outcome |
| `worker_terminal_resources` | 终端所有权（owned/transferred/user_owned/external/released）与释放状态机 |
| `worker_terminal_archives` | 冻结输出三形态：transcript_pin / terminal_tail / structured_journal |
| `decision_gates` | pending/resolved/timeout |
| `federation_relay_items` | `PK(dispatch_id, direction, sequence)`，方向 to_home/to_worker |

邮箱是**地址约定不是表**：裸终端句柄、`run:<id>`（coordinator）、`dispatch:<id>`（worker 尝试）、`orca_session_id:<id>`（聊天）、组（`@all/@idle/@codex/@worktree:<id>`，`ORT/groups.ts`）。

### 5.2 状态机与断路器

`ORT/db/lifecycle-transition.ts` 是唯一写边界。dispatch 合法转换 `pending→dispatched→completed|failed|circuit_broken`，终态只有自环；worker 图 `starting/start_unknown→ready/failed/stopping`、`ready→succeeded/failed/stopping/abandoned`。写法 `UPDATE … WHERE state IN (expected)` 且必须恰好改 1 行。**断路器 3 次熔断**（`dispatch-circuit-breaker.ts`），重试的 `failure_count` 取 MAX 继承。唯一逃生舱 `correction: 'unobserved_prompt_report'`：被误判「提示停滞」的派发可由 worker 自己的报告补完成（#16095）。

### 5.3 Coordinator 循环

`ORT/coordinator.ts`。关键事实：

- **分解未实现**——`decompose()` 在无任务时 throw，任务须由 `orchestration.taskCreate` 预建（「AI 驱动分解是未来阶段」）；
- **自动 Coordinator 已退役**：`orchestration.run` RPC（`src/main/runtime/rpc/methods/orchestration/gates/gates.ts:24-64`）是唯一 `new Coordinator` 遗址；CLI `coordinator-start/-stop` 现抛 `orchestration_migration_required: command_retired`；
- **现行模型：agent CLI 自己当 coordinator**，用编排技能动词跑循环。

tick 顺序（默认 2s）：处理消息 → 处理升级 → 重阻塞门控任务 → 警告陈旧派发（阈值 10 分钟 = 2× 心跳周期，**只警告绝不自动失败**；心跳只写 `status='dispatched'` 行，完成后迟到心跳不能掩盖挂起重试）→ 派发就绪任务（并发上限默认 4，**每 tick 至多建 1 个终端**，worktree 漂移快照全 tick 共享一次）→ 收敛检查（全 completed/failed 即 `all-done`；只剩 blocked 报卡住警告）。决策门**永不自动解析**——人类经 `orchestration.gateResolve`。`merging` 阶段在类型里声明但无代码赋值（残余）。worker 终端选择（`coordinator-task-dispatch.ts:31-62`）排除 coordinator 句柄、忙的受派者、断连/不可写终端；census 失败返回 null 且**永不授权建终端**。

派发细节（`dispatchTaskToWorker`，:64-168）：解析 spec 里的 `allow-stale-base`（剥离后 worker 不可见）；漂移超阈值时静默拒绝（`stale-base-refused`，任务留 `ready`，不烧失败计数）；建 dispatch context（creator `{kind:'system'}` 是构造上的根，`maxDepth` 防无限嵌套）；构建**派发前导词**（`ORT/preamble.ts:70+`：教 worker `orca orchestration send/check/ask/reply` 动词、5 分钟心跳、带 taskId+dispatchId 的 exactly-once worker_done）；追加最新门结果；经 `sendAgentTurn` 送出。Enter 已写但提交停滞时记 `'dispatched-unobserved'` 而非失败。

### 5.4 邮箱生命周期（八步）

1. **插入**（`db/messages/message-insert.ts:28-68`）：无 Run 的发送者归入自动建的 `UNBOUND_RUN_ID`；
2. **属主解析**（`mailbox-owner.ts:41-93`）：活终端叶 → 当前 Run → 活派发 → 远端附件 → 裸句柄；直接（句柄寻址）邮件读时改道进 `run:`/`dispatch:` 邮箱；`mailbox-delivery-target.ts` 反向解析（结构化会话返回 null 走自己的车道，活性未证明的 PTY 延迟投递）；
3. **指针登台**（`mailbox-pointer-stage.ts`）：「指针」= 敲进 agent PTY 的一行字——`formatMessagePointer`（`formatter.ts:112-122`）：`You have N orchestration messages. Run 'orca orchestration check [--run <id>]'.`。预约列 RESERVED(1) → WRITE_ATTEMPTED(2) → ENTER_ATTEMPTED(3)，戳 `ptyId+processIncarnation`；写指针经 `writeOrchestrationPointerWithSettlement`（每个字节都结算；抛错的控制器是 `unverifiable` 绝非 `refused`）；空闲观测延迟后补 `\r`。提交守护：化身精确匹配、同邮箱、可写、agent `idle|working`、中性标题推迟 Enter 到空闲；
4. **结算**：`settleMailboxPointerEnter` 盖 `delivered_at` 清预约；`releaseMailboxPointerEnter` 回滚为未投递，未来航班重投；
5. **重启恢复**（`mailbox-pointer-resume.ts`）：同 PTY 同化身 RESERVED 重试；WRITE/ENTER 过的**保守结算**（「同化身恢复无法证明 Enter 没落地」）；外目标的释放；
6. **批量拉取**（`role-mailbox-delivery.ts:27-109`）：`BEGIN IMMEDIATE` 内建 outstanding Delivery（≤50 条/批），**事务内**重验 `consumer_generation`（`mailbox-consumer.ts:15-45`）；
7. **确认**（:111-174）：整批 `read=1`、Delivery `acknowledged`；用消息 id 而非 delivery id 确认是类型化 `stale_delivery` 错误。**已投递 ≠ 已读**；
8. **栅栏**：派发重指向新 pane/进程（`worker-dispatch-authority.ts:59-80`）或 Run 重绑（`runs/run-binding.ts:157-167`）时 `consumer_generation` +1 **并**把 outstanding 翻 `fenced`——v36 前两个消费者共享 generation 0，被替换的旧 worker 与新 worker 能互相 ack 对方的信（测试文档记录）。

通知协调（`mailbox-notification-coordinator.ts`）：先试结构化车道再试 PTY 指针；`check --wait` 的等待者**完全抢占**指针投递（过滤型等待者把自己的类型从指针批次排除——推送永远不偷检查者正要读的信）；`MailPointerRepointScheduler` 2 秒后重试句柄。

### 5.5 Worker 侧

- **收信**：PTY worker 读指针行跑 `orca orchestration check --wait/--peek/--all/--types/--ack`（`src/cli/handlers/orchestration/message-check-handler.ts:31-92`，等待期 keepalive）；结构化 worker 由 `OrchestrationStructuredMailboxPointerDelivery`（`structured-mailbox-pointer-delivery.ts`）把同一句指针文本作为**用户轮次**经会话自身 send 通道送入（`expectedRuntimeFence` + 持久 `operationId` 防重投，拒绝/未结算停泊到 journal 边缘）；
- **报告**：`orchestration send --type worker_done|heartbeat` 带 `{taskId, dispatchId, outcome, filesModified, reportPath}`。准入（`worker-report-admission.ts`）：只有 stop-in-flight 静默；`start_unknown/stop_unknown` 是「未证明非退出」故 **worker 自报优先于主机进程判定**。结算（`worker-report-settlement.ts`）校验任务/派发配对、去重、unobserved-prompt 纠正、重连/报告期窗口，原子结算 task+dispatch 并写 `worker_report` 事实；`reconcileLifecycleMessage`（`lifecycle-reconciliation.ts:103-306`）以 pane-key 匹配强制 sender-is-assignee，被拒的生命周期消息转成带 `_orcaLifecycleRejection` 标记的高优 status 行，完成时抑制同派发更早的心跳；
- **转录**（`worker-transcript-read.ts:35-117`）：读 provider 会话文件（Claude/Codex 等，WSL 发行版感知），源指纹 + 边界检查点游标；载荷上限（≤50 消息、每消息 ≤6 块、每块 ≤1200 字符、线 512KB、元数据脱敏）；
- **归档**（`worker-output-archive.ts:85+`）：冻结证据于 PTY 关闭前——结构化 journal / `transcript_pin`（provider 会话可达）/ 有界脱敏 `terminal_tail`（262,144 字符）；什么都保不住抛类型化 `archive_failed`，释放保留活终端。游标是 `owr1_` base64url 令牌绑定 `{dispatchId, source, sourceIdentity, position, checkpoint}`；
- **终端生命周期**（`worker-terminal-release.ts:15-97`）：worker 已结算（succeeded/failed）才可释放；stopped/abandoned 保留（身份未证明）；`worker-list` 状态（active/reclaimable/retained/release_pending/release_unknown/released）是进程会计，**故意独立于任务结果**。

### 5.6 Federation（本地 ↔ 远程 Orca 服务器）

- **中继**（`db/federation/federation-relay-enqueue.ts`）：单条 64KiB 上限；未确认心跳**原地折叠**为最新行；相同未确认 worker_done 去重；配额检查；
- **同步**（`federation-sync.ts:40-200`）：Run 家拉页（50 条 × 最多 6 页），要求**序列连续**；校验 peer 指纹稳定性（变了 `peer_changed`）；导入为 `from: dispatch:<id>` → `run:<run_id>` 的消息；对等方支持时回送 run-home 结算；
- **ack 双水位**（`federation-ack-checkpoints.ts`）：内存租约（按环境+peer+runtimeEpoch）+ 持久 `to_home_acknowledged_sequence`；远端 epoch 变更重置内存水位为 0；旧对等方有 `lifecycleAcknowledgmentBarrier` 门；
- **能力协商**（`federation-sync-capability.ts`）：低于协议版本得 null；否则缓存探测运行时能力位并钉到远端 runtimeEpoch；
- **不同步的**：任务分解、决策门解析、worker 终端资源——留在本地。只有消息、生命周期结算、问题线程、观察事实流动。

### 5.7 一次 Run 的端到端时序（现行模型）

```
coordinator: task-create --deps        任务就绪判定（SQL：全依赖 completed → ready）
           → worker-start --task … --agent claude [--on <env>]
             createDispatchContext     task ready→dispatched；pane/incarnation 权威；深度戳
             前导词轮次进 worker        （PTY 写或结构化 send）
worker:    干活 → heartbeat（5 分钟）→ worker_done {taskId, dispatchId, outcome}
           消息进 run:<id> 邮箱
Orca:      指针/轻推送达 coordinator   （PTY 一行字或结构化用户轮次）
coordinator: check --wait 收批 → reconcileLifecycleMessage 原子结算 → --ack
           → worker-release 归档（transcript_pin/terminal_tail/structured_journal）关终端
           → DAG 收敛 → Run 完成
```

---

## 6. 定时与并发调度

### 6.1 AutomationService

`src/main/automations/service.ts:40-141`：60 秒 tick 调 `evaluateDueRuns()`；启动时对账保留 run（`reconcileRetainedRuns`）并报日程漂移（`reportAutomationScheduleDrift`）；headless serve 无渲染器 ready IPC，`start()` 里直接补一次赶趟评估；派发代数（`dispatchGeneration`）防停止后迟到写；预检失败的定时 run 记 `skipped_precheck` 而非 failure；外部探针流量经 `externalProbePriority` 租约排队；headless host 上 `releaseFinishedRunTerminals` 即时关闭完成未用的 run 终端。

### 6.2 无头派发

`headless-dispatch-runner.ts`：定时触发且有 precheck 时先跑预检，不过则记跳过；`AutomationDispatchRefusedError` 表示「该启动但不启动」，记 skip 不记失败。headless agent 启动在 `headless-automation-agent-launch.ts`。

### 6.3 日程解析

`src/shared/automation-schedules.ts` + `automation-schedule-occurrences.ts`：cron + RRULE 双语法；cron 下一次出现用 **9 年扫描窗口**（注释：2 月 29 日的 cron 在非闰世纪间可有 8 年空档）；描述符 locale 无关（渲染器本地化、CLI 恒英文）；外部 cron 管理器经 `external-manager*.ts` 对接（job id 映射、属主守卫、探测调度器）。

### 6.4 Worktree 并发

`worktree-create-preparation-claim-registry.ts`：预备检出按 canonical key（repo+workspaceRoot+canonicalBase+wslDistro）认领；每 key 挂起一个请求，**显式预取优先于自动**。`worktree-create-concurrency.ts`：进程内并发计数器，记录「这次 create 旁边最多几个别的 create / 预备工作在跑」——为慢 create 的归因提供竞争证据（遥测用）。

### 6.5 其余

- **AgentAwakeService**（`agent-awake-service.ts`）：`powerSaveBlocker` + macOS/Linux 平台睡眠断言，状态租约、resume 事件重发布；
- **in-flight-run-dedupe**（`in-flight-run-dedupe.ts`）：同 key 并发折叠共享一个进行中 Promise，结束即删（「纯并发折叠，绝非缓存」；失败也清，否则一次失败楔死后续所有调用者）；
- **hang-watchdog**（`src/main/hang-watchdog/`）：主线程卡死检测循环 + worker 协议；
- **orcad**：无头/serve 守护形态，编排与 automations 无桌面也能跑。

---

## 7. `orca` CLI —— agent 反向控制面

命令族（`src/cli/specs/`）：`worktree`（create/ps/set/listing）、`agent launch`、`terminal`（send/close/daemon/list/read-screen）、`orchestration`、`automations`、`browser`（basic/advanced）、`computer`、`environment`、`vm`、`search`、`repo`、`project`、`jira`/`linear`/`linear-mcp`、`skills`、`serve`、`account`、`file`、`artifacts`、`introspection`、`diagnostics`、`emulator`、`profile-state`、`reference`、`managed-server`。

编排子命令（`specs/orchestration.ts`）：

| 命令 | 语义要点 |
|---|---|
| `run-create --objective` | 「Run 是命名空间和主收件箱，它**从不**调度或放置 worker」；自动解绑该 coordinator 的其他 Run |
| `run-use --takeover-legacy` | 必须在它绑定的活 coordinator 终端里跑；保留既有 worker 指派 |
| `send` | flags：`--to/--run/--from/--subject/--body/--type/--priority/--thread-id/--payload/--task-id/--dispatch-id/--outcome/--files-modified/--report-path/--phase/--retry-request`；`worker_done`/`heartbeat` 是精确 Dispatch 信号**不能发组地址**；`worker_done` 必须带 `--outcome succeeded|failed` |
| `check` | `--wait/--peek/--all/--types/--ack`；等待期 keepalive |
| `task-create --deps` | 依赖 JSON（PowerShell argv 剥离恢复） |
| `worker-start` | `--task … --agent <cli> --model … --on <environment>` |
| `ask` / `reply` | 问题线程 |
| `gate-create` / `gate-resolve` | 决策门（人解析） |
| `worker-list/read/stop/release` | worker 观察与生命周期 |
| `dispatch` / `reset` | 手动派发 / 重置 |

**组寻址**：`@all`、`@idle`、`@codex`（按 agent 族）、`@worktree:<id>`（一个工作区）；组达**自己 Run 的活 Dispatch**；Run 组排除自己的 coordinator（「要跟自己的协调者说话请发 `run:<id>`」）；嵌套 coordinator 在子 Run 邮箱收组信。所有变更带 `--retry-request` 幂等回执（`mutation_receipts` 表）。CLI 按 pane 解析可执行名（`ORT/cli-command.ts`）：`orca` / `orca-dev` / `orca-ide`（打包 WSL）。Windows 注意：PowerShell 下组地址要引号（`--to "@all"`）。

---

## 8. 贯穿全部子系统的三条设计主线

1. **证据分级是一等公民**。PTY 写结算三值、进程判词 `live/unverifiable/exited`、监管器区分「没启动/启动后死」、hook 中继在信任边界重归一化、worker 报告优先于未证明的进程状态、hook 超时 withheld exit code 读作 `unverifiable`——所有不可判定都显式建模，绝无布尔压平。这正是 SSH 用例的要求（「失联绝不是进程死亡的证据」）。
2. **持久状态的预约-结算-栅栏模式**。邮箱指针预约列（0/1/2/3）、结构化会话 fence、delivery fencing、`mutation_receipts` 幂等、`structured_pointer_operations` 持久操作 id——每次写入都问「如果我在这一步崩溃，恢复时怎么知道这步做没做到」，答案编码在状态编号与两阶段结算里；恢复策略对「无法证明」的默认是保守结算而非乐观重放。
3. **单一通道复用**。agent 间消息走用户消息的同一管道（`send-agent-turn.ts`：「Orca 代表一个 agent 向另一个 agent 发消息的唯一途径」，复用 composer 的 envelope builder 与结算等待器）；编排 worker 与普通启动共用 `executeAgentLaunch` 与模式决策；结构化状态与 hook 状态汇入同一存储——没有为「机器对机器」另修旁路，所以用户能看到的一切行为，协调者也以完全相同的方式经历，反之亦然。

---

## 9. 落到 AhaStation：建什么、不建什么

### 9.0 结论

Orca 的可靠性保证并不来自「消息表 + 指针」这些概念，而来自它背后的前提：多进程、SQLite 事务、多客户端、多执行宿主。AhaStation 是单 main、一场会议 4–8 个 agent、宿主强制交付；照搬运行时会得到复杂度，但拿不到同等保证。

因此建议的目标是：**移植 Orca 的通信可靠性语义，保留 AhaStation 的宿主治理**。

- 保留：`Orchestrator` 的计划审批、`DeliveryHarness` 的冻结/审查/集成、会议最终验收。
- 移植：统一 profile、写结算、hook 状态回流、dispatch 身份、邮箱 ack/栅栏、durable 回执、终端 daemon。
- 不建：federation、automations、多客户端 wire 兼容、45 家启动目录、Orca 的 SQLite schema。

### 9.1 七层映射

| Orca 层 | AhaStation 现状 | 决策 |
|---|---|---|
| 注册表 / 启动管线 | `electron/backends/registry.ts` + `electron/backends/terminal-cli-adapter.ts`；四家名单在 `registry.ts` 与 `src/lib/terminal-backends.ts` 重复 | **建简化版**：一份 `TerminalCliProfile`，先覆盖现有四家 |
| 终端守护进程 | `electron/terminal-daemon/` 只有 D1 原型；生产 PTY 仍在 `electron/pty-host.ts` | **P4 收尾**，不阻塞协作闭环 |
| Hook 状态回流 | 每会话 Stop hook 写 JSONL 文件，adapter 尾部读取 | **P2 换成回环 HTTP + 统一状态**，四家起步 |
| 宿主 → CLI 控制 / 写结算 | `terminal-cli-adapter.ts:296` 的 `readyPattern` + `:489` 固定超时 fallback；无写结算 | **P1，最高优先级** |
| 编排内核 | `worker-scheduler.ts`、`task-mailbox.ts`、`meeting-repository.ts`、`delivery-harness.ts` 四个状态持有者 | **P3**，先收敛写边界 |
| automations / federation | 无 | **不建**，等真有定时/远程需求 |
| CLI 反控面 | `electron/worker-cli.ts` 只有 `report/ask/inbox` | **扩展**，不做全量 `aha` CLI |

### 9.2 现状差距

| 能力 | Orca | AhaStation 现状 | 差距 |
|---|---|---|---|
| Agent 目录 | 45 启动 / 23 hook / ~6 结构化 | 4 terminal + 4 SDK | 小，别扩 |
| 启动就绪 | OSC 777 shell ready + 六种 composer 信号 + 证据 | `readyPattern` + 固定超时 fallback | 大（P1） |
| 写结算 | `accepted / refused(10) / unverifiable(5)` | 无 | 大（P1） |
| Hook 状态 | 23 家 → `working/blocked/waiting/done` | 每会话一个 Stop hook 文件 | 大（P2） |
| 派发身份 | `dispatch_contexts` + launchToken + 进程化身 + fence | 无独立 dispatch 记录 | 大（P3） |
| 邮箱 | 9 类型 + delivery + ack + consumer_generation | `TaskMessage` 有 delivered/acknowledged，无栅栏 | 中（P3） |
| 报告 | operationId + payload hash + 观察事实 | attempt 级过期/重复拒绝，无 durable 回执 | 中（P3） |
| 恢复 | SQLite + journal + terminal archive | JSONL journal + delivery interrupted | 中（P3/P4） |
| 终端存活 | 独立 daemon + 屏幕快照 + reattach | D1 原型 | 中（P4） |
| 反控 | 全套 `orca` CLI | `aha-worker` 三命令 | 中（P4） |

### 9.3 目标架构

关键是**单一权威**。AhaStation 现在至少有四个状态持有者；再叠一套 Orca 式邮箱会出现两套真相。

```text
Renderer（会议 UI / 终端工作区 / 审批卡）
   │ IPC
Main process
   ├─ AgentProfileRegistry        一份 profile，替代重复的四家名单
   ├─ TaskAuthority               ← 唯一写边界（journal + 内存投影）
   │    ├─ Task / Attempt / Dispatch（新增 Dispatch 身份）
   │    ├─ Mailbox（消息、投递、ack、consumer_generation 栅栏）
   │    └─ WorkReportReceipt（operationId + payload hash）
   ├─ Orchestrator                保留宿主治理：计划→审查→验收
   ├─ DeliveryHarness             保留现有交付流水线
   ├─ HookStatusIngest            只做观测，不参与任务裁决
   └─ PTY Client ── daemon（PTY + headless 屏幕快照）
Worker CLI ── aha-worker（status/progress/ask/inbox/report）── loopback
```

三条原则：

1. **编排状态归 `TaskAuthority`**，`Orchestrator` 只读/命令它；不要让 `WorkerScheduler` 的 Map 继续做真相。
2. **agent 间消息复用用户消息的同一发送路径**（§8.3）。`aha-worker` 只承担报告/问答等结构化出口，派发和追问仍走正常 prompt，避免两套通道行为分叉。
3. **状态分级**：hook 状态只回答「agent 在不在干活」，任务完成仍以 WorkReport + 人工验收为准。

### 9.4 最小协议

写代码前先定死以下语义，可直接沿用 Orca 词汇：

| 项 | 规则 |
|---|---|
| 身份 | `meetingId + taskId + attempt + workerId + dispatchId + terminalIncarnation + token`；服务端从 token 反查，不信命令行自报 |
| 消息类型 | 先 8 种：`dispatch / heartbeat / progress / question / reply / worker_done / status / escalation` |
| 投递状态 | `queued → delivered → acknowledged`，另有 `fenced / failed`；**已投递 ≠ 已读** |
| 写结算 | `accepted`（只证明传输接收）/ `refused(原因)` / `unverifiable(带 bytesHandedToTransport)`；禁止压成 boolean |
| 报告回执 | `operationId + payload hash`：同 ID 同内容返回原回执，同 ID 不同内容拒绝；落盘成功才算提交 |
| 派发状态机 | `pending → sent → observed → running → completed/failed/cancelled`；`sent_unobserved` 单独一档；N 次失败熔断 |
| 恢复 | 启动时在途一律 `interrupted`，要求用户显式恢复；`unverifiable` 绝不自动重发 |
| 栅栏 | worker 重绑/终端重挂时 `consumer_generation + 1`，旧 outstanding 全部 `fenced`，旧 ack 拒绝 |

AhaStation 目前只具备「attempt 级过期拒绝」与「重复报告忽略」，其余都要补。

### 9.5 分期

| 阶段 | 交付 | 验收（真实 CLI） |
|---|---|---|
| **P1 可靠投递** | 统一 profile；写结算三值；ready/blocked/unknown；投递回执 | 两家真实 CLI；粘贴失败不丢 prompt、不重复发送；回执能区分「没送达 / 送没送到」 |
| **P2 统一感知** | 回环 hook server + 状态存储；Claude/Codex/Kimi/Qoder 四家 | 会议磁贴状态来自 hook 而非标题推断；死终端清扫；状态只作展示 |
| **P3 编排内核** | `TaskAuthority`、Dispatch、邮箱 ack/fence、重试熔断、恢复；`aha-worker` 扩展 | 一方提问另一方继续；main 重启后不重发；旧 attempt 的 ack 被拒；报告恰好一次 |
| **P4 存活与反控** | daemon 接生产、attach/reattach、归档；受限 `aha` CLI | 强杀 main 后 CLI 存活；重接同一进程；关闭终端才清进程树 |

粗估：P1+P2 约 4–6 人周，P3 约 4–6 人周，P4 约 4–6 人周，不含真实模型验收；一个人做按 2–3 倍算。

### 9.6 明确不做

1. **不要学 Orca 让 agent CLI 当 coordinator。** 那是通用 IDE 的选择；AhaStation 的产品承诺是「审查必须走完、验收才发布」，协调权必须留在宿主。
2. **不要保留第二套任务状态。** 先把 `Orchestrator / WorkerScheduler / TaskMailbox / MeetingRepository` 收敛到一个写边界，再加邮箱。
3. **不要过早引入 SQLite。** 单 main 单写者，JSONL + 内存投影 + 原子快照足够；等 daemon 真的开始写任务状态，再评估 `node:sqlite`。Orca 的 v43 schema 是为它自己的历史包袱服务的。
4. **不要复制 `runtime/orchestration/` 的代码。** 它和 Orca 的 Run/host/caller/SQLite 深度耦合；可移植的是语义，不是实现。见 §11。
5. **不要假设所有 CLI 都有 hook。** 23/45 的覆盖率意味着 Qoder 这类无 hook 的 CLI 必须保留人工确认兜底，产品文案不能承诺统一可观测。

---

## 10. 不变量清单（测试种子）

以下断言可直接转成单元/集成测试。编号供后续 RFC 引用。

### A. 身份与权限

- A1 每个 worker 请求必须能反查 `(meetingId, taskId, attempt, dispatchId, workerId, terminalIncarnation)`；仅凭 `workerId` 的请求一律拒绝。
- A2 sender-is-assignee：生命周期消息的 sender 必须等于当前 dispatch 的 assignee，否则拒绝并转成高优 status。
- A3 旧 attempt、跨 task、过期 dispatch 的报告/ack 必须拒绝，并返回可诊断错误码。

### B. 投递

- B1 写结算永不压成 boolean；`unverifiable` 必须携带 `bytesHandedToTransport`。
- B2 已投递 ≠ 已读；ack 必须显式。
- B3 同 `operationId` + 同 payload 返回原回执；同 ID 不同 payload 拒绝。
- B4 worker 重绑时 `consumer_generation + 1`，旧 outstanding 全部 fenced；旧 ack 返回 `stale_delivery`。
- B5 恢复时已尝试 WRITE/ENTER 的指针保守结算（无法证明 Enter 未落地），不得乐观重放。

### C. 状态机

- C1 dispatch 状态只能经唯一写边界，比较并交换必须命中恰好一行。
- C2 终态只能自环；`completed` 不可回退到 `running`。
- C3 迟到心跳不能把已完成的 dispatch 改回 `running`。
- C4 连续失败 N 次熔断；retry 的 `failure_count` 继承 MAX。
- C5 陈旧派发只警告，不自动失败；只有用户/协调者显式动作才终止。

### D. 完成与交付

- D1 hook 的 `done`、CPU 降低、终端安静都不能单独证明任务完成。
- D2 代码任务不得走 report-only；报告文件清单必须与 worktree 变更一致。
- D3 审查覆盖率未走完不得进入集成；停滞交回用户，不自动判过。
- D4 最终发布必须经过会议验收。

### E. 进程与终端

- E1 进程判词只有 `live / unverifiable / exited`；失联不是死亡证据。
- E2 终止后必须验证后代退出；无法验证时返回 `unverifiable`，不声称已清理。
- E3 终端释放只在该 worker 的 dispatch 已结算后进行；身份未证明时保留。

### F. 恢复

- F1 启动时任何非终态 dispatch → `interrupted`，需用户显式恢复。
- F2 恢复不重复发任务；同一 `operationId` 只接收一次。
- F3 journal 损坏时按已确认前缀恢复，不猜测中间状态。

---

## 11. 许可与可移植边界

Orca 采用 MIT 许可。直接复制其实现时必须在文件头保留原始版权与许可声明，并在本仓库记录来源路径与对照 commit；仅重写语义时在文档中注明出处即可。

### 可移植（自包含，改造成本低）

- `src/shared/pty-write-settlement.ts`：三值写结算类型与构造器。
- `src/shared/agent-status-types.ts`：`working/blocked/waiting/done` 词汇。
- `src/shared/agent-hook-listener/endpoint-publication.ts`：endpoint 原子发布。
- `src/main/agent-hooks/installer-utils.ts`：Windows 全限定 `curl.exe`、stdin 载荷等模式。
- `src/main/pty-descendant-termination.ts` + `pty-descendant-exit-verification.ts`：后代清扫与退出验证（需适配 AhaStation 的进程表工具）。

### 只能重写语义（与 Orca 运行时耦合）

- `src/main/runtime/orchestration/**`：与 Run / host / caller / SQLite 深度绑定。
- `src/main/daemon/**`：与 Orca 的 `IPtyProvider` 契约绑定；AhaStation 已有自己的 D1 daemon。
- `src/main/native-chat/**`：结构化会话 wire；AhaStation 走自己的 SDK adapter。
- `src/main/acp/**`：除非确定要接 ACP，否则不引入。

### 不复制

45 家启动目录、各家 Windows 输入怪癖、federation、automations、mobile relay、Orca 的 schema 迁移历史。

---

## 12. 后续修订建议

- **补 wire/state spec**：本文是机制地图，不是协议规范。落地前需要单独一页定义消息 schema、状态机、失败矩阵与错误码。
- **区分能力等级**：在 agent 表格中标注「仅启动 / 有 hook / 有结构化会话」，避免把 45 家理解为同等可观测。
- **记录保证的前提**：Orca 的 exactly-once、栅栏、恢复依赖 SQLite 事务与多进程边界。AhaStation 若保持 JSONL + 单 main，必须在文档中写明哪些保证是弱化版，不能直接引用 Orca 的结论。
- **补 UI 消费面**：报告未覆盖 renderer 如何消费状态；AhaStation 需要定义会议磁贴、任务面板、审批卡各自的权威字段。
- **固定版本**：引用本文时使用文首的 Orca commit，不要用 `main`。

---

## 附录：关键文件索引

| 主题 | 文件 |
|---|---|
| Agent 注册表 | `src/shared/tui-agent.ts`、`src/shared/tui-agent-config.ts`、`src/shared/tui-agent-config-types.ts` |
| 启动计划 | `src/shared/tui-agent-startup.ts`、`src/shared/tui-agent-launch-command.ts`、`src/shared/tui-agent-resume-startup.ts` |
| 启动执行 | `src/main/agent-launch/agent-launch-executor.ts`、`agent-launch-mode.ts`、`agent-launch-surface-factories.ts` |
| 进程识别 | `src/shared/agent-process-recognition.ts`、`src/shared/agent-headless-command.ts` |
| PTY 契约 | `src/main/providers/pty-provider-contract.ts`、`src/main/ipc/pty/provider/registry.ts` |
| 终端守护进程 | `src/main/daemon/daemon-entry.ts`、`daemon-pty-adapter.ts`、`daemon/pty-subprocess/` |
| 子进程监管 | `src/main/provider-process/provider-process-supervisor.ts`、`managed-provider-process.ts` |
| 终止验证 | `src/main/pty-descendant-termination.ts`、`pty-descendant-exit-verification.ts` |
| Hook 安装 | `src/main/agent-hooks/managed-agent-hook-registry.ts`、`installer-utils.ts`、`src/main/claude/claude-managed-hook-events.ts` |
| Hook server | `src/main/agent-hooks/server/`（server-lifecycle.ts、server-status-disposition.ts、server-ingest-*.ts、server-hydration.ts） |
| 端点发布 | `src/shared/agent-hook-listener/endpoint-publication.ts` |
| 事件归一化 | `src/shared/agent-hook-listener/providers/`、`listener-event.ts` |
| 状态类型 | `src/shared/agent-status-types.ts` |
| 远程中继 | `src/shared/agent-hook-relay.ts`、`src/wsl-guest/agent-hook-server.ts` |
| 写结算 | `src/shared/pty-write-settlement.ts` |
| ACP | `src/main/acp/`（acp-agent-connection.ts、acp-launch-specs.ts、acp-dialects/、generated/acp-protocol.generated.ts） |
| 统一 adapter | `src/main/native-chat/agent-session-wire/structured-agent-session-adapter.ts` |
| 结构化注册 | `src/main/runtime/structured-agent-runtime-registrations.ts` |
| 会话 journal | `src/main/native-chat/agent-session-journal/` |
| 编排核心 | `src/main/runtime/orchestration/`（coordinator.ts、types.ts、db/、mailbox-*.ts、send-agent-turn.ts、preamble.ts、federation-*.ts、worker-*.ts） |
| 编排 CLI | `src/cli/specs/orchestration.ts`、`src/cli/handlers/orchestration/` |
| Automations | `src/main/automations/service.ts`、`headless-dispatch-runner.ts`、`src/shared/automation-schedules.ts` |
| Worktree 并发 | `src/main/worktree-create-preparation-claim-registry.ts`、`worktree-create-concurrency.ts` |
| 保持唤醒 | `src/main/agent-awake-service.ts` |
| 并发折叠 | `src/main/in-flight-run-dedupe.ts` |
