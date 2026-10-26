# A-14–A-20 运行时修复：验证清单与调研接力

日期：2026-10-25。修复分支：`fix/runtime-a14-a20`（提交 `ac4a1e7`，基线 main `c8295b9`）。
执行设备：N5095 / Windows 11（主力验证机），macOS 可作对照。

**当前证据级别**：macOS 基线 934 通过 / 0 失败 / 1 跳过。2026-10-25 Windows 11 / Node 22.23.4 最终首轮回归为 937 tests、931 pass / 0 fail / 6 skipped，typecheck 与完整 build 通过；最终代码二次回归见准入文档。
**Windows 实机**：Codex 0.156.1 真实握手及 Worker/Host turn 通过；Claude 账号默认模型 Worker/Host 通过并发现 13 个模型。两 provider 的严格 S4/S5/S6、真实宿主 kill 的 S8 均通过。
**追加修复**：实测否决 Codex `workspace-write`，改为 `read-only + on-request`；worker 停止关闭会话并在 Windows 终止完整进程树；语音润色旧默认模型同步清理。B04 原始证据在 handoff `docs/c0/b04-runtime/results/`，开发准入入口为 `docs/c0/DEVELOPMENT-READINESS.md`。

## 0. 环境准备

```powershell
git fetch origin
git checkout fix/runtime-a14-a20
npm ci                 # qoder 下载失败时才加 QODER_SKIP_DOWNLOAD=1
npm run typecheck      # 期望：两侧静默通过
npm test               # macOS 基线 934 过 / 0 失败 / 1 跳过；Windows 记录差异
```

- Node 用 22.x（开发机验证用 22.23.4）。
- 记录 Windows 首次全量测试的通过/失败数，失败按 PR #47 的分类法归类（CRLF/ps、Kimi 路径、Qoder watch、symlink 权限、其他）。
- B04 harness 在 `docs/c0-handoff-2026-10-22` 分支的 `docs/c0/b04-runtime/`，结果写回该分支 `docs/c0/results/`。

## 1. 真实账号 B04 复跑（最高优先级）

用 B04 的 10 场景矩阵跑**本分支**的 C-A（现有 adapter），Claude 与 Codex 各一遍。判分标准按 `scenarios.json`，不要再沿用旧 runner 里"S6 已确认停止但有新调用记 partial"的宽松分类——**停止后有新工具调用即 fail**。

- [x] S1 创建 / S2 追问：两 provider 通过（2026-10-25 真实结果见 handoff `b04-runtime/results/`）
- [x] S3 批准 / S4 拒绝 / S5 越界：Codex `on-request + read-only` 下宿主按真实 paths 裁决；test/ 与仓库外文件未被改
- [x] **S6 停止（持续写文件场景）**：停止确认后 30 秒内 0 次新工具调用、0 文件变更；子进程树退出
- [x] S7 进程内 n/a / S8 宿主重启恢复：独立宿主真实 taskkill 后按同一原生 session 恢复
- [x] S9 用量：adapter 尚无 usage 信号（A-10）；协议原始通知与脱敏 fixture 已归档，未虚报为已接线
- [x] S10 证据：diff、测试输出与文件 hash 一致

2026-10-25 实测修正：`on-request + workspace-write` 会让 Codex 不经宿主直接修改 `test/`，S4 安全否决失败，因此该方案废弃。worker 改为 **`on-request + read-only`**，所有写入都升级为带真实路径的宿主批准；只读命令仍可直接执行、不要求全量可见。

## 2. 逐卡验证

### A-14 Codex 升级与授权映射
- [x] ChatGPT 账号、不手动配置模型，Codex worker / Host 均能启动并完成只读回复或 fixture 任务
- [x] 版本门：真实 0.156.1 接受；0.144.1 与 0.157.0+ 拒绝由单测覆盖
- [x] `approval_policy=untrusted` 相关报错不再出现；worker 在 read-only 沙箱内运行，所有写入经宿主按目录批准
- [x] 真实 app-server 握手字段与协议类型一致，见顶部证据

### A-15 Claude 模型
- [x] 删除手动模型配置后，Claude worker / Host 均能启动；Host result 与 13 个动态模型已归档
- [x] 会话初始化后 capabilities 更新为账号真实模型目录（Host 实测）
- [x] 显式模型不被旧静态列表降级（adapter 单测）
- [x] 语音润色旧默认模型已清理为当前 `claude-sonnet-5` 别名；显式 `anthropicModel` 仍优先

### A-16 fileChange 路径关联
- [x] Windows 只读沙箱写入批准含真实 paths（S1/S4/S5 原始 permissions）
- [x] 只写 `src/` 的任务中 `test/` 与仓库外写入均被拒
- [x] 无法关联 itemId 的请求保持无路径并 fail closed（单测 + broker 混合路径测试）

### A-17 hooks 不得绕过宿主（保留 AhaKey 环境测）
- [x] 保留本机 AhaKey 设置，真实 S3/S4/S5 均由宿主裁决，hook 不再直接放行
- [x] Claude 订阅 OAuth 正常；`settingSources` 与 MCP/subagents 配置保留（真实启动 + 配置单测）
- [x] 终端模式未加 `disableAllHooks`，既有 Stop hook 回归测试通过
- [ ] AhaKey 自身产品的独立端到端行为不在本仓库验证范围内，需其产品侧验收

### A-18 就绪超时
- [x] N5095 默认 60s 下 worker / Host 均启动，不再出现 15s 超时或未处理异常
- [x] `extra.initializationTimeoutMs=25` 稳定复现超时并走正常 failed（单测）

### A-19 中断单终止信号
- [x] 真实 S6 只有 `ended:interrupted`，没有后续 failed + completed 矛盾对
- [x] steer 不产生终止信号，同会话继续（单测）

### A-20 停止撤销批准
- [x] 未答复批准立即 decline 并发出 permission-cancelled（Codex adapter 单测）
- [x] 停止后的新批准直接 decline；真实 S6 无新工具与文件变化，Windows 子进程树归零
- [x] 已 accept 未执行动作由中断 + 进程树终止覆盖；"未确认安静前显示『停止中』"UI 与跨端 applied 状态已纳入实施设计

## 3. 调研与设计接力（开工准备 vs 开发期验收）

- [x] 在线 ASR/TTS 桌面选型与成本模型（含费用硬上限）已完成；真实首包/打断/账单是 A-08 接入后的验收，语音 API 额度另行授权
- [ ] N5095 实机 AEC / barge-in（需有人在场）：依赖 A-08 的 WebAudio 实现，列为 A-08/M6 验收而非开工前项目
- [x] 双 provider 并发创建完成，CPU/RSS/句柄样本已归档；语音 + 多 agent 负载仍归 M6
- [x] 契约三缺口设计：唯一写者 fencing、多事件原子写/崩溃恢复、停止 applied；ADR 编号冲突治理完成
- [x] 跨设备安全评审、ADR 0002 接受、自建传输 26–41 人日估算完成
- [x] B06 已用 Codex 0.156.1 / 当前 Claude CLI 采集真实用量与窗口字段并归档脱敏 fixture
- [x] WBS 已补 M4/M6/B12/B14 估算与关键路径；PR #49 按四线拆分，Worker 桥按 A-20 语义另审

### 在线语音桌面调研（2026-10-25，公开资料，不代替实测）

| 候选 | 中文多音色与延迟 | 公开后付费单价 | 初步判断 |
| --- | --- | --- | --- |
| 讯飞 IAT + 在线 TTS | 已有 IAT 接入；在线 TTS WebAPI 覆盖中文、方言及多语种发音人 | 公开页面未给出可稳定引用的统一后付费单价，需以账号控制台报价为准 | 集成成本最低，保留为基准组；先复用现有账号做延迟与成本实测 |
| 豆包语音 2.0 | 大模型 TTS 325 音色、传统 TTS 84 音色；官方标称首包分别约 600 ms / 300 ms | 流式 ASR 1 元/小时；大模型 TTS 3 元/万字符 | 中文音色和国内接入优先候选；单向流式 PCM 可直接进入 WebAudio，双向流式不支持 SSML |
| Azure Speech | 中文神经音色完整，实时 ASR + 流式 TTS | 实时 ASR 1 美元/小时；标准神经 TTS 15 美元/百万字符 | 国际价格基准与备选；国内网络首包、稳定性必须实测后判断 |

来源：[豆包产品简介](https://www.volcengine.com/docs/6561/1257543?lang=zh)、[豆包计费说明](https://www.volcengine.com/docs/6561/1359370)、[豆包单向流式 TTS](https://www.volcengine.com/docs/6561/2534913?lang=zh)、[Azure Speech 价格](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/speech-services/)、[Azure 语言与音色](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)、[讯飞在线 TTS](https://www.xfyun.cn/services/online_tts)。价格为 2026-10-25 页面快照，不含汇率、税费、免费额度与资源包折扣。

成本模型：`会议费用 = ASR 秒数 / 3600 × ASR 小时价 + TTS 字符数 / 10000 × TTS 万字符价`。例如 1 小时会议含 20 分钟用户语音、1.2 万字符助手播报，按豆包后付费计算约 `1/3 × 1 + 1.2 × 3 = 3.93 元`；该例只是预算模型，不是实测账单。

“会议无费用上限”必须改为应用内硬约束：分别累计 ASR 音频秒数和实际送合成字符数（含失败重试与 SSML 标签），设置每会议及每日预算；达到 80% 提醒，达到 100% 停止云端调用并降级本地语音，而不是只弹提示后继续扣费。断线重连不得重复提交同一文本；预算、单价快照和用量需写入会议摘要，后台任务也必须受同一预算器约束。

下一步实测统一使用 3 组固定中文文本（短句、混合中英数字、长段落）和 4 个音色，记录 `首包 → WebAudio 可播放`、取消请求到静音的打断延迟、字符账单及失败重试量；ASR 同段音频比较首字/终字延迟和准确率。只有公开标称延迟，不能勾选“实测完成”。

### 契约与跨设备协议评审（2026-10-25）

评审对象：handoff 分支的 `b03-contract`、`design/remote-control.md`、ADR 0002。当前设计方向可保留，但以下内容应先补入契约再实现：

1. **唯一写者要落到每次写入**：主持租约的 `epoch` 不只保护阶段计划，也要保护所有改变项目聚合的命令；执行端持久化已见最大 epoch，旧 epoch 永远拒绝，租约超时不能作为自动接管依据。Grant 的动作批准与计划确认继续分权。
2. **多事件命令必须是一个持久化批次**：B03 目前允许一个命令产生多个聚合事件，却未定义原子性。增加 `batchId / batchCount / commandId`，同一批次在日志与接收端都全量提交或完全不应用；缺事件时保持 pending 并补取，崩溃重放按 `commandId` 幂等。B03「命令本身不持久化」与远端 `recorded` 回执冲突，应改为命令先写本地 journal，事件批次与命令结果在同一事务完成。
3. **停止和撤销分开建模**：撤销 Grant 只禁止新动作；停止 Run 需要 `StopRun` 的 `applied/rejected` 回执。只有执行端确认中断已生效、停止后无新工具调用且子进程树退出，才能把 `applied` 映射成「已停止」，否则保持「停止中/状态未知」，直接承接 A-20 的严格验收口径。
4. **ADR 0002 暂不宜转正**：`SyncEnvelope` 还缺 `keyId`、算法/协议版本与规范化签名编码；需明确项目密钥轮换后旧事件仍可解密、新事件只用新 `keyId`，设备撤销只轮换后续内容密钥。配对码必须短时、一次性并显示两端安全码核对；可信设备链要有链 hash 与防重放序号。完成这些协议字段和故障测试后再转 Accepted。
5. **ADR 编号治理**：main 与 handoff 已存在两个不同的 0001。不要重排已被引用的历史 ADR；在联合 ADR 索引登记冲突，后续新编号从 0005 起单调分配，0002 保持原编号并补安全评审记录。

自建传输工作量粗估（含确定性测试，不含两台真机等待）：X1 身份/配对 3–5 人日，X2 信封/回执/补取 5–8，X3 租约/fencing 3–4，X5 WebSocket 中继/重连/离线信箱 8–13，X6 恢复凭据 3–5，X8 双机故障测试 4–6，总计 **26–41 人日**。X2 应先用假传输完成乱序、重复、崩溃和停止未知测试，再接 X5，避免把领域一致性与网络问题混在一起。

## 4. 证据归档

- 原始结果：`docs/c0/results/`（handoff 分支），命名沿用 `ahastation-<日期>-*`。
- 每项打勾必须附：命令、环境（设备/OS/Node/CLI 版本）、结果文件链接。没有证据的项目保持未勾。
- 真实账号注意脱敏：不要提交 token、cookie、含密钥的配置。
