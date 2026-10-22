# B03 · 项目、任务、阶段、决定和证据契约（草案 v0）

日期：2026-10-22。状态：**评审草案，未改代码**。基线 main `c134de2`。
依据：规格 10、架构 11「领域对象与状态建议」、决策 09（D23、D25–D27、D58、看板阶段规则）、WBS 12 的 B03 验收：「对象身份、版本和命令事件样例明确；阶段与细分状态、旧数据映射可评审」。

本文件只定义契约，不选存储引擎（B08），不选运行底座（B04）。

## 1. 现有代码里已经有的东西

| 现有 | 位置 | 能直接用 | 和架构 11 的差距 |
| --- | --- | --- | --- |
| 会议事件日志 | `meeting-repository.ts:10` `PersistedMeetingEvent {id, seq, ts, meetingId, type, payload}` | 追加写、快照、`replayAfter`、崩溃 tmp 清理、大小上限 | 没有 schemaVersion、projectId、aggregateId、revision、actor/device、causationId；身份是 meeting，不是 project |
| 任务记录 | `task-collaboration.ts:297` `meetingTaskRecordSchema` | 15 种状态、planVersion、attempts、grant 与 attempt 的一致性校验 | 任务属于会议；没有父子关系、五大阶段、交付终点、来源 Issue |
| 授权 | `task-collaboration.ts:124` `taskAuthorityGrantSchema` | 绑定 taskId + attempt + planVersion + 请求 hash，有过期时间 | 按 attempt 授权；没有项目级「完全访问」和阶段确认的区分（D58） |
| Attempt | `task-collaboration.ts:237` `taskAttemptRecordSchema` | backendId、baseRevision、candidateCommit、verification、reviewCoverage | 用量只有一个整数 `tokenCost`（见 `../b06-quota/WIRING.md`） |
| 项目身份 | `transcript-store.ts:4` `projectId = sha1(realpath(cwd))` | — | **按路径算**。同一仓库在 Mac 和 N5095 上路径不同，ID 就不同；搬目录 ID 也会变。和「路径只是设备本地映射」冲突 |
| 交付接受 | `orchestrator.ts:2700-2736` `meeting-delivery-accepted` / `delivery-user-accepted` / `delivery-user-returned` | 已经区分 Coordinator 接受和用户接受 | 旧数据里只有 `accepted` 状态的任务，不能确定用户是否接受过 |

结论：**保留 MeetingRepository 的写入、快照和恢复机制，在外面套一层新信封**，不要整库重写（与架构 11「兼容旧日志而非整库重写」一致）。

## 2. 对象身份与版本

所有 ID 用 UUID v7（按时间排序，便于日志浏览），不含设备路径。

| 对象 | ID | 版本字段 | 不可变部分 | 说明 |
| --- | --- | --- | --- | --- |
| Project | `prj_<uuid>` | `revision` | 创建时的仓库身份 | 仓库身份 = GitHub `owner/repo` + 初始 commit；没有远端时用初始 commit。设备路径另存 `ProjectMount {projectId, deviceId, path}` |
| WorkItem | `wi_<uuid>` | `revision` | 来源（Issue/Story/WBS 编号） | 父子用 `parentId`；职能视图只是投影，不复制 WorkItem |
| StagePlan | `sp_<uuid>` | `version`（整数，从 1 开始） | **每个版本整体不可变** | 修改就产生新版本；确认针对 `(planId, version, contentHash)` |
| Meeting | `mtg_<uuid>` | — | — | 沿用现有 meetingId；会议结束不影响 WorkItem |
| Utterance | `utt_<uuid>` | — | 原始文字、说话人、时间 | 改写只能追加更正，不覆盖原话 |
| Decision | `dec_<uuid>` | — | 提案 hash、批准人、时间 | 三类分开：`stage-confirm`、`action-grant`、`delivery-accept` |
| Grant | `grt_<uuid>` | — | 范围、模式（default / full-access）、有效期 | 撤销是新事件，不改原记录 |
| Run | `run_<uuid>` | — | WorkItem、设备、源 revision、授权版本、插件版本 | 对应现有「任务的一次执行」 |
| Attempt | `(runId, n)` | — | backend、会话、baseRevision | 沿用现有 attempt 序号语义 |
| Evidence | `evd_<uuid>` | — | candidate revision、输入 hash、日志 hash | |
| ServicePool / Allocation | `pool_<uuid>` / `alloc_<uuid>` | `revision` | 单位 | B19 细化；本文只占位 |

**为什么 StagePlan 用整数版本、其他用 revision**：计划版本要给用户看（「确认第 3 版计划」），也要被 Grant 引用；revision 只用于乐观并发控制，不给用户看。

## 3. 事件信封 v2

```ts
interface DomainEventV2<T = unknown> {
  schemaVersion: 2;
  id: string;               // 事件 UUID，去重用
  type: string;             // 'work-item.created' 这类点分命名
  projectId: string;
  aggregateType: 'project' | 'work-item' | 'stage-plan' | 'meeting' | 'decision' | 'run' | 'pool';
  aggregateId: string;
  aggregateRevision: number; // 写入后的 revision；同一聚合内严格 +1，用于检测乱序和丢失
  actor: { kind: 'user' | 'host' | 'worker' | 'system'; id: string };
  deviceId: string;
  causationId?: string;      // 触发它的命令或事件 ID
  correlationId?: string;    // 同一次用户请求链
  seq: number;               // 本地日志序号（沿用 MeetingRepository 的 seq）
  ts: number;                // 仅供展示；不能单独用来裁决先后
  payload: T;
}
```

- **去重**：按 `id`。**乱序 / 缺页**：同一 `aggregateId` 的 `aggregateRevision` 不连续时，暂停应用该聚合并请求补取（多设备场景）。
- **旧日志兼容**：读取时，没有 `schemaVersion` 的行按 v1 处理，由适配函数包装成 v2：`projectId` 取会议所属项目（见 §6 迁移），`aggregateType = 'meeting'`，`actor.kind = 'system'`，`deviceId = 'legacy-local'`。**不改写旧文件。**
- **存放位置**：先沿用每个会议一个目录的布局，项目级事件（不属于任何会议）放 `projects/<projectId>/` 下同样格式的日志。存储引擎由 B08 决定，信封格式不依赖引擎。

## 4. 命令 → 事件样例

命令由应用服务校验后，产生一个或多个事件。命令本身不持久化，事件通过 `causationId` 指回命令。

### 4.1 用户在会议里确认阶段计划

```jsonc
// 命令
{ "type": "ConfirmStagePlan", "commandId": "cmd_01", "actor": {"kind":"user","id":"u_shawn"},
  "planId": "sp_7a", "version": 3, "contentHash": "sha256:9f…", "utteranceId": "utt_44" }

// 产生的事件
{ "type": "decision.recorded", "aggregateType": "decision", "aggregateId": "dec_12", "aggregateRevision": 1,
  "causationId": "cmd_01",
  "payload": { "kind": "stage-confirm", "planId": "sp_7a", "planVersion": 3, "contentHash": "sha256:9f…",
               "evidence": { "utteranceId": "utt_44" } } }
{ "type": "work-item.stage-changed", "aggregateType": "work-item", "aggregateId": "wi_3", "aggregateRevision": 8,
  "causationId": "cmd_01",
  "payload": { "from": "design", "to": "ready", "reason": { "decisionId": "dec_12" } } }
```

拒绝条件（命令被拒，不产生事件）：`version` 不是该计划的最新版本；`contentHash` 不符；该版本已被确认过。**这就是「旧批准拒绝」（B18）的落点。**

### 4.2 开始执行

```jsonc
{ "type": "StartRun", "commandId": "cmd_02", "actor": {"kind":"host","id":"host_main"},
  "workItemId": "wi_3", "planId": "sp_7a", "planVersion": 3, "deviceId": "dev_n5095", "backendId": "codex" }
// → run.created（含 sourceRevision、grantId、pluginVersions）
// → work-item.stage-changed  ready → running
// 被拒：没有与 planVersion 匹配的 stage-confirm 决定；没有有效 Grant；（B19 之后）预留失败
```

### 4.3 Attempt 结束并提交成果

```jsonc
// → run.attempt-finished   { attempt: 1, backendSessionId, usage: {...见 B06 WIRING}, candidateRevision }
// → evidence.recorded      { runId, attempt: 1, candidateRevision, checks: [...], logSha256 }
// → work-item.stage-changed  running → testing   （进入独立复核）
```

### 4.4 用户接受

```jsonc
{ "type": "AcceptDelivery", "workItemId": "wi_3", "evidenceIds": ["evd_9"], "utteranceId": "utt_80" }
// → decision.recorded  { kind: "delivery-accept", evidenceIds, candidateRevision }
// → work-item.substatus-changed  testing/awaiting-accept → testing/accepted
// 只有达到约定终点（方案验收 / 已合并 / 已发布）才会再有：
// → work-item.stage-changed  testing → done   { endpoint: "merged", mergeCommit: "…" }
```

## 5. 五大阶段与细分状态

产品已定的五列：**待设计 → 待执行 → 执行中 → 测试中 → 已完成**（决策 09「看板阶段与细分状态」）。

契约里 `stage` 只有这五个值；其他状态都是 `substatus`，并记录它属于哪个阶段。

| stage | 代码值 | 允许的 substatus |
| --- | --- | --- |
| 待设计 | `design` | `grilling`、`awaiting-confirm`、`blocked` |
| 待执行 | `ready` | `queued`、`awaiting-budget`、`blocked` |
| 执行中 | `running` | `active`、`reworking`、`paused`、`interrupted`、`failed`、`unknown`、`blocked` |
| 测试中 | `testing` | `verifying`、`reviewing`、`awaiting-accept`、`accepted`、`integrating`、`integration-conflict`、`returned` |
| 已完成 | `done` | `plan-accepted`、`committed`、`merged`、`released` |

另有一个**不在五列里的终态** `cancelled`（看板默认隐藏），见 §7 Q3。

### 现有 15 种状态 → 新契约

| 现有 `MeetingTaskStatus` | stage / substatus | 备注 |
| --- | --- | --- |
| `draft` | design / awaiting-confirm | |
| `pending` | ready / queued | |
| `running` | running / active | |
| `reworking` | running / reworking | |
| `budget-paused` | running / paused | 暂停原因从 `budgetPauseReason` 带过来 |
| `interrupted` | running / interrupted | |
| `failed` | running / failed | 阶段停在执行中，不推进 |
| `blocked` | **保留原阶段** / blocked | 需要从事件里找它之前的阶段；找不到就放 running |
| `verifying` | testing / verifying | |
| `coordinator-reviewing` | testing / reviewing | |
| `integration-queued` | testing / integrating | |
| `integrating` | testing / integrating | |
| `integration-conflict` | testing / integration-conflict | |
| `accepted` | **testing / awaiting-accept**，除非有用户接受事件 | 见下 |
| `cancelled` | cancelled | |

**`accepted` 的迁移规则**：现有 `accepted` 是 Coordinator 接受，不等于用户接受（架构 11：「不能将旧 completed 直接转成新用户已接受」）。迁移时：

- 日志里有 `delivery-user-accepted` 事件 → testing / accepted；如果还有集成 commit 证据 → done / merged。
- 没有 → testing / awaiting-accept，看板上显示为「待你确认（历史任务）」。

## 6. 旧数据迁移

1. **项目身份**：首次启动新版时，为每个出现过的 `realpath(cwd)` 创建 Project（仓库身份按 §2 规则计算），写 `ProjectMount`。旧 `sha1(realpath)` 保存为 `legacyIds`，`transcript-store` 读旧文件时通过它查找。两个路径指向同一仓库时，合并成一个 Project，两个 mount。
2. **会议 → 项目**：会议按其 cwd 归到对应 Project。没有 cwd 的会议归入一个「未归类」项目，不猜测。
3. **任务 → WorkItem**：一个 `MeetingTaskRecord` 对应一个 WorkItem + 一个 Run；attempts 原样带过去。`deps` 转成 WorkItem 之间的依赖，不转成父子。
4. **授权**：旧的 `taskAuthorityGrant` 迁移为 `action-grant` 类 Decision + Grant，标记 `legacy: true`；**不会**产生 stage-confirm 决定，所以迁移来的在途任务继续执行没问题，但要开新阶段时必须重新确认。
5. **方式**：只读旧日志、写新投影；保留旧目录；迁移本身是一个带 `schemaVersion` 的事件（`migration.applied`），重复运行时发现已存在就跳过；回退 = 删除新投影，旧数据没动过。

## 7. 待定问题

| # | 问题 | 建议 | 谁定 |
| --- | --- | --- | --- |
| Q1 | 仓库身份没有远端、也没有 commit 的空目录怎么算 | 用随机 ID，并在 `.ahastudio/project.json` 里写下这个 ID（会进 Git） | 技术评审 |
| Q2 | `.ahastudio/project.json` 是否允许写入用户仓库 | 建议允许，这是跨设备识别同一项目的唯一可靠办法；不允许的话，只能让用户在第二台设备上手动关联 | **产品负责人** |
| Q3 | 已取消的任务放在哪一列 | 不放进五列，作为过滤项 | **产品负责人** |
| Q4 | `blocked` 在旧数据里找不到原阶段 | 放 running / blocked，并在详情里标「阶段由迁移推断」 | 技术评审 |
| Q5 | 父任务的阶段如何由子任务汇总 | 父任务阶段 = 必需子任务里最靠前的阶段；全部 done 后，父任务还需要整体验证和用户接受才能 done（Q09） | 产品负责人确认 |
| Q6 | Decision 的 `stage-confirm` 是否要求语音原话证据 | 要求有 `utteranceId` 或界面点击记录二选一；纯模型转述不算 | 产品负责人确认 |

## 8. 下一步

1. 评审本文 §2–§5（对象身份、信封、阶段表）。
2. 评审通过后，把 §3 信封和 §5 状态表写成 zod schema，放到 `electron/domain/`，只有类型和纯函数，配套确定性测试：旧状态映射、`accepted` 迁移规则、revision 连续性检测、过期确认拒绝。
3. B08 接着做持久化和迁移；B07 原型可以直接用 §5 的表画看板。
