# AhaStudio C0：开发前准备入口

更新：2026-10-26（Claude，Mac）。本目录 `docs/c0/` 是**当前唯一有效的 C0 进度入口**。各文档之间有冲突时，按下面的阅读顺序，越靠前越优先。Codex 10-22 的原交接包原样保存在 `handoff-2026-10-22/`，只作为来源；对它的逐条更正见 `handoff-2026-10-22/CORRECTIONS.md`。

## 1. 当前状态

**开发准入：有条件。** C0 的 B01–B07 都已完成，A-14–A-20 的运行时修复也已真实复验。要正式开工，还需要两类工作：

- **前置修复 P1–P8 合入**：运行时修复、安全基线、文档治理；
- **设计对齐 R1–R7 完成**：其中最关键的是评审 `etrnal-dev`，它决定跨设备和会议模式以哪套规格为准。

合入顺序（决定 G3）：

1. 运行时修复 [PR #54](https://github.com/ShawnyinsGit/ahastation-internal/pull/54)（`fix/runtime-a14-a20`，CI 三平台通过，待用户合入）；
2. 本文档分支 PR #50；
3. 安全基线 PR #53（草稿）；
4. PR #49（终端守护进程，需要拆分）。

| 线 | 分支 / PR | 写者 | 状态 |
| --- | --- | --- | --- |
| 运行时修复 A-14–A-20，P4–P7 | `fix/runtime-a14-a20`，[PR #54](https://github.com/ShawnyinsGit/ahastation-internal/pull/54) | N5095 | P4–P7 已交付，CI 三平台通过，待用户合入。证据见 `results/N5095-2026-10-26.md` |
| C0 文档与决定，P8 | `docs/c0-handoff-2026-10-22`，PR #50 | Mac | 本次完成 ADR 改号和本文重写 |
| 安全基线 P1–P3 | `fix/security-baseline`，[PR #53](https://github.com/ShawnyinsGit/ahastation-internal/pull/53)（草稿） | Mac | Electron 45、PDF.js 6、CI Node 24、`safeStorage` 异步接口；三平台 CI 通过，待 N5095 打包冒烟 |
| `etrnal-dev` 评审 R1–R3 | `review/etrnal-dev-2026-10` | Mac | R1 报告、R2 冲突表与全部裁决已完成（ADR 0017 / 0018），已转告作者；R3 首版完成 |
| 跨设备协作 collaboration.5 | `etrnal-dev` | eternal904 | 评审前不改；K01 自动发布问题是一票否决项 |
| 终端守护进程与本地 CLI 工作区 | PR #49 | Leo Lin | 已建议拆成四个 PR，待作者回复 |

## 2. 阅读顺序

1. **`DECISIONS-2026-10-26.md`**：用户 12 项决定（G1–G12）、前置修复 P1–P8、设计对齐 R1–R7、分支写者，以及对 N5095 会话的更正。
2. **`DEVELOPMENT-READINESS.md`**：A-14–A-20 的复验证据、额度使用原则、首批开发顺序。其中 §1「可进入技术开发」已被上一份改为有条件。
3. **`DECISIONS-NEEDED.md`**：D1–D15、T1–T3 的已定结果。T2 的「25%」只能当定性证据，见 DECISIONS §5 第 3 条。
4. **`plan/README.md` + `plan/cards.csv`**：实施卡、依赖、人日、关键路径。跨设备卡已按 R1 / R2 重估（§2a）。
5. 产品规格：**`../ame/`**（AME 09–13 的在用版本，2026-10-27 迁入并更正，见 `../ame/README.md`）。交接包里的原件只作来源；05–08 是历史方案，不沿用。

## 3. 目录

| 文档 | 内容 |
| --- | --- |
| `b03-contract/README.md` | 领域契约：对象身份、事件信封 v2、command journal、五阶段与细分状态、旧状态映射、迁移 |
| `b04-runtime/` | 运行底座对照：10 个场景、一票否决规则、严格 harness、证据（`results/`）。结论：保留现有 adapter（ADR 0016） |
| `b05-voice/` | 语音候选、基准脚本 `bench_voice.py`、回声测试 `echo_test.py` |
| `b06-quota/` | 用量矩阵与接线方案 `WIRING.md`、脱敏 fixture |
| `b07-ux/` | UX 方案与可点击原型 `prototype.html`（v2，已冻结） |
| `design/meeting-mode.md`、`design/remote-control.md` | 会议模式与跨设备设计。R3 已修订：remote-control §0、meeting-mode §9a 优先于原文 |
| `design/later-gates.md` | 门 B → F 其余工作包的技术方案概要 |
| `research/upstream-2026-10-22.md` | Orca、Paseo、Multica 的版本与许可复核 |
| `evidence/`、`results/` | B01 基线证据、N5095 语音和回声结果、双 provider 并发资源样本 |
| `run-n5095.ps1` | N5095 上的语音基准与 Windows 基线脚本 |
| `../adr/README.md` | **统一 ADR 索引**。C0 的 ADR 是 0013–0016；main 是 0001；`etrnal-dev` 是 0002–0012；评审裁决的 0017–0018 已用，新 ADR 从 0019 起编号 |
## 4. 代码基线

| 项 | 事实 |
| --- | --- |
| 仓库 | `ShawnyinsGit/ahastation-internal`，私有 |
| main | **`c8295b9`**：PR #47 合入，Windows 测试失败清零，main CI 三平台通过 |
| 运行时 | Electron 42.11.18，内置 Node 24.19.0。PR #53 升到 45.0.0，内置 Node 24.22.0 |
| CI Node | 22。PR #53 改为 24 |
| 依赖漏洞 | 运行时修复分支的 lock 已降到只剩 1 high（PDF.js，GHSA-hq66-cqwq-w95j），由 PR #53 修复。main 自身的 lock 还有 MCP SDK、xmldom 等条目，运行时修复合入后复查 |
| 运行时修复分支测试 | PR #54（`d1ee166`）：N5095 本地 950 项，944 通过，0 失败，6 跳过；CI 三平台通过 |

已知的测试时序隐患（P7）：机器负载高时，对时间敏感的检查会超时。

- `tests/kimi-adapter.test.mjs:66` 和 `task-budget` 的等待：PR #54 已延长到 10 秒。
- **仍未处理**：`electron/backends/worker-runtime-contract.ts:301`、`:326` 的运行时版本探测只等 3 秒，超时后会误判 worker 不可用。N5095 这类慢机器在真实使用中也可能遇到。

两者都在 Node 24 默认并发跑测试时出现，详见 PR #53 描述。

本机目录提醒：

- `Documents/Claude/AhaStation` 是停在旧分支上的检出（`bb76522`）。不要在那里开发，也不要清理它。
- `orca/workspaces/…-internal-2/-3` 与主程序无关。

## 5. C0 工作包

| 包 | 状态 | 证据 |
| --- | --- | --- |
| B01 冻结源码与可重复安装 | 通过：macOS arm64；Windows N5095 上 `npm ci`、typecheck、build 也通过 | `evidence/2026-10-22-c0-b01-clean-install.json`、`evidence/2026-10-23-c0-b01-windows-n5095.json` |
| B02 关闭基线回归 | 通过。N5095 在 `c134de2` 上 34 个测试失败，PR #47 修复，main CI 三平台通过。10-22 时说的「0 失败」只基于 macOS，是交接错误 | 同上；main CI |
| B03 领域契约 | 设计完成，ADR 0015。**跨设备部分待 R1** | `b03-contract/README.md` |
| B04 单一运行底座 | 完成：保留现有 adapter，ADR 0016；F1–F11 已由 A-14–A-20 修复并严格复验 | `b04-runtime/` |
| B05 两端语音 | 路线已定（D3：在线为主、本地兜底）；三家在线基准和预算器已交付（R6，离线测试 11/11），真实实测未做，预算 100 元（G5） | `b05-voice/README.md`、`b05-voice/online/` |
| B06 额度矩阵 | 协议完成，A-10 待实施 | `b06-quota/` |
| B07 主界面 UX | 已冻结（D7、D15） | `b07-ux/` |

## 6. 待办与待决

- **待用户决定：**
  - 按 G3 顺序合入 PR #54 → PR #50 → PR #53；本评审分支排在 PR #50 之后；
  - PR #49 和 `etrnal-dev` 作者回复后的拆分方案。
  - 冲突表 C01–C21 已全部裁决，见 `review-etrnal-dev/CONFLICTS.md`。
- **N5095：** P4–P7、R6、R7 已交付（`results/N5095-2026-10-26.md`）。还要做：
  - PR #53 的 Windows 打包冒烟，并确认旧版加密的 API key 升级后仍能读出；
  - `etrnal-dev` rebase 后复现 K01；B04 S4–S6；核对 `etrnal-dev` 里非主持设备能否批准计划（C10）；
  - 3 秒版本探测（§4）；
  - 实施期：S11 的真实 Codex 运行、三家语音真实实测（预算 100 元）、A-08 / AEC / M6 验收。
- **Mac：** R1–R4 已完成；R3 的跨设备估算等 eternal904 回复后修正；R5 等 PR #49 拆分后复审。

## 7. 工作约定

- 每个分支只有一个写者（G11）。N5095 的新证据放在它自己的分支，由 Mac 合并到本分支。
- 不合并到 main，由用户合入；不自动创建 Issue。
- 不调用付费模型，例外只有 D1 的 B04 授权和 G5 的语音预算。
- 不读取、不提交 token、cookie 和账号配置。
- `etrnal-dev` 只在本机隔离环境评审，不连公网 Hub，不开真实 PR。
- AME 文档不推到 `ahakey-studio-community`，它的远端是公开仓库。
