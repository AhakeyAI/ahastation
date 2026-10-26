# AhaStudio C0 交接（更正版）

日期：2026-10-22。作者：Claude，接续 Codex 同日的交接包。本目录 `docs/c0/` 是**当前唯一有效的 C0 进度入口**。Codex 原交接包原样保存在 `handoff-2026-10-22/` 作为来源，与本文冲突的地方以本文为准，逐条更正见 `handoff-2026-10-22/CORRECTIONS.md`。

## 2026-10-25 开发准入更新

当前先读 **`DEVELOPMENT-READINESS.md`**：A-14–A-20 真实严格复验、最终回归、额度使用原则、设计关闭项和首批开发顺序以该文为准。B04 严格证据在 `b04-runtime/results/`，协议与安全决定已同步到 ADR 0002/0003。

## 0. 2026-10-23 更新：设计包已完成，等待用户输入

在 N5095 上继续推进，C0 剩余的调研与设计已全部成文。**新增文档**（阅读顺序）：

| 文档 | 内容 |
| --- | --- |
| `DECISIONS-NEEDED.md` | **需要你决定或在场的事，一页**（D1–D12、T1–T3），每项带建议，可以只回「全部按建议」 |
| `plan/cards.csv` | 全部实施卡与切片的清单（卡号、WBS、门、规模、人日、依赖、设计依据、能否立即开工），可导入 GitHub Project |
| `plan/README.md` | **从这里开始**：C0 收尾状态、门 A 首批 13 张实施卡（约 35–50 人日）、关键路径、项目管理方案、开工前置清单、风险表 |
| `research/upstream-2026-10-22.md` | Orca / Paseo / Multica 当日版本与许可复核；Paseo 新增 connected hosts 与 usage；集成 / 复刻决策表 |
| `b03-contract/README.md` | 领域契约：对象身份、事件信封 v2、命令→事件样例、五阶段与细分状态、15 种旧状态映射、迁移 |
| `b04-runtime/README.md` | 运行底座对照：候选、10 个场景、一票否决规则、预算与授权 |
| `b06-quota/WIRING.md` | 用量接线方案；**更正** README 中「预算永远不会触发」的说法 |
| `design/meeting-mode.md` | 会议模式：按键状态机、发言权、专家唤起、VoiceProvider、进程划分 |
| `design/remote-control.md` | 跨设备：密钥与可信设备、加密信封与停止回执、主持租约、GitHub 交接、传输两候选 |
| `b07-ux/README.md` + `prototype.html` | UX 方案与可点击原型（会议、五阶段看板、甘特图、三类决定卡片、8 个异常场景） |
| `design/later-gates.md` | 门 B → F 其余工作包的技术方案概要（插件宿主、额度账本、复核、集成、浏览器 / 文档 / 外部应用、记忆、RSI、安装更新、发布） |
| `../adr/` | 架构决策记录：0001 项目稳定 ID、0002 libsodium、0003 保留 MeetingRepository 外套信封 |

**B04 已执行完成（2026-10-23，用户授权）**：选定**现有 adapter 为唯一运行底座**，不引入 Paseo（ADR 0004）。实测还发现 11 个问题（`b04-runtime/README.md` F1–F11），其中最严重的是：**应用固定的 Codex 0.144.1 对 ChatGPT 账号已完全不可用**，Claude 默认模型也已失效——现在的应用里两个首发 worker 对新用户都起不来。已列为门 B 前必须完成的 A-14–A-20。PR #47 已合并，main CI 三平台全绿。

**新发现**：

1. **main 的 CI 一直是红的**（最近 5 次全部失败）。Windows：33 个测试失败，集中在进程观察（`ps` 解析读不到 `ppid`）、Kimi 会话解析、Qoder tailer（`fs.watch` EPERM）。macOS / Ubuntu：测试全过，但 CI 要求上传 `release/*.dmg`，构建没有产出，上传步骤失败。**Windows 是首发主平台，B02 在 Windows 上没有关闭。**
2. 现有看板把 `failed`、`interrupted` 与 `done` 放在同一列，与规格冲突（`b07-ux` §1）。
3. 项目 ID 按路径计算（`sha1(realpath(cwd))`），无法跨设备识别同一项目（`b03-contract` §1）。
4. **N5095 本地语音只够做离线兜底**（`b05-voice/README.md`「N5095 实测结果」）：ASR 最好 RTF 0.67（未达 0.5 通过线）；aishell3 TTS 要 4 线程才达标（0.41），并且会占满 4 核；Kokoro 最好 5.9，排除。建议 N5095 联网时用在线 ASR/TTS，离线时降级。**需要你确认**（见第 6 节第 2 项）。

## 1. 代码基线（更正）

| 项 | 正确事实 | 原交接写法 |
| --- | --- | --- |
| 主程序仓库 | `ShawnyinsGit/ahastation-internal`，私有 | 同 |
| 基线 | **main `c134de2`**（GitHub 上的 main 与本地一致；2026-10-04 合入 PR #46 / M0） | `Documents/Claude/AhaStation @ bb76522` |
| 默认测试 | macOS / Linux：**922 项：921 通过、0 失败、1 跳过**（跳过的是 win32 专用用例）。**Windows：887 通过、33 失败**（CI run #98，2026-10-23 补充，见 §0） | 888 项：871 通过、16 失败 |
| 16 个失败 | 都是 `bb76522` 上的旧问题：4 个是 Kimi fixture 没入库（`a746051` 已修），其余是路由回归（`f5d88aa` 已修） | 作为待修回归 |

`Documents/Claude/AhaStation` 是停在旧分支 `fix/ahabar-hover-drag` 上的旧检出。它的「用户对 lock 文件的修改」只是根 `version` 字段从 0.17.8 改成 0.18.1，另外是一些未跟踪的工作资产；没有 main 缺少的产品代码。**不要在那里开发，也不要清理它。**

`orca/workspaces/…-internal-2/-3` 是空的 initial commit 工作区，与主程序无关。

## 2. 产品依据（未改动）

产品规格以 Codex 的 AME 文档为准，阅读顺序：
1. `handoff-2026-10-22/docs/ahastudio/10-ame-product-spec-v0.1-2026-10-22.md`
2. `…/11-ame-architecture-v0.1-2026-10-22.md`
3. `…/12-ame-development-wbs-v0.1-2026-10-22.md`（C0 = B01–B07）
4. `…/13-ame-remaining-decisions-v0.1-2026-10-22.md`
5. `…/09-ame-product-decisions-and-open-questions-2026-10-21.md`

05–08 是历史方案，不沿用。这些文档里凡是写 `bb76522`、16 个失败、「C0 基线未通过」的地方，都按本文更正理解；产品规则本身没有改动。

## 3. C0 状态

| 包 | 状态 | 证据或产物 | 剩余 |
| --- | --- | --- | --- |
| B01 冻结源码与可重复安装 | **macOS arm64 通过** | `evidence/2026-10-22-c0-b01-clean-install.json`：干净克隆 `c134de2`，Node 22.23.4，npm ci、typecheck、build、test 全过 | **Windows x64 待跑**（`run-n5095.ps1 -RunBaseline`）；本机 npm 11.20 与 CI 自带的 npm 10 不一致；npm 11 拦下了 6 个依赖的 install script |
| B02 关闭基线回归 | **默认套件 0 失败** | 同上 | Windows 复跑；`npm audit` 35 项未分级；产品负责人确认 `f5d88aa` 路由语义 |
| B03 领域契约 | 未开始 | — | 下一项 |
| B04 单一运行底座比较 | 未开始 | — | 需要真实 Harness 调用及预算授权 |
| B05 两端语音 | **候选筛选 + 基准脚本 + Mac 冒烟** | `b05-voice/` | **N5095 实测**（本次要你执行的部分） |
| B06 额度矩阵 | **静态核查第一版** | `b06-quota/README.md` | Kimi / DeepSeek；新版 CLI 字段；小额实测需要授权 |
| B07 主界面原型 | 未开始 | — | 依赖 B03 |

## 4. 影响范围或承诺的发现

1. **额度控制没有接线。** 固定版本的 Claude SDK（0.3.150）和 Codex app-server（0.144.1）都提供 token、估算金额、订阅窗口百分比，但应用全都没有读取，`attempt.tokenCost` 写死为 `null`（`electron/worker-scheduler.ts:3232, 3337`）。「额度优先于时间」在现有代码中不生效。
2. **零超支做不到。** Claude 只有按 API 价格估算的 `maxBudgetUsd`；Codex 没有服务端上限，只能事后中断，会多花一个 turn。需要保守预留。
3. **订阅剩余只有百分比和重置时间**，拿不到绝对额度；Claude 的窗口信息只在状态变化时推送。
4. **N5095 多音色 TTS 的速度和质量要取舍。** M1 Pro 冒烟：VITS aishell3（174 个音色，8 kHz）RTF 0.02–0.05；Kokoro 中文（103 个音色，24 kHz）RTF 0.71–0.88，即便在 M1 Pro 上也只是勉强实时。N5095 预计只能用 VITS 或在线 API。**以 N5095 实测为准。**
5. **「独立音色」的跨设备含义待确认。** 同一位专家在 Mac 和 N5095 上用不同引擎，声音会不一样。

## 5. 在 N5095 上执行（本次交接的动作）

前置：Windows 10/11 自带 `curl.exe` 和 `tar.exe`；需要 Python 3.9 以上（python.org 安装，勾选 Add to PATH）。跑基线还需要 Git 和 Node 22。

```powershell
git clone https://github.com/ShawnyinsGit/ahastation-internal.git   # 已有仓库则 git fetch
cd ahastation-internal
git checkout docs/c0-handoff-2026-10-22

# 1) 语音基准（约 350 MB 模型，下载到 %USERPROFILE%\aha-c0，不进仓库）
powershell -ExecutionPolicy Bypass -File docs\c0\run-n5095.ps1

# 2) 可选：同时跑 Windows 干净安装与全量测试（B01/B02）
powershell -ExecutionPolicy Bypass -File docs\c0\run-n5095.ps1 -RunBaseline

# 下载慢时：-HfHost hf-mirror.com -PipIndex https://pypi.tuna.tsinghua.edu.cn/simple
```

- 跑语音基准时**尽量接上电源**，并关掉其他重负载程序；脚本会记录电池状态。
- 结果写到 `docs/c0/results/`：`*-meta.json`（机器信息）、`*-voice.json`（RTF）、`*-voice-wav/`（每个音色的样本）、`*-b01.json`（基线摘要）。
- 跑完后执行脚本最后打印的 `git add / commit / push`，或者把 `docs/c0/results/` 发给我。
- **注意**：`run-n5095.ps1` 没有在 Windows 上实际跑过（编写环境是 macOS，没有 PowerShell）。如果报错，把完整报错贴回来。`bench_voice.py` 已在 macOS 上三条路径都跑通。

## 6. 待用户决定或提供

1. N5095 实测结果（上一节）。
2. 「每专家独立音色」：只要求同一设备上专家之间可以区分，还是同一专家跨设备也必须是同一个声音？
3. 是否授权一次小额真实冒烟（Claude、Codex 各一个短任务），采集用量事件做 B06 的测试样本。
4. 是否认可 `f5d88aa` 的路由语义：任务中显式指定的 backend 保留为任务级偏好。
5. 首个验收 Issue：[#48](https://github.com/ShawnyinsGit/ahastation-internal/issues/48)（已创建）。
6. （10-23 新增）走查 B07 原型（`b07-ux/prototype.html`），确认 `b07-ux` §6 的 4 个交互问题。
7. （10-23 新增）B04 对照：授权预算（约 100–200 万 token，按订阅额度）、Claude / Codex 账号、是否允许本机安装 Paseo 0.12.0。可与第 3 项合并为一次授权。
8. （10-23 新增）是否把 Paseo connected hosts 纳入跨设备传输候选（`research/upstream-2026-10-22.md` §5）。
9. （10-23 新增）是否允许在用户仓库写 `.ahastudio/project.json`，用于跨设备识别同一项目（`b03-contract` §7 Q2）。
10. （10-23 新增）非主持设备上的批准是否有效（`design/remote-control.md` §10 Q1）。建议：动作批准可以，阶段确认只在主持设备上。

## 7. 下一位接手者的顺序

1. 读本文，再按第 2 节读规格；拿到 N5095 结果后更新 B05，并补上 Windows 的 B01/B02。
2. 开始 B03 领域契约：架构 11 的对象表 → 命令、事件样例 → 与现有 `meeting-repository`、`task-collaboration` 的映射。
3. B06 接线切片：Claude/Codex adapter 读取用量和窗口信号，替换写死的 `tokenCost: null`，并用脱敏 fixture 写确定性测试。
4. 不自动发布 Issue、不合并到 main、不调用付费模型，除非用户明确授权。
