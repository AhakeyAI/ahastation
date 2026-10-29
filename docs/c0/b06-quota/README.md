# B06 · 多服务额度读取与控制能力矩阵（第一版）

日期：2026-10-22。状态：**基于固定版本 SDK 和协议类型的静态核查**，没有登录、没有读取凭据，也没有调用付费模型。依据：规格 10「额度与执行控制」、架构 11「额度服务与模型路由」、决策 D25。

## 核查方法

- 两个固定版本：`@anthropic-ai/claude-agent-sdk@0.3.150` 读 `sdk.d.ts`；Codex `codex-cli 0.144.1` 用 `codex app-server generate-ts` 在本地生成协议类型（89 个文件，不联网）。
- 两个版本都取自 main `c134de2` 干净 `npm ci` 后的 `node_modules`，所以和应用实际运行的版本一致。
- 本机全局安装的 CLI 版本更新（Codex 0.162.1、Claude Code 2.1.299），字段可能已经变化，**需要另做兼容核对**。

## 矩阵

| 能力 | Claude Code（Agent SDK 0.3.150） | Codex（app-server 0.144.1） | Kimi（ACP） | DeepSeek API |
| --- | --- | --- | --- | --- |
| 单次用量 | `result.usage` + `modelUsage[model]`（输入、输出、cache 读写 token） | 推送 `thread/tokenUsage/updated`，含 `total` / `last`（含 cached、reasoning token） | 应用代码里没有任何用量字段，**未知** | API 响应里有 `usage`（待核） |
| 金额 | `total_cost_usd`、`modelUsage.costUSD`。订阅用户拿到的是按 API 价格的**估算值**，不是实际扣费 | 没有逐次金额；有 `credits.balance`（字符串）和 `individualLimit {limit, used, remainingPercent, resetsAt}` | 未知 | 按 token 和公开价格估算，余额接口待核 |
| 订阅窗口 | `rate_limit_event`：`status`、`utilization`、`resetsAt`、`rateLimitType`（five_hour、seven_day、各模型、overage）。**只在状态变化时推送**，不能主动查询 | `account/rateLimits/read` 可主动查询，并推送 `account/rateLimits/updated`：primary/secondary 两个窗口的 `usedPercent`、`windowDurationMins`、`resetsAt` | 未知 | 不适用（按量付费） |
| 硬上限 | `maxBudgetUsd`：超出后以 `error_max_budget_usd` 结束；`taskBudget`（alpha）让模型知道剩余 token，属于软约束 | **没有**服务端预算参数；只能由应用看到 tokenUsage 后发 interrupt，最多会多花一个 turn | 未知 | 只能限制 `max_tokens`，靠应用累计 |
| 取消 | interrupt | `turn/interrupt` | 现有 adapter 已支持停止 | 断开请求 |
| 应用现状（`c134de2`） | **全部未接**：全库没有 `total_cost_usd` / `rate_limit_event` / `modelUsage` 的读取 | **全部未接**：没有 `tokenUsage` / `rateLimits` 的读取 | — | — |

应用侧的 `attempt.tokenCost` 在 `electron/worker-scheduler.ts:3232, 3337` 被写死为 `null`。所以 `task-budget.ts` 的 token 预算即使从无限改成有限值，也**永远不会触发**。这是 B06/B19 的第一个实际缺口。

## 对规格的影响

1. **「不把不同单位硬加」可以做到。** Claude 的单位是估算美元加窗口利用率，Codex 的单位是窗口百分比加 credits。两者都应各自记账，与架构 11 的 ServicePool 设计一致。
2. **「订阅剩余」只能是百分比和重置时间，拿不到绝对额度。** Claude 的窗口信息是被动推送：会话开始前读不到，必须先跑一次才知道。项目周额度如果按「订阅窗口」分配，只能分配百分比，没有绝对量，UI 必须标成估算。
3. **精确强制上限目前只有 Claude 的 `maxBudgetUsd`。** 而且它对订阅用户是按 API 价格估算的美元，不是真实扣费。Codex 只能事后中断，会超出一个 turn。规格里的「精确强制能力须在对应适配器验证」，结论是：**两家都不能保证零超支**，在途预留必须按「单 turn 最大消耗」保守留出。
4. **Kimi 和 DeepSeek 需要另外核查。** 首发如果把 Kimi 作为执行服务，先要确认 ACP 能不能拿到用量；拿不到的话，只能按估算加时间限制，并在 UI 上标为未知。

## 建议的最小切片（B06 → B19 的前置）

1. 在 Claude/Codex adapter 中读取上表的用量和窗口信号，写入 Run/Attempt 的 `usage { unit, reported|estimated, … }`，替换写死的 `tokenCost: null`。
2. 在 Codex 会话启动前调用 `account/rateLimits/read`，作为服务池的初始观测值；Claude 则在首个 `rate_limit_event` 到达前标记为「未知」。
3. 用两个 fixture（脱敏的真实事件样本）写确定性测试，验证预算跨越阈值时停止派发新 attempt。真实付费冒烟单独列预算，经用户授权后再跑。

## 待核

- 全局新版 CLI（Codex 0.162.1 / Claude Code 2.1.299）的字段是否变化；是否要升级固定版本。
- Kimi ACP 是否有用量通知；DeepSeek 的余额接口和计价。
- `total_cost_usd` 对订阅用户的含义：以官方文档为准，不凭推断写进 UI 文案。
