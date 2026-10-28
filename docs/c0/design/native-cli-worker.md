# 原生 CLI Worker 与会话接管：变更说明

日期：2026-10-28。决定依据：[ADR 0019](../../adr/0019-native-cli-workers-with-host-hooks.md)（用户 10-28 逐项确认）。

本文写给要按这次变更改代码的人：协作线（eternal904、Dryoung95）、终端线（Leo）、负责界面的产品同事，以及扫描线的 Claude 会话。§2 是所有人都要读的；各线的具体要求在 §5–§8；线与线之间的接口在 §9。

## 1. 一句话

**执行任务的 Worker 改为在 PTY 里跑原生 Claude / Codex CLI，审批经全局 hooks 转给宿主。** 用户可以点开任何一个 Agent 会话、随时接管；本机已有的会话会被扫描、归类，并可以收编进 AhaStudio。跨设备执行端由终端线负责，Station 只做编排。

## 2. 决定一览（10-28）

| # | 决定 | 改变了什么 |
| --- | --- | --- |
| 1 | Worker 和独立复核跑原生 CLI，每个 Agent 一个会话；子 Agent 由 CLI 自己编排 | ADR 0016 的执行部分 |
| 2 | Host 和会议专家走 SDK；点开时只读，接管时转原生 CLI | — |
| 3 | 审批经 PreToolUse / PermissionRequest hooks 转宿主裁决 | Leo 分支现在只有会话级 Stop hook |
| 4 | Worker 准入：能在工具调用前拒绝、有 Stop 信号、通过 B04 实测。首批只有 Claude、Codex | — |
| 5 | 随时可以接管；接管期间宿主不再发指令；交还后 Agent 先读改动 | AME-D32、D33、Q20（原来是「CLI 不支持接管」） |
| 6 | 远端会话可以经 Hub 实时只读查看，接管只能在执行设备上操作 | Hub 要新增终端流转发 |
| 7 | hooks 像 Orca 一样全局生效；用户自己的会话只观察、不裁决 | — |
| 8 | 扫描本机所有会话，按项目、工作树、分支归类；新项目推系统通知并在 Studio 弹窗授权；收编时先复制会话、在 Studio 续接，再提示用户结束原会话 | AME 11「观察层只读、不当受控任务」 |
| 9 | 跨设备执行端由终端线（Leo）负责，Station 只做编排 | ADR 0018 第 1、2 条 |
| 10 | Worker CLI 桥合入前，在 CLI 路径上用 Claude、Codex 跑 B04 的 S1–S6、S8、S11 | — |
| 11 | Codex 统一用 0.156.1 加区间 `[0.156.1, 0.157.0)` | `etrnal-dev` 精确写死的 0.164.0 |
| 12 | 所有界面的设计优化和开发由产品负责；例外是远端终端的查看界面，由 Leo 做 | 原计划中研发 3 的界面任务 |

不变的规则：
- 授权在模型之外强制执行；
- 远端停止要等执行端确认，才能显示「已停止」；
- 内部阶段 Hub 可信，但每条设备消息都要签名（ADR 0017）；公开前改为中转只见密文；
- 默认并发 2；
- 跨设备首版只有 Claude、Codex（C14）。

## 3. 参考代码

**终端线：** Leo 的 `origin/pr49` @ `77e07ae`（10-24）。PR #49 已关闭，他会拆成四个 PR 重提，代码内容以这个提交为准。

| 文件 | 内容 | 和这次变更的关系 |
| --- | --- | --- |
| `electron/terminal-daemon/{protocol,client,entry,launcher,storage}.ts` | 独立终端守护进程。协议有 `hello / inventory / spawn / attach / detach / input / resize / terminate`，事件 `output` 带 `sequence`，`attach` 返回带 `replay` 的快照 | 远端查看（U7）的数据源；执行端（X1）启动 Worker 用它 |
| `electron/terminal-daemon/windows-pipe-acl.ps1` | Windows 命名管道权限 | 要改成创建时就带权限（T2 的合入条件） |
| `electron/worker-cli-bridge.ts`、`worker-cli.ts` | 本机 127.0.0.1 上的回报通道，命令有 `report / ask / inbox`，每个 Worker 一份凭据 | Worker 回报成果的通道 |
| `electron/backends/terminal-cli-adapter.ts` | 终端 Worker 适配；目前每个会话单独注册一个 Stop hook | 要改成全局 hooks，并加上转宿主的审批 |
| `electron/pty-host.ts`、`windows-pty-startup.ts` | PTY 启动，处理 Windows 上的启动问题 | 沿用 |
| `docs/plans/2026-10-23-terminal-daemon-roadmap.md` | 守护进程设计：快照水位、单写客户端、关闭语义 | U7 的快照与补拉照这里的语义做 |

注意：守护进程目前只在 Windows 上验收过，Unix socket 留了接口但没做。macOS 上的 Worker 本周先在主进程 PTY 里跑（应用重启后不保活），守护进程的 macOS 版排在之后。

**协作线：** `etrnal-dev` @ `295e1ba`。这次会改到的位置：

| 文件 | 现在做什么 | 变更后 |
| --- | --- | --- |
| `services/remote/device/station_codex.py`（`Guardian`）、`codex_shared_service.py` | 在执行设备上直接驱动 Codex app-server，并做进程隔离 | 执行部分冲刺后退役，改由终端线的执行端负责（§6.3、§9.2）；本周照现状合入 |
| `electron/collaboration/station-service.ts` | Station 编排、交付授权（`authorizeDelivery`） | 保留编排；冲刺后改为调用执行端接口 |
| `services/remote/device/public_hub.py`、`hub_store.py`、`collaboration_store.py` | Hub 接口与存储 | 新增终端流转发（§5.2） |
| `electron/backends/codex-app-server-transport.ts:23`、`worker-runtime-contract.ts:14`、`station_codex.py:170` | 精确写死 0.164.0 | 改用区间 |

## 4. 分工总表

| 变更 | 协作线（eternal904） | 终端线（Leo） | 产品（界面） | 扫描线（Claude 会话 + 研发 1） | Mac / N5095 |
| --- | --- | --- | --- | --- | --- |
| 本机 Worker 跑 CLI，hooks 转宿主（T4） | 受影响 | **做** | — | — | 复核；N5095 跑 B04 |
| 全局 hooks（S1） | 受影响：Station 的会话要登记 | — | — | **研发 1 做** | 复核 |
| 会话扫描、归类、收编（S2–S5） | 受影响 | 收编时的续接配合 | 通知、授权弹窗的界面 | **做** | 复核 |
| 会话详情与接管（U6） | 同步接管状态（§5.4） | 接管 / 交还机制 | **界面** | — | — |
| 远端终端只读查看（U7） | **Hub 和 Station 侧** | **终端流、快照接口、查看界面** | — | — | — |
| 跨设备执行端改走 CLI（X1，冲刺后） | **编排侧** | **执行端** | — | — | 双机验收 |
| 协作基线修复与分批合入（C1–C5） | **做** | — | — | — | Mac 复核 |
| 协作界面放进新会议布局 | 提供数据投影 | — | **做** | — | — |
| 信息架构、会议布局、看板、决定卡片、主题（U1–U5） | 无关 | 主题与图标配合 | **做**（U3–U5 由 Claude 界面会话写，产品审核） | — | — |
| ADR 0019、AME 改版 | 读 | 读 | 评审 | — | Mac 写 |
| 三家语音实测 | 无关 | 无关 | 无关 | — | N5095 |

## 5. 对协作线的要求（eternal904、Dryoung95）

**你们负责「跨设备的编排」，不再负责在执行设备上启动 Agent。** 以下逐项写明要做什么、做到什么程度。

### 5.1 本周必须完成（C1–C5）

| # | 内容 | 日期 | 完成标准 |
| --- | --- | --- | --- |
| C1 | rebase 到新 main（PR #54、#53 合入后）；Codex 改用区间，Python 侧读同一个区间；4 处同步 `safeStorage` 改成异步，并入 `warmSecrets` | 10-30 – 10-31 | 两侧 typecheck 通过，全量测试不新增失败 |
| C2 | 修 N3（所有平台统一拒绝盘符、反斜杠和冒号）、N6（提示词文件和本机路径）；补 `services/remote/` 的来源与许可说明 | 10-31 | Mac 复核通过 |
| C3 | 第 1 批：契约与文档；过程性的报告移到证据目录 | 11-01 | Mac 复核后合入 |
| C4 | 第 2 批：Hub，只在本机或内网运行 | 11-01 | 同上 |
| C5 | 第 3、4 批：Station 与协作界面，入口默认关闭；界面以数据投影和面板组件的形式提供，由产品放进新布局 | 11-02 | 入口关闭时没有任何对外连接 |

### 5.2 远端终端只读查看：Hub 和 Station 侧（U7，11-02）

要求：
1. **消息**：新增两类消息：
   - 终端增量 `{meetingId, taskId, attemptId, deviceId, terminalId, seq, data}`；
   - 终端快照 `{…同上, seq: H, replay}`。
   
   `seq` 直接沿用守护进程 `output` 事件里的 `sequence`，不另编号。
2. **只读**：Hub 只转发执行设备到查看方这一个方向。查看方发来的任何输入、resize、terminate 一律拒绝。接管只能在执行设备上做。
3. **加入与补拉**：查看方订阅时带上已收到的最后一个 `seq`。Hub 能补就从这里补；补不上（超出缓冲）就让执行端重发快照，查看方丢弃水位 H 之前的增量。语义与守护进程的「快照 + 水位」相同。
4. **签名**：订阅请求和终端消息都按 ADR 0017 留好签名字段；签名（A-12 / A-13）做完前，协作入口默认关闭。
5. **保存期限**：由你们提出方案，约束有三条：
   - 终端内容不算会议记录（不适用 C02「长期保存」）；
   - 有上限，不能无限增长；
   - 用户删除会议时一并删除。
   
   建议：每个终端只保留最近一份快照和它之后的增量（总量设上限），任务结束后短期内删除。
6. **流量**：给出单个终端的带宽上限和背压做法；超限时宁可让查看方重新取快照，也不能阻塞执行端。

### 5.3 会话归属登记（本周，随 C5）

全局 hooks 和扫描会看到本机所有 Agent 会话，包括 Station 在执行设备上启动的。为了不把它们当成用户自己的会话：
- Station 启动的每个会话，都要按 §9.3 的格式在本机登记归属；
- 本周 Station 还在用 Python 驱动 Codex app-server，这部分启动的线程同样要登记。

### 5.4 接管状态同步（随 U7）

执行设备上的用户接管或交还一个 Worker 会话时，执行端会产生 `takeover` / `handback` 事件。Station 要把它们经 Hub 同步到协调设备，协调端显示「已在执行设备上接管」。接管期间，协调端的 Host 不得再向这个任务派发指令。

### 5.5 冲刺后：执行端改走 CLI（X1）的编排侧

- Station 不再直接启动 Codex。`station_codex.py` 的执行与 `Guardian` 进程隔离部分退役，改为调用终端线的执行端接口（§9.2）。
- 你们保留：接收、持久化、核对、回执状态机（「已接收 / 已开始 / 停止请求中 / 停止未确认 / 已停止 / 待核对」）、交付授权（`authorizeDelivery` 和 K01 的约束不变）。
- 已有对话的远程接续仍按 C04：权限不超过执行设备本机的项目授权。

### 5.6 请在 10-30 前交回一份影响评估

请基于 Leo 的 `origin/pr49` @ `77e07ae` 和本文，回答：
1. `etrnal-dev` 里哪些文件、模块要改、要删、可以保留？粗估人日。
2. §9.2 的执行端接口能否覆盖你们现有的回执状态机？缺哪些事件或字段？
3. U7 在 Hub 侧的消息设计、带宽上限和保存期限方案。
4. 本周 Station 照现状合入（入口默认关闭），会不会和 Worker 改走 CLI 冲突？
5. 你们之前提的 guardian 两种接法，在「进程树归终端线管」之后还剩哪些需要你们处理？

### 5.7 不需要你们做、但会影响你们的

- 本机 Worker 改走 CLI 和 hooks（终端线）：协调设备上的本机任务和跨设备任务共用并发名额 2（C16）。
- 全局 hooks 和会话扫描（扫描线）：只在本机，不经过 Hub。
- 所有界面由产品负责：你们的界面改动以数据投影和组件交付。
- ADR 编号：0019 已被本条占用，你们新增的从 0020 起。

## 6. 对终端线的要求（Leo）

### 6.1 本周

| # | 内容 | 日期 | 完成标准 |
| --- | --- | --- | --- |
| T1 | 按四线拆分（守护进程、本地工作区界面、Worker CLI 桥、图标主题），rebase 到新 main，补 CI | 10-29 – 10-30 | 每个 PR 都有三平台 CI 记录 |
| T2 | 合入守护进程和图标主题；`node-pty` 在 Electron 45 下验证；命名管道在创建时就带上安全描述符 | 10-31 | Windows 守护进程测试和打包冒烟真实跑过 |
| T3 | 合入本地 CLI 工作区界面（入口位置由产品定） | 11-01 | — |
| T4 | Worker CLI 桥改造（见 §6.2） | 10-30 – 11-01 | 确定性测试通过，Mac 复核通过 |
| S1 | 全局 hooks 安装与卸载（研发 1 负责，和 T4 是同一套 hook 脚本） | 10-30 – 10-31 | 卸载后配置文件和安装前一致；AhaStudio 关闭时 CLI 没有可感知的延迟 |
| U6 | 接管 / 交还机制（界面由产品做） | 11-01 – 11-02 | 接管期间宿主不再发指令 |
| U7 | 终端字节流和快照接口（§9.1）、远端查看界面 | 11-02 | 本机能实时看到 N5095 上的 Worker |
| T6 | B04 在 CLI 路径通过后合入 Worker CLI 桥 | 11-02 | S4–S6 全部通过 |

### 6.2 Worker CLI 桥要改什么

1. **hooks**：从「每会话一个 Stop hook」改为全局 hooks，订阅 PreToolUse、PermissionRequest、PostToolUse、Stop。
   - Worker 会话的 PreToolUse / PermissionRequest 转宿主，由 `task-authority` 按项目授权裁决；宿主连不上时一律拒绝。
   - 用户自己的会话只上报、立即放行。
   - Codex 要打开 `codex_hooks` 特性开关。
2. **严格停止**：停止后，宿主对该会话的 PreToolUse 一律拒绝，再发中断；超时就结束进程树；撤销已批准、尚未执行的命令。要满足 B04 S6：30 秒内没有新的工具调用、没有文件变化、子进程全部退出。
3. **G4**：获批命令执行前后，对授权范围外的文件做 hash 比对，发现越界写入就停止 Run。
4. **回报**：`aha-worker report` 只对当前 attempt 有效；旧 attempt 的报告和重复报告要拒绝，或者返回原回执。
5. **接管**：进入接管时宿主不再写入该 PTY；交还时宿主发一条「请先阅读用户改动」的提示，并附上工作区差异。
6. **准入**：只有 Claude、Codex 可以当 Worker；其他 CLI 只能作为手动终端打开。

### 6.3 冲刺后：跨设备执行端（X1）

- 在执行设备上提供 §9.2 的执行端接口；
- 由守护进程启动 Worker；
- 进程树隔离和退出确认由你们负责，取代 `etrnal-dev` 的 `Guardian`：Windows 用 Job 对象，Linux 用 subreaper，macOS 用进程组；
- 守护进程补上 macOS 版本（Unix socket）。

## 7. 对产品（界面）的要求

所有界面的设计优化和开发由产品负责，按 B07 冻结稿实现：

| # | 内容 | 日期 |
| --- | --- | --- |
| P1 | 交互稿：会话详情与接管（接管、交还、远端只读三种状态）；新项目系统通知、授权弹窗、复制会话交接 | 10-29 – 10-30 |
| U1 | 信息架构收拢：首页、会议、任务、设置四个入口；协作面板、终端工作区、会话列表挂到 B07 §2 的位置 | 10-29 – 10-30 |
| U2 | 会议布局 D15；协作面板放进新布局 | 10-31 – 11-01 |
| U6 | 会话详情与接管的界面：点参会人打开会话，Worker 显示原生终端，Host / 专家显示只读视图 | 11-01 – 11-02 |
| S4 | 新项目授权弹窗的界面 | 11-01 |
| U3–U5 | 五列看板、决定卡片、主题：由 Claude 界面会话写，产品审核 | 10-29 – 11-02 |

## 8. 扫描线（Claude 扫描会话、研发 1）

| # | 内容 | 日期 |
| --- | --- | --- |
| S2 | 首次启动并经用户授权后，读 Claude、Codex 的历史和运行中会话，以及 AhaStudio 历史任务；只读；排除 §9.3 登记过的会话 | 10-29 – 10-30 |
| S3 | 按项目、工作树、分支归类，实现 A-02 的项目稳定身份（ADR 0013） | 10-31 – 11-01 |
| S4 | 发现未授权的独立项目时推系统通知，在 Studio 弹窗里确认目录授权 | 11-01 |
| S5 | 收编：先备份会话文件，复制出新会话，在 Studio 原生终端里续接，再提示用户结束原会话；权限不超过项目授权 | 11-01 – 11-02 |

## 9. 线与线之间的接口

### 9.1 终端流接口（终端线提供，协作线和查看界面使用）

在守护进程现有协议上提供只读订阅：
- `subscribe(terminalId, afterSeq?)`：返回快照 `{seq: H, replay, cols, rows}`，之后推送 `seq > H` 的 `output`；
- 只读订阅方不能 `input`、`resize`、`terminate`；
- 缓冲溢出时推送「需要重新取快照」，不静默丢字节。

### 9.2 执行端接口（X1，冲刺后；终端线提供，Station 调用）

| 调用 / 事件 | 含义 |
| --- | --- |
| `start({taskId, attemptId, agent, cwd, prompt, grant})` → `{workerId, terminalId}` | 用稳定的 `attemptId` 去重；同一 ID 不同参数要拒绝 |
| `stop(workerId)` | 返回「已发出」；最终状态以事件为准 |
| `status(workerId)` | 运行中 / 已结束 / 已丢失 / 未知 |
| 事件 `turn.started`、`turn.completed{outcome}`、`tool`、`report`、`stopped{confirmed}`、`takeover`、`handback`、`exited{code}` | `turn.completed.outcome` 只认 CLI 明确报告的结果（与 K01 的要求一致）；`stopped.confirmed` 只有在进程树退出后才为真 |

### 9.3 会话归属登记（所有启动 Agent 会话的组件都要遵守）

本机清单文件放在 AhaStudio 应用数据目录下的 `sessions/owned.json`，每条记录：

```json
{ "agent": "codex", "sessionId": "…", "origin": "station | worker | user-adopted", "taskId": "…", "attemptId": "…", "registeredAt": "2026-10-30T10:00:00Z" }
```

- 写入用「先写临时文件、再原子替换」；
- 扫描线读取这个文件，把 `origin` 不是 `user-adopted` 的会话排除在「用户会话」之外；
- hook 脚本也可以通过环境变量 `AHA_SESSION_ORIGIN` 识别来源，但以清单为准。

## 10. 待定

- **Codex 的会话续接和复制**：用 SDK 创建的 Codex 线程能否用 `codex resume` 在原生终端里续接，以及能否复制，在 T5 实测。不行的话，Host 和专家的接管只支持 Claude。
- **Codex 的 hooks 开关**：还标着实验性，B04 重跑要证明它可靠。
- **守护进程 macOS 版**：时间待定（冲刺后）。
- **U7 的保存期限和带宽上限**：等协作线在 10-30 前给出方案。
