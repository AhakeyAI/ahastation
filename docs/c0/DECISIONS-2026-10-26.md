# 开发前准备：决定与执行清单（2026-10-26）

作者：Claude（Mac）。来源：拉取分析 `docs/c0-handoff-2026-10-22` @ `6298076` 与 `fix/runtime-a14-a20` @ `9587f80`，并与用户逐项确认。**本文优先于 `DEVELOPMENT-READINESS.md` §1 的「可进入技术开发」**：准入改为「有条件」，条件是下面 §2 的前置修复全部合入、§3 的设计对齐完成。

## 1. 用户决定（2026-10-26）

| # | 问题 | 决定 |
| --- | --- | --- |
| G1 | 跨设备与会议模式以哪套规格为准 | **先评审 `etrnal-dev` 再定**。暂停 C0 的 X1–X8 自建设计；按 B04 同样的一票否决口径评审 `etrnal-dev`（collaboration.5）的 Hub / Station，通过则作为跨设备实现基础，C0 契约向它对齐 |
| G2 | 安全前置修复 | **开发前全做**：PDF.js 6.x、Electron 45（原生模块不兼容时退到 44）、CI Node 22 → 24 |
| G3 | 合入顺序 | `fix/runtime-a14-a20` 开 PR → CI 三平台通过后由用户合入；然后 PR #50（完成 ADR 改号与 README 治理后）；最后 PR #49（基于新 main rebase，并按 A-20 停止语义复审 worker 桥） |
| G4 | Codex 获批命令在沙箱外运行 | **标注 + 事后检测**：批准卡片写明「该命令以完整权限运行」；宿主在每条获批命令前后对授权范围外的文件做 hash 比对，发现越界写入即停止 Run 并报告；B04 增加对应场景 |
| G5 | A-08 在线语音首轮实测 | **讯飞、豆包、Azure 三家都测**，语音 API 预算上限 **100 元**，与 Claude/Codex 额度分开计量 |
| G6 | N5095 并发 worker 上限 | **默认 2 个**，可在设置里调；M6 实测后再决定是否放宽 |
| G7 | ADR 编号冲突 | C0 的 ADR 排在已有编号之后、建统一索引；main 的 0001 与 `etrnal-dev` 的编号保持原号。**执行更正（2026-10-26）**：`etrnal-dev` 实际占用 0002–0012（Claude 起初误数为 0002–0011），因此 C0 的 0001–0004 改为 **0013–0016**，新 ADR 从 **0017** 起，见 `../adr/README.md` |
| G8 | Codex CLI 版本策略 | **已验证区间 + 每周兼容检查**：版本门放开到已验证区间；CI 每周用最新版跑握手和 adapter 契约测试，通过后扩大区间，失败则开卡 |
| G9 | 评审 `etrnal-dev` 的运行方式 | **只在本机隔离环境**：本机起 Hub 与临时仓库，不连公网 Hub、不开真实 PR、不调用付费模型 |
| G10 | Q1–Q100（`etrnal-dev`）与 D1–D15（C0）冲突 | **Claude 列冲突表，用户逐条裁决**，不按日期或线路自动取舍 |
| G11 | 多会话分工 | **每个分支只有一个写者**，见 §4 |
| G12 | AME 文档 09–13 | **由 Claude 直接修改**（解除此前「不改 Codex 文档」的约定）。注意：这些文件在 `ahakey-studio-community` 里是未跟踪文件，而那个仓库的远端是公开仓库，不能推到那里。改为在本仓库建 `docs/ame/` 作为在用版本，`handoff-2026-10-22/` 里的副本继续原样保留 |
| G13 | 模型来源（2026-10-27 补充） | **每个 harness 只用自家模型**：Claude Code → Anthropic 模型；Codex → OpenAI 模型（ChatGPT 登录或 OpenAI API key）；Kimi → Kimi 模型。不支持把 Claude Code / Codex 指向第三方或「OpenAI / Anthropic 兼容」接口去跑别家模型，也不做 Responses ↔ Chat Completions 的协议桥接。AME 10-22 记录里的 Zcode、DeepSeek 等，只有接入它们自己的 harness 后才能使用。不影响 AME-D26 的跨模型复核：那是不同 harness 各用自家模型 |

## 2. 前置修复（要写代码，开发前完成）

| # | 内容 | 依据 | 写者 / 分支 |
| --- | --- | --- | --- |
| P1 | PDF.js 5 → 6.x（PR #53 草稿） | GHSA-hq66-cqwq-w95j（打开恶意 PDF 可执行任意 JS）；主进程解析用户附件 `electron/attachments/parse.ts:147`，只有这一处使用 | Mac / `fix/security-baseline` |
| P2 | Electron 42 → 45（PR #53 草稿） | 45.0.0 于 2026-10-21 发布，Electron 只维护最新 3 个大版本（43–45）；42.11.18 与 45.0.0 同日发布，大概率是 42 的最后一版。需重建 node-pty 等原生模块并跑 macOS / Windows smoke | Mac / `fix/security-baseline` |
| P3 | CI Node 22 → 24（PR #53 草稿） | Electron 42 内置 Node 24.19.0，测试却在 22 上跑。已验证：修复分支在 Node 26.12.1 下 937 项、935 通过、0 失败，Node 22 下同样无真实失败 | Mac / `fix/security-baseline` |
| P4 | 运行时修复开 PR 并合入。**2026-10-27 已开 [PR #54](https://github.com/ShawnyinsGit/ahastation-internal/pull/54)，CI 三平台通过，待用户合入** | 准入文档 §5 第 1 步 | N5095 / `fix/runtime-a14-a20` |
| P5 | 命令越界：B04 新场景 + 宿主 hash 比对（G4）。**已交付：S11 + fixture 20/20；真实 Codex 运行待做** | `read-only + on-request` 下获批命令在沙箱外运行，例如允许改 `src/` 加批准 `npm test`，被改的源码可在测试时写 `test/` | N5095 / `fix/runtime-a14-a20` |
| P6 | Codex 版本门改为已验证区间 + 每周 CI 检查（G8）。**已交付：区间 [0.156.1, 0.157.0)，每周工作流只开 PR** | F1：固定版本因模型下线失效 | N5095 / `fix/runtime-a14-a20` |
| P7 | 小修：`electron/asr-polish.ts:55` 写死 `claude-sonnet-5`（改为从模型列表取）；`tests/kimi-adapter.test.mjs:66` 只等 1 秒，全量并发时偶发失败（Mac 复跑 1 次失败、单独 3/3 通过）；`task-budget` 偶发失败。**已交付：模型改从目录取，两处等待延长到 10 秒；3 秒版本探测未处理** | 与 F3 同类隐患；测试不稳 | N5095 / `fix/runtime-a14-a20` |
| P8 | 文档治理：C0 README §3–§7 过时；ADR 改号（G7）与统一索引；本文接入阅读顺序。**2026-10-26 已完成** | 与准入文档冲突 | Mac / `docs/c0-handoff-2026-10-22` |
| P9 | Codex 版本收尾与 G13 落地（PR #54 合入前；Mac 复核 PR #54 时发现）：<br>① 删掉 `electron/backends/codex-adapter.ts:1491` 的「钉在 0.144.x」注释，它的前提已被实测否定（`b04-runtime/README.md` §6f）；<br>② 清掉残留的 0.144.1：`scripts/real-worker-stability-smoke.mjs:47`（`npm run test:real-workers` 在 `:138` 断言版本必须等于 0.144.1，真实冒烟必然失败）、`scripts/board/runtime-versions.env:3`（板端严格门）、`src/dev-fixture-bootstrap.ts:67`；<br>③ `electron/backends/worker-runtime-contract.ts:14`、`:243` 仍按 `0.156.1` 精确匹配，与协议层的区间 `[0.156.1, 0.157.0)` 不一致，0.156.2 会被 Worker 门误判为不兼容。改为两处共用同一个区间，并补 0.156.2 的单测；<br>④ 同文件 `:301`、`:326` 的版本探测只等 3 秒，放宽或改为可配置；<br>⑤ 按 G13 移除 Codex、Kimi 的 Base URL 配置入口（`src/components/Lobby.tsx:442`、`src/components/BackendSettings.tsx:769`；Codex 侧注入在 `codex-adapter.ts:1417-1419`）。已有配置读入时忽略，并提示一次；<br>⑥ 测试替身 `tests/electron-stub-impl.mjs` 把所有测试的 userData 都指向 `/tmp`，并发时互相覆盖；改成每个进程一个临时目录，连同写死 `/tmp/meetings` 的测试一起改 | G8、G13 | N5095 / `fix/runtime-a14-a20` |

## 3. 设计对齐（分析协作者进展后细化）

| # | 内容 | 产出 | 写者 |
| --- | --- | --- | --- |
| R1 | **2026-10-26 已出报告：`review-etrnal-dev/README.md`（分支 `review/etrnal-dev-2026-10`），建议有条件部分采用，阻断 B1–B3、待裁决 D1–D3**。`etrnal-dev` 评审（G1、G9）：Hub / Station / 接收组件 / v2 契约；一票否决项 = 越界写、停止、**K01 自动发布**；另查 K02 线程恢复、基于 `c134de2` 未合 PR #47 的差距 | 评审报告 + 采用 / 部分采用 / 不采用的建议 | Mac |
| R2 | **2026-10-26 已出冲突表：`review-etrnal-dev/CONFLICTS.md`，C01–C21（甲 5 项、乙 11 项、丙 5 项）；C01、C03、C04、C05 已裁决（均按建议），其余待裁决**。Q1–Q112 与 D1–D15 冲突表（G10） | 冲突表，交用户裁决 | Mac |
| R3 | **2026-10-27 已完成首版**：`design/remote-control.md` §0、`b03-contract` §8、`design/meeting-mode.md` §9a、`plan/` X 卡重估（内部首轮 37–59 人日，公开前追加 19–32）。C0 B03 契约、remote-control、meeting-mode 按 R1 结论修订；X1–X8 人日重估 | 修订稿 | Mac |
| R4 | **2026-10-27 已完成迁移和首轮更正（`docs/ame/README.md`）；R2 剩余项裁决后再同步一次**。AME 09–13 迁到 `docs/ame/` 并更正：旧基线、准入状态、与 R1/R2 结论对齐（G12） | `docs/ame/` | Mac |
| R5 | PR #49（Leo Lin）复审：Windows 守护进程测试与打包 smoke 缺失；worker 桥与 A-20 停止语义 | 复审意见，按 G3 顺序合入 | Mac |
| R6 | A-08 语音三家实测方案与预算器（G5）。**已交付：`b05-voice/online/`，离线测试 11/11；真实实测未做** | benchmark 脚本与预算口径，A-08 开工即用 | N5095 |
| R7 | 并发名额默认 2（G6）写入 B10 / B21 设计与设置项。**设计已写入 `design/later-gates.md`；设置项待实施** | 设计更新 | N5095 |

`etrnal-dev` 的维护者需要知道：评审期间 K01 按一票否决项处理。是否转告由用户决定。

## 4. 分支与写者（G11）

| 分支 | 唯一写者 | 说明 |
| --- | --- | --- |
| `docs/c0-handoff-2026-10-22`（PR #50） | **Mac** | 自本文起 N5095 不再向这里推送；N5095 的新证据放在自己的分支 `docs/c0/results/` 下，由 Mac 合并进来 |
| `fix/runtime-a14-a20` | **N5095** | P4–P7 |
| `fix/security-baseline`（新） | **Mac** | P1–P3 |
| `review/etrnal-dev-2026-10`（新） | **Mac** | R1–R3 的评审文档，只加文档，不改 `etrnal-dev` |
| `etrnal-dev`、PR #49 | 原作者 | 不改，只评审 |

交接写在各 PR 描述里。所有分支都不合并到 main，除非用户明确合入；不自动创建 Issue；不调用付费模型（G5 语音预算和 D1 的 B04 授权除外）。

## 5. 对 N5095 会话的更正

1. 「可进入技术开发」改为有条件，条件见本文顶部。
2. `docs/c0/README.md` §0 说「main 的 CI 一直是红的」，事实成立；Claude 10-22 交接里「B02 0 失败」只基于 macOS，是交接错误。
3. T2 回声基线：4 个样本里 1 个被识别出文字，而且播放时麦克风电平低于「静音」基线（-25 dB 对 -27 到 -31 dB），dB 数据无效。只能作为「会自听」的定性证据，不能当 25% 的比例引用。
4. N5095 的 ASR 线程越多越慢：4 线程 RTF 1.65，1 线程 0.67。A-11 离线兜底应固定 1–2 线程。aishell3 单线程数据波动 0.62–1.54，并且越跑越慢，这组数据只用来定方向，不用来定余量。
