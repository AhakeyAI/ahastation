# 开发计划、项目管理与开工前置

日期：2026-10-23。状态：**计划草案，待项目负责人批准**。
依据：WBS 12（B01–B42 与门 C0/A/B/X/F/H/R）、本目录同级的各设计文档。本文不改 WBS 的范围和门，只做三件事：把 C0 收尾、把门 A 的首批工作拆到可以直接开工的实施卡、定项目管理方式。

## 1. C0 收尾状态（截至 2026-10-23）

| 包 | 状态 | 证据 / 产物 | 收尾还差 |
| --- | --- | --- | --- |
| B01 | macOS 通过；**Windows N5095 通过（2026-10-23，Node 22.23.4 / npm 10.9.9）：`npm ci`、`typecheck`、`build` 均 exit 0；`test` 922 项 883 通过、34 失败、5 跳过**（`../evidence/2026-10-23-c0-b01-windows-n5095.json`）。可重复安装已证实，测试失败归入 B02 / A-00。此前一次后台运行： |2026-10-23 在 N5095 上用 Node 22.23.4 运行，`npm ci` 阶段因系统内存不足被 Claude Code 停止（不是脚本错误）。Windows 测试结果暂以 CI run #98（windows-latest、Node 22）为证据 | `../evidence/`；CI run 37176224639 | 关闭其他程序后在 N5095 上重跑 `run-n5095.ps1 -SkipBench -RunBaseline`（先把 PATH 指向 `%USERPROFILE%\aha-c0\node22\node-v22.23.4-win-x64`） |
| B02 | macOS / Linux 默认套件 0 失败；Windows 33 失败（CI #98）→ **A-00 已修复：N5095 上 923 项 917 过、0 失败、6 跳过**；草稿 PR [#47](https://github.com/ShawnyinsGit/ahastation-internal/pull/47)（分支 `fix/c0-windows-tests`） 。**PR #47 CI 三平台全绿**（run 39839895671，macOS 第 2 次尝试通过） | 同上；CI run 37176224639；PR #47 | 由你决定合并 PR #47；**偶发失败**：`tests/task-budget.test.mjs:134`（#804）在 CI macOS 上第 1 次超时，`waitFor` 固定 3 秒期限偏紧，建议放宽到 10 秒或改为等待事件，列为 A-00 的后续小修；修 CI 的 dmg 上传条件；`npm audit` 分级；f5d88aa 语义确认（用户） |
| B03 | **契约草案完成** | `../b03-contract/README.md` | 评审 → 写成 zod schema（实施卡 A-01） |
| B04 | **已执行完成（2026-10-23）**：4 个组合 × 10 个场景全部跑完；**选定 C-A（现有 adapter）为唯一运行底座**，不引入 Paseo 执行层 | `../b04-runtime/README.md`「完整矩阵」「结论」；ADR 0016；`../b04-runtime/results/` | 产品负责人确认 ADR 0016；先完成 A-14–A-20 再进入门 B |
| B05 | **N5095 实测完成**：本地语音只够做离线兜底 | `../b05-voice/README.md`、`../results/*-voice.json` | 用户确认选项 A（在线为主、本地兜底）；试听样本；回声 / 打断真机补测；在线 TTS 供应商比较 |
| B06 | 能力矩阵 + **接线方案** | `../b06-quota/README.md`、`WIRING.md` | 真实事件样本（与 B04 同一次授权） |
| B07 | **UX v1 已冻结**（2026-10-23 用户确认 4 个交互问题） | `../b07-ux/README.md`、`prototype.html` | — |

C0 门的退出条件是「B01–B07 证据完整；选定一个运行底座；语音、计量不可行项有替代方案」。**剩下的阻塞项全部是用户输入**：B04 授权、B05 音色决定、B07 走查、f5d88aa 确认。

## 2. 门 A 首批实施卡

门 A = 「读取自身 Issue，按键语音对话，TODO、来源、验收、阶段确认和重启持久化；不写执行代码」。
首批选的是**不依赖 B04 结论**、可以立刻开工的卡。人日是单人估算区间，含测试，不含评审等待。

| 卡 | 标题 | WBS | 设计依据 | 估算 | 前置 | 验收（摘要） |
| --- | --- | --- | --- | --- | --- | --- |
| **A-00** | **Windows 测试归零 + CI 变绿**：33 个失败（observe `ps`/lsof 解析、Kimi 解析、Qoder tailer `fs.watch`）；`release/*.dmg` 上传只在实际打包的 job 上执行 | B02 | README §0 | 2–4 | 无 | `build-matrix` 在 macOS / Windows / Ubuntu 三个 job 全绿；Unix 专用用例在 Windows 上显式 skip 并写明原因，不静默删除。**已定位的根因之一**：仓库没有 `.gitattributes`，Windows 检出（`core.autocrlf=true`，GitHub runner 默认相同）把 `tests/fixtures/observe/ps-sample.txt` 转成 CRLF；`parsePsOutput`（`electron/observe/process/darwin.ts:38`）按 `'\n'` 切行，行尾残留 `\r` 使正则 `(.*)$` 不匹配，整行被丢弃 → `ppid` undefined。修法：加 `.gitattributes`（`tests/fixtures/** -text`）并让解析器按 `/\r?\n/` 切行。**根因之二**（Kimi 8 项）：`tests/observe-kimi.test.mjs:43-44` 用 `replaceAll` 把 `join(home, …)` 得到的 Windows 路径（含反斜杠）原样写进 JSONL，反斜杠成为非法 JSON 转义，索引解析失败 → `parseKimiSession` 返回 null。修法：写入前 `JSON.stringify(path).slice(1, -1)`。Qoder tailer 的 `fs.watch` EPERM（6 项）需另查，疑似 Windows 上监视正被删除的临时目录。**本机额外 1 项**（#639 符号链接）：普通用户无开发者模式时无权创建 symlink，CI 以管理员运行所以不出现；测试应在 EPERM 时 skip |
| A-01 | 领域 schema：`DomainEventV2` 信封、阶段/细分状态、旧状态映射 | B03→B08 | b03 §3、§5 | 2–3 | B03 评审 | 15 种旧状态映射单测全覆盖；`accepted` 无用户接受事件时映射为待接受；revision 断档检测 |
| A-02 | 项目稳定身份 + `ProjectMount` + `legacyIds` | B08 | b03 §2、§6 | 2–3 | A-01 | 同一仓库两个路径合并为一个项目；旧 transcript 能通过 legacyId 读到 |
| A-03 | 旧日志只读迁移投影（会议→项目、任务→WorkItem+Run、grant→legacy Decision） | B08 | b03 §6 | 3–5 | A-01、A-02 | 迁移幂等；回退 = 删投影；旧目录未被修改（hash 比对） |
| A-04 | `ConfirmStagePlan` 命令：版本 + contentHash 校验，旧确认拒绝 | B18 | b03 §4.1 | 2–3 | A-01 | 过期版本 / hash 不符 / 重复确认三种拒绝；Decision 事件带 utteranceId |
| A-05 | 看板 5 列 + 细分状态徽标 + 「需关注」过滤 | B15 | b07 §3.2 | 2–3 | A-01、B07 冻结 | 失败、中断不进「已完成」；只有 `done/*` 进已完成列 |
| A-06 | **自举需求**：看板记住最近项目筛选 | 首个验收 Issue | 确认单 13 第二组 | 0.5–1 | 用户建 Issue | 刷新 / 离开返回 / 重启恢复；首次默认全部；旧项目失效回到全部并提示 |
| A-07 | 决定卡片三类分开（阶段确认 / 动作批准 / 交付接受） | B18、B23 | b07 §3.4 | 2–3 | A-04 | 接受与合入两个按钮；接受后不显示已合并 |
| A-08 | `VoiceProvider` 接口 + WebAudio 播放 + 角色音色绑定（先接系统音色和讯飞 TTS） | B13 | meeting-mode §7、M1 | 3–4 | 无 | 同一角色一次会议内音色不变；打断播报 < 150 ms（建议目标，真机测）；**N5095 有人在场的打断测试：播报中说话能被正确识别，且设备自身 TTS 不再被识别成文字（基线：无 AEC 时 25%）** |
| A-09 | `InputController`：短按 / 长按状态机 + ContextLock + 待发送状态 | B11 | meeting-mode §4、M3 | 3–4 | A-01（Utterance 事件） | 状态机单测；录音中切视图，Utterance 仍引用开始时的对象；失败不自动重发 |
| A-10 | B06 用量接线：`usage` 信号、Claude / Codex adapter、scheduler 结算 | B06 | b06 WIRING | 2–3 | 无（真实样本等 B04） | WIRING §3 的 8 条测试 |
| A-11 | sherpa-onnx `utilityProcess` 推理服务（ASR + TTS），模型下载校验 | B05→B11 | meeting-mode M2 | 3–5 | B05 结论 | N5095 上 ASR+TTS 同时运行 CPU 不超过 2 核 |
| A-12 | 设备密钥 + 可信设备签名链（X1） | B27 | remote-control §4 | 3–4 | 无 | 私钥只在 safeStorage；签名链加入 / 撤销的验证单测 |
| A-13 | SyncEnvelope + 回执状态机 + 补取（进程内假传输，X2） | B28 | remote-control §5 | 4–6 | A-01、A-12 | 「只有 applied 才显示已停止」；过期 revision 返回 stale；乱序 / 重复 / 缺页测试 |

### B04 实测新增的卡（门 B 前必须完成，详见 `../b04-runtime/README.md` F1–F11）

| 卡 | 标题 | WBS | 估算 | 验收（摘要） |
| --- | --- | --- | --- | --- |
| **A-14** | **升级 Codex 固定版本**（0.144.1 对 ChatGPT 账号已不可用）：重新生成 app-server 协议类型；版本门改为「已验证区间」；**重新设计 Codex 授权映射**（`untrusted` 已被 0.156.1 弃用：改为 `on-request` + 沙箱，越出沙箱请求由宿主按 grant 裁决） | B10 | 3–5 | 用当前 Codex + 账号可用模型跑通 B04 的 S1–S6；adapter 测试通过；授权映射有单测 |
| **A-15** | Claude 默认模型失效（`claude-sonnet-4-20250514` → `model_not_found`）：更新默认值，改为从 SDK / 账号动态取可用模型 | B10 | 1–2 | 未配置模型的新用户能直接启动 Claude worker |
| **A-16** | Codex 写入批准缺路径：adapter 缓存 `item/started` 的 fileChange 条目，按 `itemId` 关联路径后再交给 `task-authority` | B10、B18 | 1–2 | Windows 沙箱写失败后的越出请求能按路径正确批准 / 拒绝 |
| **A-17** | 用户级 hooks（如 AhaKey `PermissionRequest`）可绕过宿主授权。**已定（D13）**：AhaKey 只是批准入口，hook 把请求转给宿主、由宿主按 grant 裁决，不直接 allow | B18 | 2–3 | 越出 grant 的请求即使 AhaKey 按下允许也被拒 |
| **A-18** | Claude 就绪握手 15 秒超时在 N5095 上不够，且 rejection 无人处理：超时可配置 / 按设备放宽，失败走正常 `failed` 信号 | B10 | 1 | N5095 内存紧张时 Claude worker 仍能启动或明确失败，不出现未处理异常 |
| **A-19** | 中断后双终止信号（`ended:interrupted` 后又 `failed` + `ended:completed`）：adapter 去重，只保留一次终止 | B10 | 1 | 中断只产生一次终止事件；scheduler 不把用户停止当失败 |
| **A-20** | 停止后已批准未执行的命令仍会执行：停止时拒绝 / 撤销所有排队中的批准；未确认安静前 UI 显示「停止中」 | B10、B31 | 2–3 | B04 S6 对 Codex 由 partial 变 pass |

这 7 张卡合计约 11–17 人日，加上首批 14 张卡，合计约 **46–67 人日**。

首批 14 张卡合计约 **35–50 人日**。按 2 人并行约 4–5 周；按 1 人 + Agent 协作约 5–7 周。**这不是发布日期**。2026-10-25 补齐门 A 集成估算：B12-HOST 5–8 人日、B14-GH 3–5、M4 5–8、M6 2–3；与上述 46–67 人日合计为 **61–91 人日**，详见 `cards.csv`。

### 并行分组（避免同一文件多人改）

| 组 | 卡 | 主要触及目录 |
| --- | --- | --- |
| 领域与存储 | A-01 → A-02 → A-03 → A-04 | 新增 `electron/domain/`；`meeting-repository.ts` 只读 |
| 界面 | A-05、A-06、A-07 | `src/components/TasksView.tsx`、`src/lib/task-columns.ts`、`ApprovalCard.tsx` |
| 语音 | A-08、A-09、A-11 | `src/lib/speech-session.ts`、`src/hooks/useVoiceCapture.ts`、新增 `electron/voice/` |
| 运行时 | A-10 | `electron/backends/claude-code-adapter.ts`、`codex-adapter.ts`、`worker-scheduler.ts` |
| 跨设备 | A-12、A-13 | 新增 `electron/sync/` |

PR #49 不按单个巨型 PR 直接续审，拆成四线：① Windows terminal daemon 与持久会话；② 本地终端工作区 UI；③ Worker CLI 桥；④ 品牌图标、主题与研究文档。③ 必须先 rebase 到 A-20 的严格停止语义，验证撤销批准、无新工具调用和进程树退出后再独立评审；①②④ 不携带 Worker 授权语义，可并行。每线都要保留 Windows daemon 与打包 smoke，不能用类型检查代替。

A-06 是最小的一张卡，**也是 A/B 闭环的验收载体**：按规格应该先由系统在门 A 里读 Issue、语音澄清、形成 TODO，再在门 B 里实现。如果为了尽早验证工程链路而先手工实现，会失去它作为自举验收的意义——建议**保留给闭环用**，不提前手工做。

## 3. 关键路径

```
B03 评审 ─▶ A-01 ─▶ A-02 ─▶ A-03 ─▶ B12-HOST ─┐
                  ├─▶ B14-GH ─────────────────┤
                  └─▶ A-04 ─▶ A-07 ───────────┤
B07 走查 ─▶ A-05 ───────────────────────────├─▶ 门 A 联调
A-08 ─▶ A-09 ─▶ M4 ─────────────────────────┘   （读 Issue → 语音澄清 → TODO →
M6（A-08/A-11 后真机验收）────────────────────┘    当前版本确认 → 重启仍一致）
B04 严格复验 ─▶ A-14–A-20 ─▶ B10 ─▶ 门 B
```

门 A 不依赖 B04；**门 B 依赖 B04**。所以 B04 授权越早，门 B 越早。

## 4. 项目管理方案

### 4.1 工具与对象

| 对象 | 放在哪里 | 说明 |
| --- | --- | --- |
| WBS 工作包（B01–B42） | GitHub Project（看板），每包一张 draft item，不建 Issue | 字段：`WBS`、`门`、`规模`、`主责角色`、`状态`、`证据链接` |
| 实施卡（A-01…） | **GitHub Issue**，挂到对应 WBS item | 模板见 §4.3；一张卡一个 PR 为宜 |
| 产品决定 | `docs/ahastudio/09-*` 决策记录（追加，不改历史） | 每条有编号和日期 |
| 技术决定 | `docs/adr/NNNN-*.md`（新建目录） | 例如「选定运行底座」「加密库」「项目身份」 |
| 证据 | `docs/c0/results/`、`docs/c0/evidence/`，之后改 `docs/evidence/<WBS>/` | JSON + 日志 hash；大文件不入库 |

规格 12 说「默认不为每个实施细节创建 GitHub Issue」——这里只为**实施卡**建 Issue，卡内的细分任务留在 Issue 的 checklist 里，符合该规则。

### 4.2 状态与完成定义

实施卡状态沿用产品自己的五阶段（吃自己的狗粮）：待设计 → 待执行 → 执行中 → 测试中 → 已完成。

**完成定义（DoD）**：

1. `npm run typecheck`（两端）和 `npm test` 全过；Windows 和 macOS 至少各跑一次（CI 覆盖之前手动跑）。
2. 新行为有确定性测试；测试验证可观察行为，不镜像实现。
3. 卡片的验收条款逐条有证据（测试名、截图、日志）。
4. **独立复核**：由另一人或另一个 Agent 会话复核 PR，只读需求、验收和 diff。
5. 合并到 main 后才算「已完成 · 已合并」；只有 PR 通过不算。

### 4.3 实施卡模板

```markdown
## WBS / 卡号
B08 / A-03

## 目标
一句话。

## 设计依据
docs/c0/b03-contract/README.md §6

## 允许修改范围
electron/domain/**、tests/domain/**；不改 electron/meeting-repository.ts

## 验收
- [ ] …（可检查）

## 不做
…

## 额度与权限
不调用付费模型 / 需要 xx 授权

## 回退
删除 electron/domain/migration 投影目录即可
```

### 4.4 分支与 PR

- `main` 受保护；功能分支 `feat/<卡号>-<短名>`，设计文档分支 `docs/<主题>`。
- 一张卡一个 PR，PR 描述引用卡号和设计文档段落。
- 大于 600 行的 PR 拆分（schema 与调用方分开）。
- 用户自己的未提交改动（如 `electron/main.ts`）不碰。

### 4.5 节奏

- **每周一次 30 分钟评审**：看 Project 看板上「测试中」和「需要我决定」；产品决定当场记入 09。
- **每两周一次门检查**：对照 WBS 门的退出条件，列证据，缺什么写什么。
- 设计文档变更与规格冲突时，按规格 10 末尾的规则：以决策记录最新明确决定为准。

## 5. 开工前置清单

| # | 项 | 状态 | 负责 |
| --- | --- | --- | --- |
| P1 | Windows 与 macOS 干净安装基线 | macOS ✅；Windows ✅（安装 / 类型检查 / 构建通过；测试 34 失败由 A-00 处理） | 技术 |
| P2 | Node 22 固定（CI 与本地一致） | macOS ✅；Windows 便携 Node 22.23.4 已就绪（`%USERPROFILE%\aha-c0\node22`） | 技术 |
| P3 | CI：Windows + macOS 双平台 typecheck + test | ❓ 需要核对现有 GitHub Actions | 技术 |
| P4 | B03 契约评审 | ⏳ 待评审 | 技术负责人 |
| P5 | B07 原型走查 | ⏳ 待走查 | **用户** |
| P6 | B04 / 真实冒烟预算与账号授权 | ⏳ | **用户** |
| P7 | 独立音色是否跨设备一致 | ⏳ | **用户** |
| P8 | f5d88aa 路由语义确认 | ⏳ | **用户** |
| P9 | 首个验收 Issue 链接 | ✅ [#48](https://github.com/ShawnyinsGit/ahastation-internal/issues/48) | — |
| P10 | 是否把 Paseo 纳入跨设备传输候选 | ⏳ | **用户** |
| P11 | 是否允许在用户仓库写 `.ahastudio/project.json`（跨设备识别项目） | ⏳ | **用户** |
| P12 | `docs/adr/` 目录与首条 ADR（项目身份） | 可立即做 | 技术 |
| P13 | GitHub Project 看板与 Issue 模板 | 可立即做（需要用户同意在仓库里建 Project 和 Issue） | 技术 |
| P14 | 第二台设备（macOS Apple Silicon）用于跨设备测试 | 已有 M1 Pro | — |

## 6. 风险表

| 风险 | 影响 | 可能性 | 应对 |
| --- | --- | --- | --- |
| N5095 本地语音算力不足（ASR RTF 0.67；aishell3 需 4 线程；Kokoro 5.9） | 离线时无实时字幕、音质差、CPU 被占满 | **已确认** | 在线 ASR/TTS 为主路径，本地为离线兜底（B05 选项 A）；A-11 优先级下调，先做 A-08 的在线 TTS 接入 |
| 实体键无法在 Windows 区分按下 / 松开 | 长按录音不可用 | 中 | 低级键盘钩子或 HID 直读；样机先验证 |
| Paseo 停止不可确认 | 不能作为受控底座 | 中 | B04 一票否决规则；保留现有 adapter |
| 上游快速迭代（Paseo 两周 4 个预发布） | 依赖升级成本 | 高 | 固定版本；只用公开根导出；适配层隔离 |
| 订阅用量只有百分比 | 不能做精确硬上限 | 确定 | UI 标估算；按单 turn 最大消耗保守预留（B19） |
| 旧数据迁移误把 Coordinator 接受当用户接受 | 虚报完成 | 中 | A-01 映射规则 + 测试 |
| 跨设备 E2E 自建工作量大（XL） | 门 X 推迟 | 中 | L1/L3 先做；L2 等 B04 对照 |
| 单人 + Agent 协作时并行度有限 | 进度 | 中 | 按 §2 并行分组拆，避免同一文件多人改 |
| Codex 版本门与残留的写死版本不一致（DECISIONS P9） | 真实冒烟必然失败；补丁版本被 Worker 门误拒 | 已确认 | PR #54 合入前按 P9 修 |
| 板端目标 Debian 11 已停止安全更新（安全源已迁到 `archive.debian.org`） | 板子不再有安全补丁；CI 要改走 archive 镜像（PR #53 已改） | 已确认 | B39 决定板端是否换 Debian 12；在那之前 CI 继续用 archive |
| Codex 自带的 `zsh` 要求 GLIBC_2.34，板端只有 2.31 | 板上的 Codex 执行命令可能失败；产物检查只把它记为非致命警告 | 中 | PR #53 rebase 到 Codex 0.156.1 后，在板上实测 Codex 跑命令；不行就让 Codex 改用系统 shell，或板端不启用 Codex |
| GitHub Actions 存储额度已满（账号级，本仓库没有占用） | 手动构建和打 tag 发版都会在上传产物时失败 | 已确认 | 在账号层面清理旧 artifact 或调整额度；发版前先查 |
| 测试替身把所有 userData 指向 `/tmp`（P9 ⑤） | 并发跑测试偶发失败 | 已确认 | 每个进程一个临时目录 |
