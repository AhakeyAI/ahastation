# AhaStudio 交给 Claude 的接续说明

交接日期：2026-10-22。目标：在已收敛的产品规格和 WBS 基础上，继续 C0 技术验证、关键交互原型与后续实施准备。用户最新要求先汇总交接，本轮不继续改产品代码。

## 给 Claude 的起始指令

请先阅读下列产品规格、架构、WBS、确认进度和最新测试证据，再继续推进。不要重新从零设计产品，也不要重新逐项询问已确认原则。先解决能通过代码、公开资料或测试取得答案的技术问题；影响费用、数据、范围或交付承诺的取舍，再带具体方案与用户讨论。用户随后会自行创建首个验收 Issue，不要代为发布。

## 工作目录与代码基线

| 位置 | 用途与当前事实 |
| --- | --- |
| `/Users/heartline/Documents/Codex/ahakey-studio-community` | 产品文档与研究所在仓库，主要整理成果都在这里 |
| `/Users/heartline/Documents/Claude/AhaStation` | 主程序源码；HEAD `bb765223e34cd2ca7c08052cd24b34e9f7bd84ac`，package `0.18.4` |
| `/Users/heartline/orca/workspaces/ahastudio/https-github.com-ShawnyinsGit-ahastation-internal-3` | 用户当前 Orca 工作区，空 initial commit，不是主程序源码，不要在这里另起一套产品 |

主程序仓库 GitHub 身份经 `gh repo view` 确认为 `ShawnyinsGit/ahastation-internal`。10月22日 `gh issue list --state open` 和 `--state all` 都返回空列表；没有创建 Issue、PR、提交或发布。

源码里 `package-lock.json` 是用户修改，另有多处未跟踪工作资产。文档仓库已有用户修改的 `docs/ahastudio/02-integration-plan.md` 和大量未跟踪文档。不要用 checkout/reset/整树覆盖清理这些改动。以下新增文档尚未提交，不要假定 GitHub 上已有。

开始修改源码前阅读：

- `/Users/heartline/Documents/Claude/AhaStation/AGENTS.md`
- `/Users/heartline/Documents/Claude/AhaStation/docs/POCKET_VIBE_BACKEND.md`

其中有旧 Linux 路径和过时工作区说明，先核对当前 macOS 现场，不能照搬 `/usr/local/bin` 或旧 `/opt` 安装版。当前 Node/npm 在 `/opt/homebrew/bin`。

## 按顺序阅读的正式成果

这些文件已包含完整规则，交接文档不重复展开全部 64 项决定。

1. `/Users/heartline/Documents/Codex/ahakey-studio-community/docs/ahastudio/10-ame-product-spec-v0.1-2026-10-22.md`
   - 当前产品规格，覆盖 D01–D64；六组评审后的决定已同步。
2. `/Users/heartline/Documents/Codex/ahakey-studio-community/docs/ahastudio/11-ame-architecture-v0.1-2026-10-22.md`
   - 架构候选与现有模块复用；领域对象、插件接口、执行与预算、跨端和 RSI。实现方案仍是草案，未选定新底座。
3. `/Users/heartline/Documents/Codex/ahakey-studio-community/docs/ahastudio/12-ame-development-wbs-v0.1-2026-10-22.md`
   - 42 个工作包、100 条依赖，已检查无环；有责任角色、验收标准和 C0/A/B/X/F/H/R 门。相对规模尚未换算成新工期，人员未分配。
4. `/Users/heartline/Documents/Codex/ahakey-studio-community/docs/ahastudio/13-ame-remaining-decisions-v0.1-2026-10-22.md`
   - 六组评审进度表、已确认项及后续资料/技术/商业输入，防止继续无休止采访。
5. `/Users/heartline/Documents/Codex/ahakey-studio-community/docs/ahastudio/09-ame-product-decisions-and-open-questions-2026-10-21.md`
   - 决策来源与完整变更记录。文件名为21日，内容已更新到22日。34个 Q 是议题组，很多是实施验证，不等于34个仍需用户拍板的问题。

旧 05–08 文档保留历史，不沿用其中 macOS 单机首发、观察层优先和旧 132 人日／22 周等规划。新版主平台、跨设备、预算、语音和范围以09/10为准。

## 必须保住的产品边界

下面是接续时最容易被旧代码或旧文档误导的点，细节以正式规格为准：

- AhaStudio 是 AME；AhaStation 是硬件。一个长期助理主持，普通项目兼任经理，复杂项目再委派独立经理。优先语音、会议到交付，不把产品做成要求用户逐个管 Worker 的终端墙。
- Windows x64 与 macOS Apple Silicon **双向**派工必须验收；软硬件**分别发布**，软件先验证跨设备 B、完整功能后正式发布。具体时间还没定。
- 首发看板双维度、甘特图、里程碑与 Sprint、插件和可选 RSI 都在范围内；不能以最小 B 为理由私自删掉完整首发承诺。Sprint 默认两周，可设置或对话修改。
- 每专家独立音色是明确首发要求。稳定头像、轻量状态动效、可改名头像；复杂3D和口型后置。
- 阶段计划确认保留，完全访问免逐操作审批，但不隐含外部屏幕控制权限。浏览器和文档可以人工接管；**CLI 不支持用户直接接管**。
- 所有交付独立复核，独立会话但不强制不同模型。完成按约定交付终点与用户接受，不将产物生成、接受、合并、发布混成一个状态。
- 额度控制优先于时间，项目默认周额度可改月日，经理灵活分配，服务各自记量；会议无费用上限且不占执行时长，ASR/TTS 独立、不计项目用量。三轮实现复核上限仍保留且可配置。
- RSI 默认关闭，首次启动询问开启；只用闲置余量，预留正常任务额度，逐轮估算并检查在途消耗，不足保存暂停。候选启用需确认，新任务用新版，在途任务旧版到阶段边界检查后切换；默认私有，分享需主动确认。
- 本地核心免费开源，官方远程先行，首连两设备起固定30天试用、两绑定可换绑且重装重连不重置。首发一个远程订阅档、订阅不限绑定；价格和服务并发在成本及内测后另确认。自托管后补。

## 已确认的实际验收与招募

首项需求已由用户接受：**看板记住最近的项目筛选，刷新或重启后恢复**。首次仍默认全部，历史项目不可用时回到全部，不增加跨设备偏好同步。Issue 由用户之后创建，链接待补。源码 `src/components/TasksView.tsx` 已有 `projectFilter`，以 `useState(ALL)` 初始化；实现前再检查导航行为，避免重复开发。

先 A：读取 Issue、语音澄清、形成带来源/验收条件的 TODO、阶段确认和持久化，不派写 Worker。然后 B：实际修改、检查、独立复核和接受；最后双向跨端。主持固定版与被开发候选分支分开。

首轮用户或团队定向邀请至少三位非开发参与者，暂不公开招募，尽量覆盖固定 Agent 主机、随身项目和不熟代码的创造者。可安装版出来后补名单，允许引导但开发者不代操作。正式任务、设备与模型服务测试资料仍待补齐。

## 最新语音输入改变了验证路径

用户在交接前提供：

- “樱桃 SDK”目前**不支持 N5095**；仅支持 **Core Gen11–14、所有 Core Ultra**，需支持型号的英特尔笔记本体验。
- 官网：`https://cherry.pcelves.com/`。可官网下载 ISV 应用体验。
- 尚未签 NDA，内部 demo app 不方便外发；不要索取、传播或依赖未经允许外发的内部 demo。

上述为用户提供的兼容范围，本轮未独立核对官网或实机。已更新09、10、11、12、13文档。N5095 首发必须验证其他本地 ASR/TTS 模型或 API；不能继续将取得樱桃 SDK 当作首发前置，也不能因此将所有专家降为同一音色。

当前源码 ASR 是 `electron/asr/xfyun-iat.ts` 讯飞 IAT，不是已可用的本地 whisper。TTS 是 `src/lib/speech-session.ts` 的系统 `speechSynthesis`；`src/lib/voice-registry.ts` 按 locale 和一个 selectedVoiceName 选择缓存，没有证明角色级独立多音色。`speaker-embedding` 是另一类能力，不能把下载 speaker 模型当作多音色 TTS 已完成。

## 刚完成的真实基线检查

持久证据：

`/Users/heartline/Documents/Codex/ahakey-studio-community/docs/ahastudio/evidence/2026-10-22-baseline-audit.json`

| 检查 | 结果 |
| --- | --- |
| 环境 | Darwin arm64，Node v26.12.1，npm 11.20.0 |
| 方法 | `git archive HEAD` 到独立 OS 临时目录，链接原有 node_modules；未改源码工作树 |
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm test` | 888 项：871通过、16失败、1跳过，退出码1 |
| 与10月19日对照 | 16个失败位置完全相同，证据里有完整名称与位置 |
| 限制 | 未 npm ci、未本轮补缺失 fixture、未真实付费 Worker、未 Windows/N5095、未双端或音频实测 |

不要将本轮检查写成 C0 已通过，也不要说“只剩12失败”：16是本轮真实全套结果；另4项与缺失Kimi fixture的关系来自历史分析。10月19日补fixture仅定向14项通过，不是本轮或全套重新通过。

原始日志、runner、manifest 及隔离源码均在：

`/var/folders/d9/v_g81yq92q1_jcxnkcfljc3c0000gn/T/ahastudio-c0-20261022-w_bhghqr/`

其中 `typecheck.log`、`build.log`、`tests.log` 是本轮原始证据。runner 最初只解析 TAP，因此 manifest 的 summary 最初为空；已按 Node26 的 spec reporter 解析并修正，持久 JSON 有正确汇总及16项失败，不需要因此再重复跑测试。

另已通过 npm exec 取得 Node **v22.23.4**，路径：

`/Users/heartline/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`

该Node**未用于本轮测试**，没有做 npm ci。仓库 CI 配置使用Node22，应在独立检出下用固定Node22/锁文件完成下一轮可重复安装验证，不能复用依赖后称“干净安装”。所有本轮命令会话已结束，没有待等待的后台测试或付费调用。

## 本机 CLI 与现有远程代码的核查

只运行了版本查询，没有登录、读取凭据或执行模型任务：

| CLI | 本机版本 | 旧代码固定版本/注意点 |
| --- | --- | --- |
| Codex | 0.162.1 | `worker-runtime-contract.ts` 固定0.144.1；需精确版本兼容验证 |
| Claude Code | 2.1.299 | 固定2.1.150，但选择 system CLI 时可覆盖 expected；不要笼统判所有系统Claude不兼容 |
| Kimi | 2.3.0 | 固定0.24.1；一次版本查询约6秒，而源码探测超时3秒，需复测 |
| Zcode | 3.14.3 | 现有 Qoder adapter 不能未经核对视作 Zcode adapter |
| DeepSeek CLI | PATH 未找到 | 不代表不能用 DeepSeek API，也不证明已完成API额度适配 |

`electron/backends/pocket-vibe-adapter.ts` 与交接说明明确 hub 无远端 cancel；interrupt 只停止本地轮询，还可能发 ended/interrupted。不能将它当作“远端任务已停止”的通过证据。该模块有现成结构可参考，但真实取消、回执、密文、主持权与恢复仍需改造/验证。

## 研究与原始材料

优先复用已落盘研究，不重写相同资料：

- `docs/research/orca-paseo-multica-ahastudio-strategy-2026-10.md`
- `docs/research/ahastudio-upstream-reuse-boundaries-2026-10-21.md`
- `docs/research/ahastudio-rsi-harness-reuse-2026-10-22.md`

以上路径均相对文档仓库。Paseo、现有 Aha、DSH 是候选，尚未选定；首发只选一个生产运行底座。DSH/Cordis参考的是插件生命周期，不代表现成SDK已满足Aha的权限、停止和恢复。Multica不能当纯Apache依赖无条件移植。

RSI 用户已粘贴完整微信文章，原URL `https://mp.weixin.qq.com/s/a9GtyIEgC5-aOcrS3FLALg` 无法直接打开。正文是方法综述，不是一个单独RSI框架；对应综述 `https://arxiv.org/abs/2610.14625`。DeepSeek官方链接的Cordis报告是 `https://arxiv.org/abs/2608.25512`，不要混成独立RHI论文2607.15524。出处与建议在研究文档里。

刚发起的 C0 运行底座/额度后台研究因执行额度限制中断，**没有生成**计划中的 `docs/research/ahastudio-c0-runtime-and-quota-evidence-2026-10-22.md`，不要引用成已交付文档。中间消息提到的 DSH cancel/approval、Codex rateLimits、Kimi usage API 都需 Claude 回到官方文档或源码复核，尚未采纳为正式技术结论。

原设计材料在下载目录，需时再读：`ahastudio-task-flow-prototype.html`、`AhaStudio-Pocket-交互动线文档-v1.4.pdf`、`交互设计.jpg`、`ahastudio宣传介绍.zip`、`ahastation硬件.zip`。先前HTML缺少引用JS/CSS，不能当独立可运行原型；PDF旧交互与当前规格有冲突，以10为准。此前浏览器对旧HTML file URL有明确安全拒绝，不绕过该拒绝改走其他表面打开同一内容。

## Claude 接下来按这个顺序推进

1. 读正式成果与新证据，确认当前源码和用户改动；无需再重复本轮同环境全套检查。
2. 用Node22、独立源码和tracked锁文件验证可重复安装；再按必要范围复现/诊断16项失败，区分缺失fixture与真正回归。不要删断言让红灯消失。
3. 围绕已确认目标，做运行底座最小契约PoC与额度适配矩阵。分清单次usage、订阅剩余量、项目分配、估算和在途预留；不读用户凭据或实际调用付费模型来冒充已有预算授权。
4. N5095语音改查其他本地模型/API，列两端中文、多音色、打断回声与离线输入的可验证方案；需要实机资料时再提出明确输入，不继续等待不兼容的樱桃demo。
5. 细化B03领域契约和B07会议→看板→工具接管的关键原型。尚未创建14号C0计划文档、新领域契约文件或新原型，不要假定它们已存在。
6. C0证据与实际人员就绪后，给出首批实施切片、人日区间与发布候选窗口；价格、并发和中转留存也待成本/内测证据后提案。

最新授权范围是继续技术验证和准备，最新用户动作是要求先交接；没有自动发布Issue、push、合并、部署、购买服务、发消息或启用真实收费模型的指令。可逆本地读取和既定验证不必反复请求确认。

## 建议使用的技能

若 Claude 环境可读取这些技能，按当前工作选用，不必全用：

- `research`：`/Users/heartline/.codex/skills/research/SKILL.md`，一手资料和候选接口核查；该技能要求后台研究，但以实际可用额度为准。
- `diagnosing-bugs`：`/Users/heartline/.codex/skills/diagnosing-bugs/SKILL.md`，先复现再定位基线回归。
- `domain-modeling` / `codebase-design`：同技能根目录下，细化领域契约和可替换接口。
- `prototype`：`/Users/heartline/.codex/skills/prototype/SKILL.md`，验证关键交互，不把静态demo算真实执行。
- `implement`：`/Users/heartline/.codex/skills/implement/SKILL.md`，进入有范围和验收的实施切片时使用。
- `grilling`：`/Users/heartline/.agents/skills/grilling/SKILL.md`，仅用于新出现的实质产品取舍，一次一个问题并给建议；已确认原则不重问。

不自动启动goal、不自动发消息、不自动提交文档和源码。后续如更新规划，保持09–13及证据的一致性，保留未完成与未知状态。
