# B06 · 用量接线技术方案（草案）

日期：2026-10-22。状态：**设计草案，未改代码**。基线 main `c134de2`。前置阅读：同目录 `README.md`（能力矩阵）、架构 11「额度服务与模型路由」。

## 0. 对 README 的一处更正

README 写「`task-budget.ts` 的 token 预算即使改成有限值，也**永远不会触发**」。**不准确。**

`worker-scheduler.ts:3230-3245` 和 `:3335-3346` 写入 attempt 时，`tokenCost` 是 `null`，但同时写了
`reservedTokenCost = executionProfile.maxTokenBudget ?? 200_000`；`task-budget.ts:65` 用 `tokenCost ?? reservedTokenCost` 累计。
所以有限预算**会触发**，只是按「每个 attempt 记满一份预留」计算，和实际消耗无关：

- 轻任务会被提前暂停（实际 2 万 token，也按 20 万计）；
- 重任务可能被低估（一个 attempt 实际超过预留，也只计预留）。

真正的缺口是「**没有实际计量**」，不是「预算失效」。B06 的接线目标据此改为：用实际观测替换预留，拿不到观测时保留预留。

## 1. 现有接缝

| 位置 | 现状 |
| --- | --- |
| `src/types.ts:617` `WorkerAdapterSignal` | 五种：`progress` / `tool` / `delivery` / `failed` / `ended`，没有用量 |
| `electron/worker-protocol.ts:91` | 同一信号的 zod schema，进入持久化的 `worker-event`（schemaVersion 2） |
| `claude-code-adapter.ts:53` `mapClaudeMessageToWorkerSignals` | `type === 'result'` 时只看 `is_error`，丢掉了 `usage` / `modelUsage` / `total_cost_usd`；`rate_limit_event` 落到「非 content」分支被丢弃 |
| `codex-adapter.ts:492` `onNotification` | 只处理 `item/*`、`turn/*`、`error`，`thread/tokenUsage/updated`、`account/rateLimits/updated` 被丢弃 |
| `codex-app-server-transport.ts:97` | 已经调用 `account/read`，可以在同一位置加 `account/rateLimits/read` |
| `task-collaboration.ts:253` `taskAttemptRecordSchema.tokenCost` | 必填非负整数（持久记录）；scheduler 内存里是 `null`，由 `ipc/tasks.ts:607` 过滤 |

## 2. 设计

### 2.1 新增信号 `usage`（只追加，不改已有信号）

```ts
// src/types.ts 与 worker-protocol.ts 同步追加
| {
    kind: 'usage';
    source: 'claude-result' | 'claude-rate-limit' | 'codex-token-usage' | 'codex-rate-limits';
    quality: 'reported' | 'estimated';       // 架构 11 的计量质量；reserved/unsettled 属于账本，不在信号里
    scope: 'turn' | 'cumulative';            // Codex tokenUsage 的 last / total；Claude result 是本 turn
    tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; reasoning?: number };
    costUsd?: { value: number; basis: 'api-list-price' };   // Claude total_cost_usd：订阅用户也只是估算
    window?: {                                // 订阅窗口，只有百分比，没有绝对量
      id: string;                             // 'five_hour' | 'seven_day' | 'primary' | 'secondary' | ...
      usedPercent: number | null;
      resetsAt: number | null;                // epoch ms
      status?: string;                        // Claude rate_limit_event.status 原样保留
    };
    model?: string;
  }
```

设计取舍：

- **不合并单位**：tokens、估算美元、窗口百分比各占一个字段，不换算成统一「额度点数」（规格「不把不同单位硬加」）。
- **单独一种信号**，不塞进 `ended`：Codex 的 tokenUsage 是 turn 内多次推送；Claude 的 rate_limit_event 可能在任意时刻到达。
- `worker-event` 的 schemaVersion 保持 2：只是 union 追加成员。旧版本应用回放新日志会在 zod 校验处失败，所以**回放端要先忽略未知 kind**（需要核对 `worker-protocol` 的回放路径，见 §5）。

### 2.2 Adapter 改动

**Claude**（`mapClaudeMessageToWorkerSignals`）：

1. `type === 'result'`：在 `ended` 之前插入一个 `usage`，`source: 'claude-result'`、`quality: 'reported'`、`scope: 'turn'`，读 `usage.input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`；`total_cost_usd` 写进 `costUsd`，标 `api-list-price`。
2. `type === 'rate_limit_event'`：输出 `usage`，`source: 'claude-rate-limit'`，只带 `window`。
3. `suppressExpectedSteerBoundary` 为真时，现在整个 result 被吞掉。**用量不能跟着吞掉**，否则 steer 中断的那个 turn 不计费。改为只吞 `ended`/`failed`，保留 `usage`。

**Codex**（`onNotification`）：

1. `thread/tokenUsage/updated`：取 `last`（本 turn）输出 `scope: 'turn'`；同时用 `total` 做对账（见 §2.3），不重复累计。
2. `account/rateLimits/updated`：每个窗口一条 `usage`，`source: 'codex-rate-limits'`。
3. 会话启动时在 transport 里调用一次 `account/rateLimits/read`，结果作为服务池初始观测；**失败不阻塞启动**，标记未知。
4. Host 会话（`!this.isWorker`）也要上报：会议 / Host 用量不计入项目执行额度，但要计入服务池（架构 11「会议与 ASR/TTS 分类不参与项目执行额度，实际后台任务不因入口是会议而豁免」）。Host 先只记录，不进 task budget。

**Kimi / OpenCode / Qoder / pocket-vibe**：本切片不动。它们不输出 `usage`，scheduler 继续按预留计（§2.3 的回退路径）。

### 2.3 Scheduler 改动

`WorkerHandle` 新增 `usageByAttempt: Map<number, AttemptUsage>`：

```ts
interface AttemptUsage {
  reportedTokens: number;       // Claude result 按 turn 累加；Codex 取 last 累加，并用 total 的差分校验
  costUsdEstimate: number | null;
  sawReport: boolean;           // 至少收到过一次 reported
  lastWindowObservations: Record<string, { usedPercent: number | null; resetsAt: number | null }>;
}
```

attempt 结算时（`runAutomaticRework` 与 `recordSuccessfulBudgetAttempt` 两处）：

- `sawReport` 为真：`tokenCost = reportedTokens`（含 cache 读写，但 cache read 是否按 1:1 计入要定，见 §4 Q2）。
- 否则：`tokenCost = null`，继续用 `reservedTokenCost`。**丢失反馈不当作 0**（`task-budget.ts:38-40` 的既有原则）。
- **中断 / 崩溃时**：如果收到过部分 `usage`，记 `max(reported, 0)` 但标记 `unsettled`；在 B19 账本出现之前，简单做法是 `tokenCost = null`，仍按预留计，宁可保守。

把两处写死的结构抽成一个 `buildBudgetAttempt(handle, attempt, extra)`，避免两处再出现不一致。

### 2.4 不在本切片里做的

- 服务池 / 项目周期账本（B19）。本切片只产出观测，不做跨任务、跨项目扣减。
- 在途预留按「单 turn 最大消耗」计算（README 结论 3）：等 B19。
- UI 展示。`ipc/tasks.ts:607` 已经透传 `tokenCost`，接上后看板自动显示数字；窗口百分比的展示等 B07 原型。
- Codex 超预算后主动 `turn/interrupt`：属于执行控制，等 B19 定阈值。

## 3. 测试计划（确定性，不调用付费模型）

| 测试 | 输入 | 断言 |
| --- | --- | --- |
| Claude result → usage | 脱敏 result fixture（含 usage、modelUsage、total_cost_usd） | 输出顺序 `usage` → `ended`；数值一致；`costUsd.basis === 'api-list-price'` |
| Claude steer 边界 | 同上 + `suppressExpectedSteerBoundary` | 只输出 `usage`，不输出 `ended` |
| Claude rate_limit_event | five_hour / seven_day 两条 fixture | 各一条 `window` 信号，`resetsAt` 转成 ms |
| Codex tokenUsage | 一个 turn 内 3 次推送（last、total 递增） | 累加 last = total 的差分；不重复计 |
| Codex rateLimits | read 响应 + updated 推送 | primary / secondary 两条 window；read 失败时启动不报错 |
| Scheduler 结算 | 有 usage 的 attempt + 没有 usage 的 attempt | 前者 `tokenCost` 为实际值；后者为 `null`，预算仍按预留累计 |
| 预算触发 | 有限 `maxTotalTokens`，两次实测 attempt 跨过阈值 | `evaluateTaskBudget` 返回 `budget-paused`，不派发下一次 |
| 回放兼容 | 包含 `usage` 的旧日志 | 回放不失败；未知 kind 被跳过（如果选择这个兼容策略） |

Fixture 来源：协议字段按 `@anthropic-ai/claude-agent-sdk@0.3.150` 的 `sdk.d.ts` 和 `codex app-server generate-ts`（0.144.1）手写；**真实样本要等小额冒烟授权**（README 第 6 节第 3 项）后替换，用于验证字段名没有猜错。

## 4. 待定问题

| # | 问题 | 建议 |
| --- | --- | --- |
| Q1 | `worker-event` 回放遇到新 kind 怎么办 | 回放端对未知 `payload.kind` 记 warning 并跳过，先单独提交这个兼容改动，再加 `usage` |
| Q2 | cache read token 是否计入 `tokenCost` | 计入但单列；`tokenCost` 先用 input + output + cacheWrite，cacheRead 只记录不计入预算。价格差约 10 倍，全计会让 Claude 任务的预算明显偏紧 |
| Q3 | 订阅用户的 `total_cost_usd` 文案 | UI 一律写「按 API 价格估算」，不写「已花费」 |
| Q4 | Host 会话用量记到哪里 | 本切片只写 worker-event 日志，不进 task budget；B19 再归入服务池 |
| Q5 | 全局新版 CLI（Codex 0.162.1 / Claude Code 2.1.299）字段变化 | 应用固定版本运行（`worker-runtime-contract.ts` 的 `EXPECTED_VERSION`），本切片按固定版本写；系统 PATH 模式的 Claude 字段差异由解析容错兜底：字段缺失就不输出 usage，回退到预留 |

## 5. 动手前要先核对的点

已核对（2026-10-22，只读）：

- **Claude 消息不会在 session 层被过滤**：`claude-session.ts:220-249` 对 SDK 的每条消息都原样 `emit({ kind: 'message' })`，所以 `rate_limit_event` 能到 adapter。
- **实时路径对未知 kind 是安全的**：`worker-scheduler.ts:2595` 用 `parseWorkerAdapterSignal` 校验，不合法的信号只 `console.warn` 后丢弃，不会抛异常。所以 adapter 先发 `usage`、schema 后加，只会丢数据，不会崩。
- **持久化路径**：worker-event 经 `orchestrator.ts:1182` 写入 `event:worker-event` 日志并触发快照；渲染端 `ClaudeWorkspace.tsx:428` 把 worker-event 显示为时间线。**新增风险**：Codex 每个 turn 会推送多次 tokenUsage，如果不过滤，时间线会被 `usage` 刷屏。渲染端时间线要排除 `usage`，或者只在 turn 结束时由 scheduler 合并成一条再写日志。建议后者，日志量也更小。

仍待核对：

- 旧版本应用读取含 `usage` 的快照时，渲染端遇到未知 kind 会怎么显示（Q1）。
- Codex app-server 0.144.1 的 `thread/tokenUsage/updated` 里，`last` 是「本 turn 至今」还是「最近一次模型调用」；这决定 §2.3 用 last 累加还是用 total 差分。生成的 TS 类型里没有注释的话，只能等真实样本确认。

估算：adapter + scheduler + 测试约 1.5–2 人日（不含真实冒烟）。
