# AhaStation 性能审计报告（只读扫描）

- 日期：2026-10-18
- 范围：`src/`（渲染层，约 2.9 万行）、`electron/`（主进程，约 4.9 万行）、`vite.config.ts`、`package.json`
- 方式：静态代码走查 + 调用频率推理（**未运行应用、未做运行时 profiling**，结论为静态判断，附行号可复核）
- 约束：只读，未修改任何源码

---

## 一、扫描范围与重点

按"事件从产生到落地"的完整链路切分，重点看六类开销：

| 维度 | 具体关注点 |
|------|-----------|
| 热点路径 | 语音主链路（ASR 帧 → SDK 流式增量 → TTS）、worker 事件分发、终端 PTY 输出、观察层轮询 |
| 高频调用 | 每个 stream delta 触发的落盘/序列化、每帧 IPC、每 tick 子进程 |
| I/O 与网络 | journal fsync 频率、快照全量写、目录列举 syscall、transcript 尾部读取、`ps`/`lsof` 子进程 |
| 内存分配 | 每帧 `Float32Array` 拷贝、`Buffer.concat`、`structuredClone`、无界数组 |
| 数据库与算法复杂度 | JSONL replay、O(n²) 文件重读、O(slots×tasks) 缓存失效重算 |
| 不必要的重复计算 | 同一 payload 两次序列化、缓存过早失效、空窗口仍构建状态、运行时重建正则 |

**主链路（最热的一条）**：

```
SDK stream_event
  → claude-session.ts:249        emit({kind:'message'})
  → host-group.ts:397            taggedEmit
  → orchestrator.ts:1093         onHostGroupEvent
  → orchestrator.ts:1178         safeEmit
  → meeting-repository.ts:239    assertBoundedJson + stringify + open/write/fsync/close
  → orchestrator.ts:1195         append.then(() => this.emit(e))   ← 渲染层被 fsync 阻塞
  → main.ts:309                  webContents.send
  → meeting-store.ts:2201        handleTalkerStreamEvent → TTS enqueue
```

---

## 二、结论摘要

最严重的问题集中在**主进程的事件持久化层**：每一条渲染层可见事件（包括每一帧流式文本增量）都要先做一次带 `fsync` 的磁盘追加，渲染层才收得到。这条路径同时踩中"高频 + 阻塞 + 串行队列"三个放大器，直接作用于用户最敏感的语音延迟。

其次是**快照全量序列化**（每次 worker 事件一次）和**终端 PTY 无合并转发**（TUI 重绘时每秒数十条 base64 IPC）。

渲染层整体工程质量较高（细粒度 selector、memo、重型库懒加载、列表上限），问题主要是 App 整树订阅与长列表无虚拟化，属中等。

---

## 三、问题清单（按严重程度排序）

### P0-1　每条事件（含每帧流式增量）都做 fsync，且渲染层要等它完成

- **位置**
  - `electron/orchestrator.ts:1178-1206`（`safeEmit`）
  - `electron/meeting-repository.ts:239-272`（`append`：`fs.open` → `writeFile` → **`handle.sync()`** → `close`）
  - `electron/host-group.ts:326`（`includePartialMessages: true`）
  - `electron/claude-session.ts:249`（所有 SDK 消息统一 emit，无 kind 过滤）
- **影响程度：高**
  - 一次 400 字回复按 delta 粒度通常 150~500 帧 → **150~500 次 open/write/fsync/close**。
  - 关键点：`orchestrator.ts:1195` 是 `void append.then(() => { this.emit(e); ... })` —— **渲染层收到 delta 的前提是这次 fsync 已完成**。于是 TTS 断句流式播报被逐帧串行化，首字延迟被叠加。
  - `append` 共用一条 `this.tail` 串行队列，吞吐上限 ≈ 1/fsync 延迟。多 worker 同时推进或出现事件突发时队列会积压，表现为"语音/字幕整体滞后一拍"。
  - 磁盘写放大：日志体积 ≈ 事件数 × 单条体积，且流式帧也入日志。
- **判断依据**
  - `includePartialMessages: true` **只在 host（talker）** 打开（`host-group.ts:326`），worker 会话未开（`worker-scheduler.ts:4491` 的 `sessionOptions` 无该字段）→ 受影响的是语音主链路，正是最在意延迟的路径。
  - `safeEmit` 里没有任何 `e.event.kind` 白名单，`event:message` 与 `event:worker-event` 一视同仁。
  - `handle.sync()` 是显式 fsync，不是普通 `write`。

---

### P0-2　worker 事件触发整会快照全量序列化 + 原子写

- **位置**
  - `electron/orchestrator.ts:1186-1192`（`shouldSnapshot` 白名单含 `worker-event` / `delivery-status` / `plan-updated` / `worker-spawned` / `worker-ended` / `worker-delivery`）
  - `electron/orchestrator.ts:1444-1482`（`snapshotActiveMeeting` 组装 hosts / tasks / taskMailboxes / reviewSessions / integrationQueue）
  - `electron/meeting-repository.ts:300-330`（`JSON.stringify({...}, null, 2)` → 写 tmp → rename → **每次还 `readdir` 清理 stale tmp**）
- **影响程度：高**
  - worker 事件粒度是"每条 assistant 消息 / 每次工具调用 / 每次状态推进"，一次任务动辄 10~50 次 → **每次都全量序列化一遍会议状态并落盘**。
  - `null, 2` 缩进让序列化 CPU 和文件体积双双放大（上限 16MB）。
  - `removeStaleSnapshotTmps()` 每次保存都 `fs.readdir` 一次目录，固定开销叠加在每次 worker 事件上。
- **判断依据**
  - 事件频率来自 `worker-scheduler.ts:2692`（`handleWorkerSignal` 每次发 `worker-event`），而 `onWorkerEvent`（2238）对每条 assistant / user(tool_result) / result 消息都会走状态机。
  - 快照体量随任务数、邮箱消息（`slice(-500)`）线性增长。

---

### P0-3　同一份 payload 被序列化两次 + 递归遍历一次

- **位置** `electron/meeting-repository.ts:107-143`（`assertBoundedJson`：递归 walk 最多 10 万节点，末尾再 `JSON.stringify` 一次）→ `meeting-repository.ts:243`（再 `JSON.stringify(event)` 拼行）
- **影响程度：中高**
  - 每条事件 = 1 次全对象图遍历 + 2 次完整序列化。事件频率越高，这部分 CPU 越线性放大，且全部发生在主进程事件循环里。
- **判断依据**
  - `assertBoundedJson` 返回值 `serialized` 在 `append` 里被丢弃，随后又重新 stringify 一次 —— 结果可复用但未复用。

---

### P0-4　终端 PTY 输出逐块 base64 + 逐条 IPC，无合并

- **位置**
  - `electron/ipc/worker-pty.ts:97-103`
  - `electron/ipc/shell-pty.ts:103-108`
  - `src/hooks/usePtyTerminal.ts:105`（每条 `atob` + `new Uint8Array` + `term.write`）
- **影响程度：中高**
  - 终端模式的 host/worker（`terminal-cli-adapter` / `claude-terminal-adapter`）跑的是全屏 TUI，重绘产生**大量小块**输出。每个 `onData` 回调都独立做 base64（+33% 体积）、一次 `webContents.send`、渲染层一次解码 + 一次 xterm 解析。
  - 表现为开会时（尤其多个终端 worker）CPU 常驻偏高、风扇起转，且 xterm 在大段输出时可能掉帧。
- **判断依据**
  - 代码里没有任何 coalesce / 时间窗合并 / rAF 批处理；对比 `BottomToolbar.tsx:86` 已用 `requestAnimationFrame` 批处理写入，说明渲染侧其他位置是有批处理意识的，这里是缺口。
  - `Buffer.from(data, 'utf8').toString('base64')` 对已经是字符串/缓冲的数据做二次转换。

---

### P0-5　观察层每 2s spawn 两个子进程（`ps` + `lsof`）

- **位置**
  - `electron/observe/observe-service.ts:89`（`DEFAULT_FAST_MS = 2_000`）、`263-310`（`tickOnce`）
  - `electron/observe/process/darwin.ts:229-243`（`lsof -Fn -p <pids>`）
- **影响程度：中高（常驻功耗）**
  - 只要存在活跃外部会话，就固定每 2s：spawn `ps` 全量快照 + spawn `lsof` 批量列 fd，再跑 4 个 observer 扫描 + 关联计算。
  - `lsof` 在多 pid 场景下开销明显，是 macOS 上典型的 CPU/IO 抖动源；这是**全天常驻**的成本，不是一次性成本。
- **判断依据**
  - 两者都是 `execImpl(...)` 子进程调用，不是 syscall 级 API。
  - 空闲时会退到 `slowMs=10s`（`loop()` 的 active 判断），但"有活跃会话"恰是用户正在用的时段。
  - 正面：statefile 解析用 head/tail 窗口 + mtime/size marker，未变更不重解析（这点做得对，见第五节）。

---

### P1-1　终端 transcript 尾部追加时整文件重读（O(n²) 累计）

- **位置** `electron/backends/terminal-cli-adapter.ts:706-726`
  - 先 `statSync` 比 size，变化则 `buf = readFileSync(file)`（**整文件**），再 `buf.subarray(startOffset)`
  - 1.5s 轮询：`terminal-cli-adapter.ts:332`（`TRANSCRIPT_POLL_MS = 1_500`）、`635`
- **影响程度：中**
  - 文件从 0 长到 1MB 的过程中，累计读取量约 O(n²/2)；长会话越跑越慢，出现周期性卡顿尖峰。
  - `readFileSync` 跑在主进程定时器里，**直接阻塞 IPC 与 UI 响应**。
- **判断依据**
  - 已正确用 size 短路（无变化不读），但"有变化"时仍整读，缺 `fs.read` + offset 的增量读（`observe/util.ts:84` 的 `readWindowLines` 已示范了正确写法，此处未复用）。

---

### P1-2　目录列举串行 `await stat`（N+1 syscall）

- **位置** `electron/ipc/documents.ts:395-410`（`for (const d of dirents) { await fs.stat(...) }`）
- **影响程度：中**
  - 目录项越多线性放大；Windows 上单次 stat 延迟更高，千级文件的目录打开会有明显停顿（文件树/附件选择器首屏）。
- **判断依据**
  - 同项目 `electron/ipc/ide-files.ts:174-190` 已用 `Promise.all(entries.map(...))` 并行化 —— 同一模式存在两种写法，`documents.ts` 是较慢的那种。

---

### P1-3　`App` 整树订阅完整 MeetingState

- **位置** `src/App.tsx:66`（`useWorkers()`）→ `src/hooks/useWorkers.ts:69`（`useSyncExternalStore(meetingStore.subscribe, meetingStore.getSnapshot)`）
- **影响程度：中**
  - 每个事件都产生新的 state 对象 → **1096 行的 App 组件整体重渲染**。子组件大多 `memo` 了，但 App 自身的 `useMemo` 链、props 组装、`permissionCount` 等派生计算每帧重跑。
  - 与 `SideDrawer` / `TaskInspector` 已采用 `useMeetingSelector` 细粒度订阅形成对比。
- **判断依据**
  - `useMeetingSelector.ts` 头部注释明确写了"whole-snapshot subscriber (useWorkers) re-renders on EVERY event"，说明这是已知取舍，但仍是最粗的一处订阅。

---

### P1-4　会话列表全量渲染，无虚拟化

- **位置** `src/components/SideDrawer.tsx:631`（`transcript.map`），上限 `MAX_TRANSCRIPT = 500`（`meeting-store.ts:53`）
- **影响程度：中低**
  - 每来一条新消息重排最多 500 个 DOM 节点；每条都跑 `formatMessageTime` + `new Date().toISOString()`。
  - `TIME_TICK_MS = 30_000`（`SideDrawer.tsx:103`）的时钟 tick 也会让整表重渲染一次。
- **判断依据**
  - 全项目无 `react-window` / `react-virtual` 等虚拟化依赖（`grep` 无命中）。

---

### P1-5　事件日志无压缩/轮转，启动时全量 replay

- **位置** `electron/meeting-repository.ts:357-384`（`replay`：`readFile` 全文 → `split('\n')` → 逐行 `JSON.parse`）
- **影响程度：中**
  - 叠加 P0-1（流式增量也入日志），单个会议的 `events.jsonl` 会显著膨胀；`start()` 里 `await MeetingRepository.replay(...)`（`orchestrator.ts:1220` 附近）是**同步等待**，会议越长二次打开越慢。
- **判断依据**
  - 全仓无 `compact` / `rotate` / `truncate` 对 `events.jsonl` 的处理（`grep` 仅 3 处命中，均为路径拼接）。
  - 对比 `transcript-store.ts:21-22` 有 `HARD_CAP=1500 / SOFT_CAP=1000` 的懒压缩 —— 同一项目里 journal 缺了这层。

---

### P1-6　`notify()` 无条件失效全部派生缓存

- **位置** `src/lib/meeting-store.ts:1011-1023`（任何事件都 `invalidateTabCache()` + 通知所有 `tabListeners`）
  - 失效后重算：`getTabs`（726-760，遍历所有 slot）、`getLobbyData`（792）、`getCrossProjectTasks`（804-859，遍历 slots × plan.nodes）
- **影响程度：中低**
  - 多 tab + 多任务时，每个事件都触发一次 O(slots × tasks) 重算，即使事件与该 tab 无关（例如后台 tab 的 worker 事件）。
- **判断依据**
  - `invalidateTabCache` 清空三个缓存，但多数事件（`message`、`turn-status`）不会改变 tab 徽标或跨项目任务列表。

---

### P1-7　陪伴窗口关闭时仍构建两份状态快照

- **位置** `electron/companion/companion-feed.ts:117-141`（`onOrchestratorEvent` 无条件走到 `push`）→ `254-257`（`model.state(now)` + `buildAhaBarState()`）
- **影响程度：中低**
  - 每个事件都构建一次 CompanionState + AhaBarState（含 `pending` 排序），随后 `sendToCompanion` 才在 `companion-window-manager.ts:41-45` 判断窗口是否存在。
  - 判断位置太靠后：窗口没开时白做两轮对象构建 + 一次排序。
- **判断依据**
  - `sendToCompanion` 的守卫是 `if (!companionWin || companionWin.isDestroyed()) return false;` —— 成本已经发生。

---

### P2-1　语音清洗每次重建正则 + 十余次全文 replace

- **位置** `src/lib/speech-format.ts:149-186`（`scrubToolNoise` 内 3 处 `new RegExp`，另加 10+ 条字面量正则替换）
- **影响程度：低**
  - TTS 每语块调用一次。正则编译是 µs 级，主要成本是 12+ 次全字符串扫描；对短句可忽略，对长段叙述可感知。
- **判断依据**
  - `TOOL_NAME_GROUP` 已是常量，但 `new RegExp` 写在函数体内，未提升到模块级。

---

### P2-2　同一次开会流程重复整读 transcript 文件

- **位置** `src/lib/meeting-store.ts:1063`（`loadHistoryForSlot`）与 `1099`（`buildResumeGreeting`），两者都在 `openSession` 路径上（1220 / 1261）
- **影响程度：低**
  - 同一 cwd 的 JSONL 被完整读两遍（`transcript-store.ts:46-54` 全文 `readFile` + `split`），再各自 `slice(-N)`。
  - 有 `HARD_CAP/SOFT_CAP` 兜底，所以绝对开销有界。
- **判断依据**
  - `buildResumeGreeting` 只需要最后 8 条，`loadHistoryForSlot` 需要最后 500 条，却各自触发一次全量读。

---

### P2-3　ASR 每帧一次 IPC + 一次堆分配

- **位置** `src/hooks/useVoiceCapture.ts:650-660`（每帧 `new Float32Array` 拷贝后 `sendAsrStreamFrame`），约 31 帧/秒（512 samples @16kHz）
- **影响程度：低（设计使然）**
  - 每秒约 31 条小 IPC + 31 次 2KB 分配。注释已说明拷贝必要（VAD 复用 buffer、IPC 异步序列化）。
- **判断依据**
  - 若后续要优化，可考虑在渲染侧累积 2~3 帧再发，代价是几十毫秒延迟 —— 需权衡，不建议贸然改。

---

## 四、判断依据的可复核性

| 结论 | 复核命令（只读） |
|------|-----------------|
| 流式增量是否入 journal | `grep -n "includePartialMessages" electron/host-group.ts`；`grep -n "handle.sync" electron/meeting-repository.ts` |
| 快照触发频率 | `grep -n "shouldSnapshot" -A 10 electron/orchestrator.ts` |
| PTY 无批处理 | `grep -n "onData" -A 6 electron/ipc/worker-pty.ts` |
| 观察层 2s 子进程 | `grep -n "DEFAULT_FAST_MS\|lsofOpenFiles" electron/observe/observe-service.ts` |
| transcript O(n²) 重读 | `sed -n '706,730p' electron/backends/terminal-cli-adapter.ts` |
| journal 无压缩 | `grep -n "compact\|rotate\|truncate" electron/meeting-repository.ts` |
| 列表无虚拟化 | `grep -rn "react-window\|react-virtual" src/` |

建议的运行时验证（不改代码，仅观测）：

1. 主进程 `--cpu-prof` 或 `node --prof`，看 `fs.write`/`fsync`/`JSON.stringify` 占比；
2. 会议运行中 `wc -l` 与 `ls -lh` 观察 `userData/meetings/<id>/events.jsonl` 与 `snapshot.json` 的增长速率；
3. DevTools Performance 录一段语音会话，统计 App 组件 commit 次数与 PTY 消息频率；
4. Activity Monitor / `sample` 观察 `lsof` 出现频次与常驻 CPU。

---

## 五、已检查、未发现明显问题的部分（避免误判）

这些地方设计是合理的，不建议改动：

- **重型依赖已拆分**：`pdfjs-dist`、`mammoth`、`docx-preview`、`phaser`、`onnxruntime-web` 均为动态 `import()` 或 `manualChunks`（`vite.config.ts`、`FileViewer.tsx:328`、`CompanionScreen.tsx:44`、`useVoiceCapture.ts:286`）。
- **shiki 高亮**：单例 highlighter + 按语言懒加载语法（`shiki-highlighter.ts`），没有每次重建。
- **observe 的 statefile 解析**：head/tail 定长窗口（`observe/util.ts:84`），带 mtime+size marker，未变更不重解析。
- **Task Inspector**：分页 replay（500/页）+ 增量订阅 + 世代号防竞态（`meeting-store.ts:646-712`）。
- **transcript 持久化**：`appendFile` 无 fsync + 按 projectId 串行 + HARD_CAP 懒压缩（`transcript-store.ts`）。
- **settings 写入**：异步原子（tmp + rename）+ 单尾队列；`openTabs` 有 100ms 去抖（`ipc/sessions.ts:41`）。
- **渲染层内存上限**：transcript / activity 各 500 条上限（`meeting-store.ts:53-54`）。
- **细粒度订阅**：`useMeetingSelector` + `shallowEqualArray` 已被 `SideDrawer` / `TaskInspector` 使用。
- **journal 防护**：payload 大小 / 深度 / 环检测齐全（`meeting-repository.ts:107-143`），只是重复序列化（P0-3）。
- **observe 快照去重**：`main.ts:471-501` 用 hash 抑制未变更快照的重播，30s 强制刷新。

---

## 六、优先级建议（若要修）

1. **P0-1**：给 `safeEmit` 加"不可重放事件"白名单（`stream_event` 不落 journal），或改为批量/延迟 fsync（按 N 条或 T 毫秒合并一次 `sync`）。收益最大、改动面最小。
2. **P0-2**：快照降频（合并到 500ms~1s 节流）+ 去掉 `null, 2` 缩进。
3. **P0-4**：PTY 输出加 16ms 时间窗合并（一次 IPC 带多块），渲染侧一次 `term.write`。
4. **P0-5**：`lsof` 只在慢 tick 或状态变化时跑；`ps` 快照可考虑降频到 3~5s。
5. **P1-1**：`terminal-cli-adapter` 改用 `fs.read(fd, buf, 0, len, offset)` 增量读，或复用 `readWindowLines` 的思路。

（以上仅为建议，本次未做任何修改。）

---

# 七、实测数据与结论修订（2026-10-18 20:20）

> 上文为静态走查。本节用项目自身编译产物做了隔离基准，**部分结论被数据推翻**，以本节为准。

## 7.1 环境与方法

- 机器：Windows 10/11，NTFS，Node v22.22.2
- 方式：`dist-electron/meeting-repository.js` 走**真实 `append()` 代码路径**（含 fsync），配合 `tests/electron-stub.mjs` 在纯 Node 下运行
- 抗噪：交错重复 7 轮 × 120 次，取中位数；A 组极差 2.254~2.661 ms
- **未做**：Electron 应用端到端 profiling（需 GUI + 凭证），因此没有整机 CPU 火焰图
- 脚本：`.workbuddy-ai/perf-bench/`（未改动任何源码）

## 7.2 真实日志分布（本机现存会议）

`%APPDATA%/ahastation/meetings/2024c77a-.../events.jsonl`：22 行 / 13,038 字节

| 事件类型 | 条数 | 字节 | 占比 |
|---|---:|---:|---:|
| `event:message` | 7 | 9,378 | **71.9%** |
| `event:host-added` | 4 | 1,054 | 8.1% |
| `event:session-ready` | 3 | 740 | 5.7% |
| 其余 7 类 | 8 | 1,866 | 14.3% |

即使是一次极短的会话，`event:message` 也占了七成以上字节（均值 1,340 B/条）。

## 7.3 journal 写入成本（每事件，1300 B payload）

| 方案 | 每事件 | 吞吐 | 相对现状 |
|---|---:|---:|---:|
| **A 现状**（mkdir + open + write + fsync + close） | **2.470 ms** | 405 ev/s | 1.0× |
| B 去掉每次重复的 `mkdir(recursive)` | 1.744 ms | 574 ev/s | 1.4× |
| **C 常驻 fd + 每事件仍 fsync** | **0.640 ms** | 1,564 ev/s | **3.9×** |
| D 常驻 fd + 不 fsync | 0.063 ms | 15,819 ev/s | 39.1× |

**成本拆解**（差值法）：

| 组成 | 耗时 | 占比 |
|---|---:|---:|
| `open` + `close`（每事件一次） | 1.10 ms | 45% |
| `fsync` | 0.58 ms | 23% |
| `mkdir(recursive)`（每事件一次，冗余） | 0.73 ms | 30% |
| `write` 本体 | 0.06 ms | 2% |

**结论修订（重要）**：真正的瓶颈不是 fsync，而是**每事件重新 open/close + 重复 mkdir**。
方案 C 在**完全保留"每条事件都 fsync"这一持久化保证**的前提下就有 3.9× —— 语义零变化，不需要动任何契约。

## 7.4 快照序列化（P0-2）

| 规模 | 缩进 `null,2` | 紧凑 | CPU 节省 | 体积节省 |
|---|---:|---:|---:|---:|
| 10 任务 | 0.061 ms / 13.4 KB | 0.040 ms / 6.3 KB | 34% | 52% |
| 40 任务 | 0.220 ms / 51.8 KB | 0.150 ms / 24.4 KB | 32% | 53% |

去掉缩进是**纯赚**：CPU 降三成、磁盘体积腰斩，且 snapshot 只被 `JSON.parse` 读回，无格式依赖。

## 7.5 结论修订表

| 原编号 | 原判断 | 实测后 | 处理 |
|---|---|---|---|
| P0-1 fsync 每事件 | 高（fsync 是主因） | 高（但主因是 open/close + mkdir，fsync 仅 23%） | **改法换成常驻 fd，风险从"动契约"降为"零语义变化"** |
| P0-3 双次序列化 | 中高 | **0.0153 ms / 8KB 事件 = 现状的 0.6%** | **降级为 P2，基本可忽略** |
| P0-2 快照缩进 | 中 | 32% CPU / 53% 体积 | 保持，纯赚 |
| P0-2 快照节流 | 中高 | 单次 0.15~0.22 ms，非主瓶颈 | 降为低优先 |
| P1-5 journal 压缩 | 中 | 文件本身不大（22 事件 13KB），瓶颈在写入次数非体积 | 继续暂缓 |

## 7.6 功能基线（改动前的安全网）

`tests/*.test.mjs`：**925 个用例，890 通过 / 33 失败 / 2 跳过**，耗时 97.8 s。

33 个失败全部落在三类 **macOS 专属行为**上，与性能路径无关：

| 类别 | 数量 | 原因 |
|---|---:|---|
| `ps` / `lsof` 输出解析 + observe 夹具 | ~22 | 夹具是 macOS `ps -axo` 格式，Windows 输出不同 |
| symlink 越界防护（`resolveConfinedPath` 等） | 5 | Windows 创建符号链接需管理员/开发者模式 |
| kimi 会话解析 | 4 | 依赖同一批 observe 夹具 |

**没有任何失败落在 journal、PTY、渲染层 —— 即本次要动的三条路径上。** 因此这 33 个失败应视为"Windows 环境既有差异"，不是回归。真机（macOS）上应重新跑一次确认。

## 7.7 修复后的预期收益（按实测推算）

一次 400 token 的回复，按 ~200 个流式增量估算：

| 方案 | 纯 journal I/O 耗时 | 说明 |
|---|---:|---|
| 现状 | ~494 ms | 串行叠加在回复链路上，且 `emit` 在 `append.then` 内 |
| 常驻 fd（C） | ~128 ms | 保留每事件 fsync，语义不变 |
| 常驻 fd + 批量 fsync（D 思路） | ~13 ms | 放弃"先落盘后可见"，需产品确认 |

**推荐落地顺序（据实测调整）**：
1. `MeetingRepository` 改常驻 fd + 目录创建提到构造期 —— 3.9×，语义零变化，收益最大
2. 快照去掉 `null, 2` —— 纯赚
3. 把 `emit` 移出 `append.then` —— 再省掉剩余 ~128 ms 的链路阻塞，需确认契约
4. 双次序列化、快照节流 —— 实测收益很小，可延后

## 7.8 本次测量的局限

1. **平台不符**：项目发布目标是 macOS/arm64，本次在 Windows/NTFS 上测得。APFS 上 `fsync` 与 `open` 的绝对开销不同（`open` 通常更快，`F_FULLFSYNC` 可能更慢），**比例关系需在 Mac 上复核**。
2. **无端到端数据**：没有启动 Electron 应用，因此缺少整机 CPU 火焰图与真实事件到达速率。上面"200 个增量"是估算，不是实测。
3. **样本单一**：本机只有一个 22 事件的微型会议，缺少长会话的日志增长曲线。
4. 机器存在 AV/后台噪声，已用交错中位数压制，但单次测量仍不可信。
