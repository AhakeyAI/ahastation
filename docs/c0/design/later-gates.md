# 门 B → F 工作包技术方案概要

日期：2026-10-23。状态：**方案概要，进入各门前再细化成实施卡**。覆盖 WBS 中 C0 与门 A 首批之外的全部工作包。会议（B11–B13）和跨设备（B27–B31）另有专门文档，这里不重复。
每节结构：现有资产 → 方案要点 → 关键风险 / 待定 → 进入实施前要先做的事。

---

## B09 插件宿主与内置能力接口

**现有**：没有插件宿主。Skill 由 `SkillManagerPanel` 管理，是给模型的指令文本；backend 用 `registry.ts` 静态注册。

**方案要点**

- 插件 = 一个目录：`manifest.json`（id、版本、内容 hash、平台、依赖、`capabilities` 请求、配置 schema、`uninstall` 清理清单）+ 入口。
- **运行在独立的 Electron `utilityProcess`**，每个插件一个进程；与主进程只通过一个类型化 RPC 通道通信。崩溃不影响主进程（「错误隔离」）。
- 能力请求按架构 11 的六类深接口分组：`conversation`、`knowledge`、`planning`、`execution`、`delivery`、`optimization`。插件只能调用 manifest 声明并经用户批准的接口。
- **强约束留在宿主**：授权、额度、证据、用户停止。插件只能「提出」动作，宿主执行检查后才落地——插件无法绕过 `task-authority`。
- 内置能力（会议、看板、现有 backend）先改造成「内置插件」，走同一接口，用来验证接口是否够用。
- 持久状态归宿主（事件日志），插件卸载不删除领域数据（WBS「持久状态不因插件卸载丢失」）。

**风险 / 待定**：第三方原生代码在 utilityProcess 里仍然拥有用户权限，**批准界面不是沙箱**（架构 11 已指出）。首发只支持手动安装、显示来源与权限，并在界面上明说这一点；真正的 OS 级隔离（Windows AppContainer / macOS sandbox-exec）后置评估。

**先做**：用两个内置能力（会议、Codex backend）试做接口，确认六类接口的边界。

---

## B10 原生 Harness 运行适配

延续 B04 的 `RuntimeDriver` 接口（`../b04-runtime/README.md` §7）。选定底座后：
- 统一事件：`run.started / tool / permission-requested / usage / delivery / ended(reason)`。
- 「能力不足明确拒绝」：每个 backend 声明 `capabilities`（interrupt、resume、permission-bridge、usage、sandbox），派工前检查；缺失就拒绝派工并告诉用户缺什么，不降级执行。
- 事件关联同一 Run：所有事件带 `runId + attempt + backendSessionId`。

---

## B12 Host、grill 与版本化计划提案

- Host 只用只读调查工具定位项目：稳定 `projectId`、当前挂载、B14 Issue 版本、相关文档与现有 WorkItem；调查阶段没有执行 Grant，不创建 Run。
- `grill` 收敛顺序固定为「目标复述 → 缺口/歧义 → 用户回答 → TODO 草稿更新」。每次回答追加 Utterance 与计划修订，不改写历史原话； Host 不得把模型推断当成用户确认。
- `StagePlan {planId, version, contentHash, sourceRefs[], acceptance[], items[]}` 整体不可变。任何 TODO、来源或验收变化都产生 `version+1`；只有当前版本可进入 `ConfirmStagePlan`。
- 计划确认按 B03 的 command journal + 原子事件批次同时写 Decision 和 WorkItem 状态。确认前始终是 `design/awaiting-confirm`，不派工、不写执行代码；过期 version/hash 与重复确认全部拒绝。
- 主动收敛只提出剩余问题，不自动批准。Host 会话中断或应用重启后，从草稿版本和未决问题恢复，不重复派工。
- 估算 5–8 人日，依赖 A-01/A-03 与 B14 的只读关联；验收是「读 Issue → 语音澄清 → TODO → 当前版本确认 → 重启仍一致」，且确认前无任何 Run。

---

## B14 GitHub Issue 读取关联与可选回写

- 用户的 `gh` 登录或 OAuth 设备流（不内置 GitHub App，首发）。
- WorkItem 关联 `{repo, issueNumber, nodeId}`；以 `nodeId` 去重。
- 外部变化：轮询 `updated_at`（首发）→ 有变化时生成「差异提案」，不覆盖执行计划（规格「外部 Issue 变更先展示差异」）。
- 回写只在项目设置开启后；默认不关 Issue、不为细分任务建 Issue。
- 首发只请求只读 `repo` 范围内 Issue 内容；凭据留在主进程。读取按 `nodeId + updated_at` 缓存并记录 ETag，限流/离线时保留最后成功版本并明确标记，不伪造最新状态。
- 估算 3–5 人日，依赖 A-01/A-02；验收为同 Issue 跨路径去重、外部修改只生成差异提案、默认零回写。

---

## B16 甘特图 / B17 里程碑与 Sprint

- 时间三字段：`plannedStart/End`（只在计划确认时写）、`estimatedEnd`（随进展更新）、`actualStart/End`（来自 Run 事件）。延期只更新 estimated。
- 依赖：WorkItem 之间的 `blocks` 关系，甘特图画箭头；循环依赖在写入时拒绝。
- Sprint 是一个聚合：`{goal, start, end, planVersion, items[], review, retro}`；到期事件 `sprint.ended` 把未完成项标记原属迭代，**不自动移入下一轮**，下一轮由用户确认。
- 渲染：首发自绘 SVG（任务数量级几十到几百，不需要引入甘特图库）；交互只做查看、拖动预计日期（生成提案，不直接改计划）。

---

## B19 项目周期额度与共享余额账本（XL，最需要先切片）

**模型**

| 实体 | 字段 |
| --- | --- |
| ServicePool | `poolId`、provider、账号、**单位**（`usd-estimate` / `window-percent` / `tokens` / `credits`）、周期、最近观测（值、质量、时间） |
| ProjectAllocation | `projectId`、`poolId`、周期（周 / 月 / 日）、额度（同单位）、优先级 |
| Reservation | `reservationId`（幂等键）、runId、attempt、数量、状态 `held → settled / released / unsettled` |
| Settlement | reservationId、实际数量、质量（reported / estimated） |

**规则**

1. 派工前：在项目分配内为该 attempt 预留「**单 turn 最大消耗 × 剩余轮次**」的保守量（Codex 只能事后中断，所以至少多留一个 turn）。预留失败 → 进入 `ready/awaiting-budget`，不派工。
2. attempt 结束：用实际 `usage`（B06）结算；拿不到实际值就按预留全额结算，状态 `unsettled`，**不释放成可再用余额**（架构 11）。
3. 不同单位**永不相加**；UI 每个服务池单独一条。
4. 跨项目：未分配额度按优先级先到先得；已分配额度不挪用；调整只能提案。
5. 耗尽：先问追加，不追加再问是否等新周期（规格）。
6. 幂等：预留、结算、释放都以 `reservationId` 去重；重放日志得到同样余额。

**切片**：① 单项目单服务池 + 预留 / 结算（无 UI）；② 多服务池与单位；③ 跨项目优先级；④ 周期刷新与订阅窗口观测对齐。

**风险**：订阅窗口只有百分比，**无法保证零超支**；UI 必须写「估算」，并允许用户把阈值设得更保守。

---

## B20 角色复杂度路由及阈值接力

- 输入：角色复杂度默认（例如测试→中，架构→高）、用户的服务优先级、最低能力要求、当前服务池余量。
- 选择：过滤（已连接、已授权、满足最低能力、余量高于阈值）→ 按用户优先级排序 → 取第一个。
- 接力：服务池跌破阈值时，**在 attempt 边界**切换（不在 turn 中途），并把产物与上下文包传给新会话；没有合格服务就暂停，不降标准。
- f5d88aa 的「显式 backend 作为任务级偏好」在这里成为一条输入：用户显式指定优先于自动路由（待用户确认语义）。

---

## B21 隔离工作区执行与有界返工

- **现有基础**：`taskWorkspaceSnapshot` 已有 `git-worktree / read-only / shared-locked`、`baseline` 脏目录记录；`task-authority` 的写路径约束；`evaluateTaskBudget` 的无进展检测（`maxStagnantAttempts`）。
- 补齐：默认每个 Run 一个 git worktree（参考 Orca 的 worktree 模型，MIT，按文件移植需保留 NOTICE）；脏目录不复制，只读可见（已有 `dirty-base-visible-read-only` 诊断）；轮次上限改为规格的「默认 3 轮实现→复核，含首次」。

---

## B22 独立复核与主任务整体验证

- **现有**：`delivery-harness.ts` 已有 `DeliverySpec`、`WorkOrder`、`VerificationEvidence`、`ReviewVerdict`、`DeliveryCandidate`。
- 补齐：
  - 复核会话**必须是新会话**，输入只有：固定的原始需求版本、验收条件版本、候选 revision、证据；不给实现会话的对话历史。
  - 结论三类：`pass` / `fail(findings)` / `undecided(reason)`。**必验项 undecided 不得通过**。
  - 父任务：所有必需子任务 `done` 后，再触发一次整体验证（跑父任务自己的验收），通过后进入待用户接受。
- 跨模型复核（Claude 实现、Codex 复核）作为可选策略，计入额度。

---

## B23 接受、集成与交付事实

- 用户动作：接受 / 接受并合入 / 继续修改 / 稍后（UX 已画）。
- 集成：合入在 `integrating` 子状态执行；冲突 → `integration-conflict` 并暂停；成功写 `mergeCommit`。
- 「已完成」的判定 = 用户接受 **且** 达到约定终点（方案验收 / 已提交 / 已合并 / 已发布），每种终点要有对应证据（commit SHA、PR merged 事件、发布 tag）。

---

## B24 内置浏览器 / B25 文档与 PDF / B26 外部应用

| 包 | 方案要点 | 关键风险 |
| --- | --- | --- |
| B24 | Electron `WebContentsView` + 独立 `session.fromPartition('persist:aha-browser')`（独立登录空间）；Agent 通过 CDP（`webContents.debugger`）操作；人工接手时设置 `controlOwner='user'`，宿主拒绝 Agent 的写操作；交还后先重新读 DOM 快照 | 日常浏览器的「读取数据」和「控制」分别授权（规格），读取日常浏览器需要扩展或导出，首发可以只做内置浏览器 |
| B25 | 格式矩阵先定：Markdown / 纯文本 完整编辑；DOCX、PDF 只预览 + 由 Agent 通过工具修改（`docx` / `pdf-lib`）；接管 = 对象级锁 + 交还时 diff | 不承诺所有格式内置编辑器（规格已说明） |
| B26 | 两层授权：设备能力（安装 / 首启时的系统权限：Windows 无需屏幕录制授权但 UI 自动化需要 UIAutomation；macOS 需要屏幕录制 + 辅助功能）与任务级 Grant 分开；缺系统权限就暂停并说明 | 完全访问**不**隐含开启屏幕权限 |

---

## B32 主动汇报与跨端注意力

- 通知分级：`info`（只进群聊和看板）、`decision`（需要用户决定）、`blocked`（额度不足、无法继续）、`risk`（先暂停再通知）。
- 跨端去重：通知以 `eventId` 为键；任一设备上「已读」或「已处理」即在其他设备上收起（经 B28 同步）。
- 「当前设备」：最近 2 分钟有输入的设备为活跃设备，只在活跃设备上发声 / 弹窗；其他设备只显示角标。
- 专注时段：只放行 `risk`。

---

## B33 项目知识与三层记忆

- **现有**：`memory.ts` 有分类、相关度选择、写入提示词；但 projectId 按路径计算（随 ADR 0013 迁移）。
- 三层：`user-preference`（跨项目）、`expertise`（通用经验）、`project-fact`（项目专属）。检索时**先按权限过滤再排序**（架构 11）。跨项目引用项目事实需要授权。
- 正式知识（需求、架构、验收）写进仓库（`docs/`），记忆里只存指针和版本；冲突知识更新生成提案，不静默改计划。

---

## B34 第三方插件及 Skill 手动安装

- 安装来源：本地目录或 Git URL + 固定 commit；展示 manifest 的来源、版本、hash、权限；安装、禁用、卸载可恢复。
- Skill 与插件分开展示：Skill 是指令文本，**不提供权限隔离**，界面上写明。

---

## B35 / B36 RSI 候选、评测与版本生效

- 默认关闭；首次启动询问。
- 候选只能改「策略层」（提示词、Skill、路由参数），**不能改**额度、权限、验收标准（规格）。用一个白名单 schema 约束候选可以改的字段。
- 评测三组：新案例、历史回放、留出案例；同一批反馈反复优化后的成绩不作为独立证明。
- 调度：只在「没有 Agent 执行、项目只等人工」且 B19 能为正常项目和下一轮评测都预留时启动；条件失效立即停止新派发，保存检查点。
- 版本：用户确认启用后，新任务用新版本；在途任务固定原版本，阶段边界检查后切换。PluginVersion 记录在 Run 上。

---

## B37 远程试用订阅及到期

见 `remote-control.md` §8。服务端只需要：账号、`firstPairedAt`、绑定设备列表、订阅状态；**不接触任何内容密钥**。

---

## B38 Windows 与 macOS 安装更新

- **现有**：electron-builder；macOS 签名校验脚本 `scripts/verify-macos-signing.mjs`；CI 有三平台矩阵。
- 补齐：Windows 安装包签名（Orca 用 SignPath，可参考同样方案）；`electron-updater` 的自动更新通道；首次引导（服务连接、允许目录、自动优化询问）；迁移入口调用 A-03；卸载时询问是否保留数据。
- 原生模块（sherpa-onnx-node、sodium-native）需要分别为 Windows x64 与 macOS arm64 预编译并纳入 CI。

---

## B39 Station 整机（硬件分支）

不在软件发布路径上。软件侧需提供：实体键输入源（B11 M5）、扬声器 / 麦克风的 AEC 实测（B05 补测）、电池状态读取（安全暂停）、外屏插拔时布局切换（B07 小屏布局）。

---

## B40 – B42 验收与发布

- B40：用一个真实任务贯穿全部能力；故障矩阵沿用规格的 12 个验收场景（规格「用户验收场景」表）+ 本文各节的风险项。
- B41：三位非开发用户，开发者不代操作；记录卡点与返工。
- B42：许可证清单（含 sherpa-onnx、模型权重、libsodium、可能引入的 Paseo）；诊断导出；官方服务的责任人和恢复手册。

---

## 汇总：进入各门前必须先拍板的技术决定

| 决定 | 影响的包 | 建议 | 何时 |
| --- | --- | --- | --- |
| 运行底座 | B09、B10、B20、B21 | 由 B04 证据决定 | 门 B 前 |
| 存储引擎（日志文件 vs SQLite） | B08、B19、B33 | 先用现有日志 + 投影（ADR 0015），数据量到瓶颈再换 | 门 A 中 |
| 插件进程模型 | B09、B34 | 每插件一个 utilityProcess | 门 A 后半 |
| 跨设备传输 | B28 | 自建 vs Paseo，由 B04 跨设备对照决定 | 门 X 前 |
| Windows 签名供应商 | B38 | SignPath（参考 Orca）或自购证书 | 门 R 前 |
