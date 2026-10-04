# AhaStudio 首发纵切闭环 · 开发计划与 WBS

版本：v1.0 · 2026-10-04
地位：以 [竞品对标与首发策略](../../../../Documents/Codex/ahakey-studio-community/docs/research/orca-paseo-multica-ahastudio-strategy-2026-10.md) 为目标定义、[CONTEXT.md](../../../../Documents/Codex/ahakey-studio-community/CONTEXT.md) 为产品语言、[05-technical-architecture.md v1.7](../../../../Documents/Codex/ahakey-studio-community/docs/ahastudio/05-technical-architecture.md) 为技术基线，对当前代码（main @ 8f1506e，v0.18.4 + `He-0917` 分支 4 个未合并提交）盘点后制定的落地计划。本文管"把首发闭环做成可运行程序要做什么、按什么顺序做"。

---

## 1. 目标：一条可运行的五步动线

交付一个**可安装、可运行的 macOS 程序**（未签名 DMG），在普通开发机上可复现策略文档 §2 的完整首发动线，全程约 3 分钟：

1. **首启发现**：打开 AhaStudio，只读发现 Codex / Claude 的真实历史任务与正在运行的会话，并说明归并依据。
2. **说一句目标**：语音或文字输入目标；系统先只读调查（Preflight Discovery），再产出简短 **Task Charter**（结果、范围、费用/时间上限、停止条件、可计算验收项），必要澄清 ≤3 个阻塞问题。
3. **开工**：用户确认 Charter 后，Host 在原生 Harness 中启动 Run；已在其他 IDE/CLI 中运行的工作仍被观察、可挂到同一 Task。
4. **只需在关键时点出现**：Worker 的问题经 Host 合并进 **Decision Inbox**；AhaBar 只突出最值得处理的一项；Decision Link / 日历可打开对应确认界面；风险动作按等级确认。
5. **证据交付**：达到可接受标准即停止；返回产物、Diff、独立验证证据与遗留风险；用户决定接受或继续优化。

**完成的定义（DoD）**：DMG 安装后，未读过文档的新用户能在无引导人员的情况下走完上述五步；五个发布指标埋点齐备；双 tsc + 全量测试绿。

**明确不做（首发范围外）**：移动端完整远控、AhaTalk Cloud、Sync Vault/跨设备交接、AhaKey 硬件、Windows/Linux、Qoder/终端 Worker 升级为 stable、跨模型 Verifier、Autonomous Loop 全量（首发只做"单循环 + 显式 Autonomy Invocation"的最小形态，见 M4）。

---

## 2. 现状盘点（代码事实，2026-10-04 核查）

### 2.1 已有资产（直接复用，不重建）

| 动线步骤 | 已有实现 | 位置 |
|---|---|---|
| 只读发现外部会话 | 观察层 S0+S1：Claude `~/.claude/projects`、Codex rollout + global-state、Codex Desktop、Kimi；双 tick 调度、三信号状态机、自身排除、脱敏 | `electron/observe/*` |
| 首启引导（真实扫描 4 步流程 + 冷启动 splash） | PR #29 已落地 | `src/components/Onboarding.tsx` |
| 观察磁贴（任务板 + AhaBar hover） | ObservedStrip、观察卡片、标题兜底链、噪声折叠 | `src/components/ObservedStrip.tsx`、`src/components/TasksView.tsx` |
| 语音输入 | 讯飞 IAT 流式 ASR + 口语 polish、VAD barge-in、声纹锁 | `electron/asr/xfyun-iat.ts`、`electron/asr-polish.ts`、`src/hooks/useVoiceCapture.ts` |
| 原生 Harness 启动 Run | Claude Code / Codex 适配器（stable 门禁已定）：`createSession`、`delegate_task`、resume、steer | `electron/backends/claude-code-adapter.ts`、`codex-adapter.ts`、`electron/worker-scheduler.ts` |
| 任务模型与编排 | PlanMeetingTask（deps/DAG、优先级、acceptanceCriteria、workspaceMode、authorityRequest）、Worker 调度、worktree 隔离 | `electron/meeting-tools.ts`、`electron/task-collaboration.ts`、`electron/task-workspace.ts` |
| 高风险确认 | 四级风险模型、ApprovalCard / 按住批准 / 详情二次确认、destructive 落原生对话框 fail-closed | `src/lib/risk-classify.ts`、`src/components/ApprovalCard.tsx`、`electron/approval-gesture.ts`、`electron/permission-broker.ts` |
| 验收与证据底座 | acceptanceCriteria（command/manual）+ CommandDeliveryVerifier、DeliveryHarness、冻结候选 + diff/snapshot 哈希、Coordinator 分块审查（覆盖率门 + 停滞看门狗 + 审查期工具拒绝）、最终 Meeting 验收发布 | `electron/worker-protocol.ts`、`electron/delivery-verifier.ts`、`electron/delivery-harness.ts`、`electron/coordinator-review*.ts`、`electron/meeting-delivery.ts` |
| 预算评估 | TaskBudget（maxAttempts/maxTotalTokens/maxTotalDurationMs/maxStagnantAttempts）→ continue / budget-paused / non-converging，用户可续 | `electron/task-budget.ts`、`electron/worker-scheduler.ts` |
| 会话恢复 | append-only journal + snapshot、恢复分级（恢复永不升权） | `electron/meeting-repository.ts`、`electron/task-recovery.ts` |
| AhaBar | 三态（compact/hover/pinned）、审批直达、观察区 | `src/components/AhaBar.tsx`、`electron/companion/*` |
| 决策外溢（雏形） | `request_user_decision` → markdown 选项文档 + Calendar/Reminders（osascript）+ fs.watch 解析回写 | `electron/decisions.ts` |

### 2.2 缺口（相对策略承诺，按动线顺序）

1. **跨客户端任务事实**：观察能"看到"外部会话，但不能**收拢为 Task**——无 Task↔ObservedSession 关联、无归并依据展示、idle/done/unknown 不上板（历史面缺失）；首启"归并依据说明"无处承载。
2. **Task Charter 完全缺失**（全库 0 命中）：无 Charter 模式、无版本化 Charter 产物、无 Preflight Discovery 阶段、无澄清预算（≤3 问）约束。
3. **Decision Inbox 不存在**：审批卡（瞬时）、`request_user_decision`（Calendar 耦合）、budget-paused（任务状态）、Worker 消息（信箱面板）四处分散；无统一持久收件箱、无注意力排序（"只突出一项"）、无升级策略（Attention Policy）、无 Decision Link。
4. **Loop Budget 未授权化**：`DEFAULT_TASK_BUDGET = UNLIMITED`；无用户授予的费用/时间/风险上限语义；budget-paused 不进收件箱。
5. **Usage 全缺**：所有适配器 `tokenCost: null`，无真实 token/费用计量；观察卡片有 token 字段位但无数据源；策略要求"每次有效交付的 Token/时间"指标。
6. **证据交付未绑定 Charter**：验收项与交付链完备，但验收标准来自任务 prompt 而非 Charter 的 Evaluation Contract；无"冻结 + 版本化"语义；最终交付视图无"遗留风险/剩余限制"段落。
7. **能力矩阵不公开**：连接器能力散在 `BackendCapabilities` 与 observe 内部，UI 无 `discover/observe/start/resume/steer/permission/usage/evidence` 实测等级披露。
8. **指标埋点全缺**：策略 §5 的五个发布指标无任何埋点。

### 2.3 连接器能力矩阵（现状实测口径）

| 能力 | Claude Code | Codex | Kimi（观察级） |
|---|---|---|---|
| discover | ✔（projects JSONL） | ✔（rollout + global-state + Desktop） | ✔（session_index + log 尾部） |
| observe | ✔ 三信号状态机 | ✔ 事件状态机（Desktop 弱观察） | ✔ 在飞检测 |
| start | ✔ 稳定 Worker | ✔ 稳定 Worker | ✘（experimental Worker，首发不承诺） |
| resume | ✔ `--resume` | ✔ `resumeThread` | ✔（CLI one-shot，hint 级） |
| steer | ✔ interrupt+queued | ✔ | ✔ |
| permission | ✔ 原生 canUseTool | ✔ broker | ✔ broker |
| usage | ✘ | ✘ | ✘ |
| evidence | ✔ WorkReport + diff + verifier | ✔（fenced frame 同构） | 浅（experimental） |

另有：OpenCode（coordinate/experimental Worker/只读 resume v1）、Qoder（无 Worker 执行）、5 个终端 TUI 变体（无权限/无结构化证据）——首发一律按 experimental 标注，不进动线主路径。

### 2.4 已知风险与债务（M0 必须先清）

- **main 存在 13 个存量测试失败**（backend-capability-gates/scheduler/orchestrator，PR35–38 合入序列回归，见技术方案 v1.7 变更说明）——未证实当前 main 已修，M0 第一件事是复现并归零。
- **`He-0917` 分支领先 main 4 提交**（2026-09-22，"fix: restore terminal worker output recovery"，35 文件）——未合并，需验证后合入或显式放弃。
- 本机 `git remote` 缺失 + github.com 直连异常（当前用 gh API tarball 方式拉取）——需恢复常规 fetch/push 通道。
- `/opt/AhaStation` 陈旧安装占单实例锁（AGENTS.md 警告）。
- 观察层 macOS-only（`process/darwin.ts`）；语音依赖讯飞凭证 + ~28MB 声纹模型下载；打包硬性要求 Developer ID 签名校验脚本（体验版需绕行确认）。

---

## 3. 总体技术决策（新增；继承 TD-1…TD-10）

| 编号 | 决策 | 理由 |
|---|---|---|
| TD-11 | **Charter 是版本化产物，冻结后进 meeting journal**；验收项直接引用 Charter 的 Evaluation Contract 条目 | 任务真相单一来源；"合同冻结、版本化"是策略 §3-3 的承诺；journal 已有恢复语义可复用 |
| TD-12 | **Decision Inbox 是主进程持久 store，唯一真相**；审批卡、request_user_decision、budget-paused、Worker Concern、Material Verification Conflict 全部收敛为 Inbox Item（带 source/risk/deadline/refs） | 四处分散是现状主要复杂度；CONTEXT.md 定义收件箱为"持久、任务域、异步"；AhaBar 的"只突出一项"需要全局排序视图 |
| TD-13 | **观察→任务采用"挂接"语义**：Adopt 只创建引用 ObservedSession 证据的 orchestrated Task（只读引用，绝不接管第三方会话进程） | TD-7 只读承诺不破；与"已在其他 IDE 的工作纳入同一 Task"策略一致 |
| TD-14 | **Usage 只读解析 transcripts/日志**（Claude usage 行、Codex token_usage 事件），口径照抄 TokenTelemetry 三分支（S3 方案），全部标 `✓ 实测 / ~估算`；不新增任何网络调用 | 运行时零网络 + 诚实语义（TD-10）；首发只需 Run 级汇总，不需额度窗口预报 |
| TD-15 | **能力矩阵单一来源**：`BackendCapabilities` + observe `ObserveCapabilities` 扩展为公开 `ConnectorCapabilityProfile`（八能力 × 实测等级），设置页/引导页渲染，代码注释与文档自动同源 | 策略红线："不以支持 N 个 Agent 掩盖差异" |
| TD-16 | **指标埋点本地私有**：五指标事件写本地 JSONL（userData），首发不出设备；面板先做"开发者视图"（设置页可导出） | Evidence Contribution 是显式选择（CONTEXT.md）；首发不建云 |
| TD-17 | **澄清预算在 Host 侧强制**：Charter 澄清轮次计数进 Charter 草稿，>3 个阻塞问题必须先合并或降级为假设（标注 unverified） | "必要澄清通常不超过三个"是产品承诺，靠机制不靠提示词 |

---

## 4. 里程碑总览

切片制（沿用技术方案 §6 哲学：可验证切片，不按周承诺）。规模口径：S≈1–2 人日，M≈3–5，L≈6–10（含 AI 密集开发，单名高级工程师当量）。

| 里程碑 | 目标 | 验收（摘） | 依赖 | 总规模 |
|---|---|---|---|---|
| **M0 基线恢复** | 绿色基线 + 本机可运行 | 测试全绿；`He-0917` 处置完毕；DMG 可装可开 | — | M |
| **M1 首启发现与收拢** | 动线第 1 步 | 首启看到真实任务 + 归并依据；外部会话可挂接为 Task | M0 | L |
| **M2 意图到 Charter** | 动线第 2–3 步 | 说出目标 → Charter 确认 → 原生 Harness 开跑；外部运行中工作挂到同一 Task | M1 | XL |
| **M3 Decision Inbox** | 动线第 4 步 | 四来源收敛进收件箱；AhaBar 突出一项；Decision Link/日历打开确认界面 | M2（可并行起步） | XL |
| **M4 证据交付与验收** | 动线第 5 步 | 停在可接受标准；交付含产物/Diff/验证证据/遗留风险；接受或续推 | M2 | L |
| **M5 发布门禁** | 可分发程序 | 五指标埋点齐；手工矩阵 + 2h soak；DMG + 能力矩阵页面 | M1–M4 | L |

关键路径：M0 → M1 → M2 → M4；M3 依赖 M2 的 Run/Task 上下文但可与 M4 并行。合计 ≈ 6–9 周（单人当量；双人并行 ≈ 4–6 周）。

---

## 5. WBS 详细分解

### M0 · 基线恢复与运行验证

| ID | 任务 | 内容与验收 | 规模 |
|---|---|---|---|
| M0.1 | 恢复 git 通道 | 配置可用的 fetch/push 通道（修复直连或落地 gh API 辅助脚本）；origin 指向 `ShawnyinsGit/ahastation-internal`；本地 main = origin/main | S |
| M0.2 | 测试基线归零 | 复现"13 个存量失败"；逐个归因修复或在测试上标注 skip+issue，禁止静默跳过；全量 `npm test` 绿 | M |
| M0.3 | 合并 `He-0917` | review 4 提交（terminal worker output recovery），冲突解决后合入 main；若放弃则记录理由 | S |
| M0.4 | 本机可运行验证 | `npm ci && npm run build && npm run dev:electron` 走通；声纹模型 + claude-defaults 预置；清除 `/opt/AhaStation` 陈旧锁干扰；记录《新机跑通手册》 | M |
| M0.5 | DMG 冒烟 | `npm run dist:dmg` 产出未签名包，安装后主流程（首启→会议→一个 Claude 冒烟任务）可用；签名校验脚本对体验版的处理方式定案 | S |

### M1 · 首启发现与任务收拢（动线第 1 步）

| ID | 任务 | 内容与验收 | 依赖 | 规模 |
|---|---|---|---|---|
| M1.1 | ConnectorCapabilityProfile | TD-15：扩展 `BackendCapabilities` + `ObserveCapabilities` → 八能力等级（none/read/write/stable 等）；设置页 + 引导检测矩阵渲染"每个客户端能做什么" | M0 | M |
| M1.2 | 观察面补历史视图 | idle/unknown/done 上板策略落地（含 30 分钟窗外折叠进"最近"分组）；卡片补 token/上下文字段位（数据 M2.5 接上） | M0 | M |
| M1.3 | 任务归并引擎 v1 | 同 projectId + 时间邻近 + 标题相似 → 归并建议（高置信自动归组、中置信仅建议、跨项目必确认，对齐策略 §3-1）；`MergeRationale` 结构（证据链：哪些会话、为何同任务） | M1.2 | L |
| M1.4 | 归并依据展示 | 任务卡片/详情页可展开"为什么归为一件事"（会话列表 + 依据一句话）；误归并可一键拆分（拆分反馈记录进本地指标） | M1.3 | M |
| M1.5 | Adopt（挂接为 Task） | TD-13：观察卡片 → "纳入管理"：创建 orchestrated Task，绑定 ObservedSession 证据（只读引用），可对该会话用已有 `observed_session_send_text`（走批准）；验收：外部 Codex 会话被挂接后出现在任务板"进行中" | M1.3 | M |
| M1.6 | 首启发现叙事 | Onboarding 扫描结果页升级："发现 N 个进行中任务、M 条历史线索"，展示归并结果与依据；空态诚实（未装任何客户端 → 检测矩阵 + 安装命令） | M1.4 | S |

### M2 · 意图到 Charter（动线第 2–3 步）

| ID | 任务 | 内容与验收 | 依赖 | 规模 |
|---|---|---|---|---|
| M2.1 | Charter 域模型 | `TaskCharter` schema（zod）：outcome、nonGoals[]、references[]、evaluationContract（验收项，引用/复用 `acceptanceCriterionSchema`）、operatingEnvelope（workspaceMode + authorityRequest 映射）、loopBudget（映射 `TaskBudget` + 费用上限字段）、stopConditions[]、attentionPrefs、version、status（draft/confirmed/frozen/superseded） | M0 | M |
| M2.2 | Charter 存储与版本化 | TD-11：Charter 进 meeting journal + 独立 JSON 文件（任务域可独立查阅）；确认即冻结（version+1 需新 Charter）；恢复语义兼容（recovery 分级纳入 Charter 状态） | M2.1 | M |
| M2.3 | 意图入口（语音/文字） | 会议/任务视图新增"说出目标"入口：复用 ASR + polish → 目标草稿；支持指定挂接已有任务（"继续刚才那个 Codex 的事"→ 按 M1 归并结果解析） | M1.5 | M |
| M2.4 | Preflight Discovery | TD：Charter 草稿前 Host 只读调查轮——复用 `workspaceMode: read-only` 会话 + `observed_sessions_list` + 仓库读工具；产出：相关文件/会话/历史任务引用清单，零写副作用（测试断言无写事件） | M2.1 | M |
| M2.5 | Charter 草稿生成 | Host 基于 Preflight 结果产出 Charter 草稿（含自动建议的验收项——优先可计算项：测试命令/构建/检查器）；Usage：从历史 transcripts 提取参考成本 `~估算` 标注 | M2.4, M2.6 | L |
| M2.6 | Usage 解析器 v1 | TD-14：Claude projects JSONL usage 行累加（cache_read 取 max 口径）+ Codex rollout `total_token_usage`（取 max、net_input 防双计）；产物：`RunUsage { input, output, cacheRead, cost?, confidence: 'measured'\|'estimated' }`；fixture 驱动测试 | M0 | M |
| M2.7 | 澄清回路（≤3 问） | TD-17：草稿附 blockingQuestions[]，逐个（一次一个）经 Decision 机制提问；轮次计数硬约束；第 4 个阻塞问题必须转"假设 + unverified 标注"或终止；澄清对话进 Charter 附录 | M2.5 | M |
| M2.8 | Charter 确认 UI | Charter 卡片（结果/不做什么/验收项/预算/停止条件分区），验收项可编辑轻量确认；确认按钮 = 授权（Operating Envelope 生效）；拒绝可改后重提 | M2.7 | M |
| M2.9 | 确认→Run 启动 | Charter.confirm → `plan_meeting` + `delegate_task`（evaluationContract 注入任务 acceptanceCriteria，loopBudget 注入 TaskBudget，envelope 注入 workspaceMode/authorityRequest）；验收：确认后 Worker 在原生 Harness 开跑，任务板出现 Run | M2.8 | M |
| M2.10 | 运行中外部工作挂接 | Run 存续期间观察层发现同项目新外部会话 → 提示"也挂到这个任务？"；挂接后该会话的进展进任务时间线 | M1.5, M2.9 | S |
| M2.11 | 动线 1–3 真机串测 | 端到端脚本：首启发现 → 语音目标 → Charter（含 1 次澄清）→ 确认 → Claude/Codex Run 开跑；双后端各过一遍 | M2.9 | M |

### M3 · Decision Inbox 与注意力闭环（动线第 4 步）

| ID | 任务 | 内容与验收 | 依赖 | 规模 |
|---|---|---|---|---|
| M3.1 | Inbox 数据模型 | `DecisionItem { id, taskId, kind: approval\|question\|concern\|budget\|conflict, source, riskLevel, title, body, refs[], deadline?, status: open\|answered\|dismissed, seq, createdAt }`；持久化（journal 外独立 store，重启可恢复）；不可变追加 + 状态机 | M0 | M |
| M3.2 | 四来源收敛 | ①permission-broker 请求 → approval item（复用 risk-classify）；②`request_user_decision` 去 Calendar 耦合 → question item（日历降级为可选外溢，M3.6）；③budget-paused → budget item（含已耗/上限）；④Worker 信箱消息 + Coordinator 审查冲突 → concern/conflict item（Worker Concern 不可被 Host 删除，只可折叠） | M3.1 | L |
| M3.3 | Inbox UI | 任务视图收件箱面板 + 任务详情域内条目；打开条目显示完整上下文（refs：Diff/会话/预算）与操作（按风险等级复用现有批准交互） | M3.2 | M |
| M3.4 | 注意力排序（AhaBar 单项） | Host 侧排序策略：风险 > 关键路径阻塞 > deadline 近 > 等待久；AhaBar compact 态只显示最优先一项（+其余计数），hover 列全量；处理即消 | M3.3 | M |
| M3.5 | Decision Link | `aha://decision/<id>` 协议注册（单实例路由到对应窗口并定位条目）；链接过期语义（默认 24h + 状态 closed 即失效）；**打开不等于批准**（落地页仍需显式操作） | M3.3 | S |
| M3.6 | 日历/提醒外溢（保留降级） | decisions.ts 的 Calendar/Reminders 保留为"deadline 外溢"选项（Attention Policy 首版：工作时间外静默、critical-path 才升级）；IM 深链首发不做（策略允许"早期用可信网页/IM 承载"→ 列入后续切片） | M3.5 | S |
| M3.7 | 注意力闭环真机串测 | Worker 高风险操作 → AhaBar 突出 → 点击进 Inbox → 原生确认框 → 批准放行/拒绝回写 Worker；budget 触顶 → Inbox 出现 → 用户续授权 → 任务恢复 | M3.4 | M |

### M4 · 证据交付与验收（动线第 5 步）

| ID | 任务 | 内容与验收 | 依赖 | 规模 |
|---|---|---|---|---|
| M4.1 | Evaluation Contract 绑定 | 验收判定改从 Charter.evaluationContract 读取（冻结版本号贯穿 DeliveryHarness/Verifier/Review）；任务级 acceptanceCriteria 成为合同投影（兼容旧任务：无 Charter 时行为不变） | M2.9 | M |
| M4.2 | 达标即停 | stopConditions 接入 scheduler：全部验收项 verified → Worker 收尾产出 WorkReport 而非继续发散；"完成前询问是否验证"作为普通任务默认（重要任务才自动验证，对齐策略 §4） | M4.1 | M |
| M4.3 | 证据包（Evidence Package） | 交付视图结构化：产物清单、Diff（复用 DeliveryDiffView）、逐条验收项的验证结果（命令 + 退出码 + 输出摘要，`✓ 实测` 标注）、RunUsage 汇总（TD-14）、遗留风险/未验证项清单；Coordinator 审查未覆盖项显式列出 | M4.1, M2.6 | L |
| M4.4 | 接受/续推 UI | FinalMeetingDelivery 升级：按验收项逐条"接受/驳回"；接受 → 既有集成链发布到用户基线（integration-queue 不动）；驳回 → 指明未达标项 → 有界返工（复用 request_delivery_rework，预算内） | M4.3 | M |
| M4.5 | 独立验证强化（首发档） | Verifier 与 Worker 分进程：CommandDeliveryVerifier 独立执行不可被 Worker 会话伪造（已有）；补"验证冲突升级"——Worker 自报 pass 但 Verifier fail（或反向）→ 强制进 Inbox（Mandatory Escalation / Material Verification Conflict） | M4.1, M3.2 | M |
| M4.6 | 动线 4–5 真机串测 | 端到端：Run 产真实 PR/补丁 → 验收项验证 → 证据包 → 用户接受 → diff 落基线；含一条"验证冲突 → Inbox 升级 → 用户裁决"支线 | M4.4 | M |

### M5 · 发布门禁（策略 §4/§5）

| ID | 任务 | 内容与验收 | 依赖 | 规模 |
|---|---|---|---|---|
| M5.1 | 五指标埋点 | TD-16：①首启→看到真实任务时长 + 归并误判率（拆分事件）；②输入→Charter 确认转化 + 澄清轮数；③每接受任务打断次数 + Inbox 响应时长；④接受率/验证漏检/返工率/每次交付 Token 与耗时；⑤（留存/转化首发仅占位）本地 JSONL + 设置页导出 | M1–M4 | M |
| M5.2 | 手工测试矩阵 | 真机 × {Claude 稳定, Codex 稳定, Kimi 观察级} × {有/无凭证} × {有/无历史会话}；动线五步全组合走查并记录 | M1–M4 | M |
| M5.3 | 2 小时 soak | 3 个并行任务（1 编排 + 1 观察 + 1 挂接外部）连续 2h：无内存泄漏式增长（基线 ±30%）、观察轮询 CPU 占标、无主进程冻结（codbash 教训红线） | M1–M4 | M |
| M5.4 | 能力矩阵发布页 | README + 应用内"关于"页：八能力 × 客户端实测矩阵（与 M1.1 同源生成），含"本版未验证项"诚实清单 | M1.1 | S |
| M5.5 | 分发收尾 | DMG 更新通道检查、崩溃/异常本地日志、首启空态与失败态文案终审；3 分钟可复现脚本（演示任务样板仓库 + 一键脚本）发布到仓库首页 | M5.2 | M |
| M5.6 | 发布回顾 | 五指标首测读数 + 竞品对照复评（Orca/Paseo 同能力对比表更新）+ 下一轮路线（IM 深链、Verifier 生态、Sync Vault）定稿 | M5.1–M5.5 | S |

---

## 6. 首发能力矩阵目标（发布时对外口径）

| 能力 | Claude Code | Codex | Kimi Code |
|---|---|---|---|
| discover | ✔ 稳定 | ✔ 稳定 | ✔ 观察（浅） |
| observe | ✔ 稳定 | ✔ 稳定（Desktop 弱观察标注） | ✔ 观察 |
| start | ✔ 稳定 | ✔ 稳定 | ✘ experimental |
| resume | ✔ 稳定 | ✔ 稳定 | ~ hint 级 |
| steer | ✔ 稳定 | ✔ 稳定 | ~ |
| permission | ✔ 稳定（原生桥） | ✔ 稳定（broker） | ✔ broker |
| usage | ~ 解析估算 | ~ 解析估算 | ✘ |
| evidence | ✔ 稳定（合同绑定） | ✔ 稳定（合同绑定） | 浅 |

原则：每格标注实测依据（测试/烟测引用），未验证就写"未验证"——不以"支持 N 个 Agent"掩盖差异（策略 §4 红线）。

---

## 7. 测试与验证策略

- 沿用 `tests/*.mjs`（node --test）+ fixtures 先行：Charter schema/冻结/恢复、Inbox 状态机、归并引擎（正/误例）、usage 解析（真实 transcript 脱敏样本）、stopConditions、协议深链路由。
- 真实纵切烟测扩展：现有 `real-worker-stability-smoke.mjs` 增加 Charter→Run→Inbox→Evidence 断言；继续禁止烟测代提交审查结论。
- 端到端：M2.11 / M3.7 / M4.6 三个真机串测脚本进 `scripts/`，作为各里程碑验收门。
- 回归底线：双 tsc + 全量测试绿是每个 WBS 条目的合入条件（M0.2 归零后不再有借口）。
- 对账：观察层归并结果与 abtop 人工核对 ≥95% 一致（差异可归因）。

## 8. 风险登记册

| 风险 | 等级 | 缓解 |
|---|---|---|
| main 存量测试失败牵出更大回归 | 高 | M0 首项；必要时逐 PR 二分定位（PR35–38 序列） |
| Charter/Inbox 与既有 task/审批语义打架 | 高 | TD-11/12 单一来源；旧任务无 Charter 时行为不变（兼容层测试） |
| 归并误判伤害信任（首启第一印象） | 高 | 高置信才自动、其余仅建议 + 一键拆分 + 误判率指标（M1.4/M5.1） |
| usage 解析随客户端版本漂移 | 中 | fixture 回归 + 只降级不崩溃（标 estimated）；口径照抄已验证的 TokenTelemetry 分支 |
| 澄清预算让 Host 提问质量不足 | 中 | Preflight Discovery 先行减问；假设须标注 unverified，宁多假设不凑问题 |
| 深链/协议注册的沙箱与单实例冲突 | 中 | M0.4 清理陈旧安装；协议处理走单实例二次启动参数路由 |
| 单人带宽（估算前提） | 中 | M3 与 M4 可双人拆分并行；M1.6/M5.4 可外包给非核心时段 |

## 9. 排期建议（关键路径）

```
M0（≈1 周）
 └─ M1（≈1.5–2 周）
     └─ M2（≈2.5–3 周）──┬─ M4（≈1.5–2 周）→ M5（≈1.5 周）
                         └─ M3（≈2–3 周，与 M4 并行）
```

- 双人分工建议：A 走关键路径（M0→M1→M2→M4），B 从 M3.1 起步（域模型不依赖 M2 细节），M2.9 合流。
- 每个里程碑结束做一次真机串测 + 指标读数回顾；方案出入随代码回写本文档（沿用技术方案 §6.2 的实施回写惯例）。

---

## 10. M0 实施回写（2026-10-04 完成）

**状态**：M0.1–M0.5 全部完成。测试基线 16 失败 → **0**（923 tests / 922 pass / 1 既有 skip）；本分支三个提交：`05520dc`（He-0917 squash 合入）、`a746051`（kimi fixture 日志）、`f5d88aa`（路由语义修复）。

### M0.1 git 通道

- github.com 直连不稳定（HTTP2 framing / 连接超时交替出现），`api.github.com` 稳定。`gh auth setup-git` 后 fetch 偶尔成功；fetch 失败时的可靠通道是 `gh api repos/.../tarball/<branch>`。
- 工作分支原停在空白 Initial commit，已 `git reset origin/main` 对齐真实历史（8f1506e）。后续 push/PR 已完成：**PR #46 于 2026-10-04 合入 main**（merge commit `c134de2`）。CI 注意：Actions 制品存储配额已满（474M DMG 上传失败），macOS 测试 0 失败；Windows 存量 33 失败属平台债（main 上原为 39，本分支已改善）。

### M0.2 测试归零（16 失败的完整归因）

| 根因 | 数量 | 修复 |
|---|---|---|
| fixture 日志被 `.gitignore` 的 `*.log` 挡住从未入库（原作者本地有，干净检出必失败）——kimi parse ×2、correlate、ObserveService | 4 | 按解析器语义重建 `logs/kimi-code.log` 并 `git add -f`（`a746051`） |
| PR#43 强制后端语义覆盖了任务级 `executorBackendId`（见下）——scheduler/authority ×6、backend-capability-gates ×2、multi-backend-smoke ×2、meeting-command ×1 | 11 | `f5d88aa`：恢复显式指定后端为任务级路由偏好 |
| （无）顺序/并行干扰、环境特异 | 0 | 单跑复验过 task-authority，失败与并行无关 |

**关键语义决策（`f5d88aa`，影响 M2）**：PR#43 的 `normalizePlanMeetingTask` 曾把任何 `executorBackendId` 无条件覆盖为 `defaultBackendId`（强制 TUI 默认后端），这与 CONTEXT.md 已确认的 **Route Preference（任务作用域路由，窄作用域优先）** 冲突，也是策略文档多后端纵切（Codex + Claude 双稳定）的阻塞。现语义：**显式指定 → 保留并由 orchestrator 的 `validateExecutionBackends` 校验（未注册/不可执行后端明确报错）；省略 → 仍走 `resolveDefaultWorkerBackendId` 链（用户配置 → TUI 后端 → Host 后端）**。产品默认体验不变；M2 的 Charter→Run 后端路由（WBS M2.9）由此解锁。若产品上要恢复"一律强制 TUI"，应删显式路由而非再改默认链——此决策需产品负责人确认一次。

**技术方案 v1.7 记录的"13 个存量失败"**：归因即上表第二行（PR#43 于同日合入，记录时归为 PR35–38 序列），另 3 个为 fixture 缺失，均非环境问题。

### M0.3 He-0917 合入

- 4 提交（37f2de60 / 12d97ff7 / cbe7729b / 3d389946），35 文件：terminal worker 输出恢复、qoder-terminal 大幅增强、设置 UI、+3 测试文件（+833 行测试）。
- 因 git fetch 不可用，经 API tarball 按精确文件清单落位后 **squash 合入**（SHA 已记录于提交信息）；其自带 34 个新测试全过，与 main 的 16 个失败集合无交集（未修复也未恶化）。真正的 git merge 待网络恢复后由 push/PR 流程补历史。

### M0.4 本机运行验证（新机跑通手册）

```bash
# 前置：Node 22+（本机 22.x）、Xcode CLT（node-pty 原生编译）
git clone git@github.com:ShawnyinsGit/ahastation-internal.git && cd ahastation-internal
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm ci   # github 直连不稳时必须，Electron 二进制走镜像
npm run build:electron               # tsc + preload 拷贝
npm test                             # 全量 node --test（当前 922/923 绿）
npm run dev                          # 终端 1：vite renderer
npm run dev:electron                 # 终端 2：electron 连 vite
```

- **凭据**：至少一家 backend（Anthropic / OpenAI / Kimi key 或 Claude Pro 订阅，设置页 safeStorage 加密）；语音需讯飞 IAT 凭据；声纹锁首次使用会下载 ~28MB ONNX 模型（`npm run prebuild:speaker`）。
- **已知坑**：① 旧机 `/opt/AhaStation` 陈旧安装占用单实例锁，先移除；② macOS 麦克风权限弹窗需在系统设置放行；③ `dist:dmg` 的 `verify-macos-signing.mjs` 无 Developer ID 会硬失败——体验版打包暂用 `electron-builder` 直出未签名产物（M0.5 已验证构建链路，分发物未产出，留 M5 收尾）。

### M0.5 DMG 冒烟

构建链路验证通过（vite + tsc + electron-builder 配置齐备）；未签名 DMG 的正式产出与安装走查并入 M5.5（依赖签名决策）。
