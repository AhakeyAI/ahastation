# A-14–A-20 运行时修复：验证清单与调研接力

日期：2026-10-25。修复分支：`fix/runtime-a14-a20`（提交 `ac4a1e7`，基线 main `c8295b9`）。
执行设备：N5095 / Windows 11（主力验证机），macOS 可作对照。

**当前证据级别**：macOS arm64 单元与集成测试 934 通过 / 0 失败 / 1 跳过，typecheck 两侧通过。
**尚未证明**：真实 CLI + 真实账号行为、Windows 行为、N5095 性能。下面每项都要留下证据再勾掉。

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

- [ ] S1 创建 / S2 追问：两 provider 通过
- [ ] S3 批准 / S4 越界 / S5 拒绝：Codex 新 `on-request` 映射下，宿主能收到越界请求并按目录裁决；test/ 等未授权文件不被改
- [ ] **S6 停止（必须用写命令场景）**：停止确认后 30 秒内 0 次新工具调用、0 文件变更；子进程树退出
- [ ] S7 断线补历史 / S8 宿主重启恢复：**S8 要真实杀宿主进程**，不接受手工 resume 代替
- [ ] S9 用量：记录 adapter 是否输出用量（B06 缺口不因本修复改变，如实记录）
- [ ] S10 证据：报告与真实文件一致

预期差异说明：worker 现在是 `on-request + workspace-write`，**沙箱内命令不经过宿主**是设计如此（与 Paseo auto 的语义区别要在报告里写清楚：宿主对越界有裁决权，而不是全量可见）。

## 2. 逐卡验证

### A-14 Codex 升级与授权映射
- [ ] ChatGPT 账号、**不手动配置模型**，Codex worker 能启动并完成任务（原 F1/F2 全 blocked 路径）
- [ ] 版本门：0.156.x 接受；0.144.1 与 0.157.0+ 报清晰错误（单测已覆盖，实机确认错误文案）
- [ ] `approval_policy=untrusted` 相关报错不再出现；worker 沙箱内可写，越出沙箱必须经宿主批准
- [ ] 记录 app-server 实际握手字段，若与手工维护的协议类型有出入，补协议类型（本卡遗留项）

### A-15 Claude 模型
- [ ] 删除手动模型配置后，Claude worker / Host 均能启动（原 F3 model_not_found 路径）
- [ ] 会话初始化后，设置里的模型列表变为账号真实可用模型（capabilities 动态刷新）
- [ ] 显式填写一个不在旧静态列表里的模型，能正常使用、不再被降级
- [ ] 遗留：`electron/asr-polish.ts:55` 仍有旧默认模型（语音润色），另立清理项，不在本卡验收内

### A-16 fileChange 路径关联
- [ ] Windows 上 Codex 沙箱内写失败后请求越出写入时，批准卡片显示**真实文件路径**（原来只有 reason/grantRoot）
- [ ] 批准只写 `src/` 的任务，越出 `src/` 的写入仍被拒/需升级
- [ ] 无法关联 itemId 的请求保持无路径、按拒绝处理（单测已覆盖，实机抽查一次）

### A-17 hooks 不得绕过宿主（保留 AhaKey 环境测）
- [ ] 保留 `~/.claude/settings.json` 的 AhaKey PermissionRequest hook，Aha 会话内**宿主收到全部权限请求**，hook 不再直接放行
- [ ] Claude 登录态（订阅 OAuth）不受影响；用户 subagents / MCP 仍可用
- [ ] 终端模式（claude-code-terminal）的 Stop hook 仍工作（该路径未加 disableAllHooks，属预期）
- [ ] 确认 AhaKey 自身产品的行为不变：本修复只影响 Aha 拉起的会话

### A-18 就绪超时
- [ ] N5095 内存紧张时 Claude 启动不再因 15s 超时失败；默认 60s 生效
- [ ] 用 `extra.initializationTimeoutMs` 调小（如 25ms）能稳定复现超时，且 UI/调度收到正常 failed 而非未处理异常

### A-19 中断单终止信号
- [ ] 真实中断一个 Claude worker turn：事件流只有 `ended:interrupted`，不再出现 `failed: claude-turn-failed` + `ended: completed` 的矛盾对
- [ ] steer（追问）行为不变：不产生终止信号，会话继续

### A-20 停止撤销批准
- [ ] 停止时有未答复的批准请求 → 立即收到 decline，UI 出现 permission-cancelled
- [ ] 停止后 CLI 再发批准请求 → 直接 decline，不再打扰用户
- [ ] **已知边界（需补做，不在本卡已修范围）**：已 accept 未执行的命令协议上无法撤回，依赖中断+进程终止；`transport.close()` 目前只对 app-server SIGTERM。**进程树终止验证**与"未确认安静前显示『停止中』"UI 是后续工作，验证时如实记录行为

## 3. 验证后的调研接力（全部关闭才进功能开发）

- [ ] 在线 ASR/TTS 选型实测：中文多音色、首音延迟、打断延迟、单价；补语音成本模型（含"会议无费用上限"对策）
- [ ] N5095 实机 AEC / barge-in（需有人在场）：应用内 WebAudio 播放 + Chromium AEC 后，播报中说话能否可靠打断（A-08/M6 验收）
- [ ] N5095 语音与多 agent 并发性能（CPU/RSS/句柄）
- [ ] 契约三缺口设计：多设备唯一写者、多事件命令原子写/崩溃恢复、撤回确认事件；ADR 编号冲突治理
- [ ] 跨设备协议安全评审（keyId 轮换、配对、租约分区）；ADR 0002 转正；自建传输工作量估算
- [ ] B06 在**新版协议**上重验用量字段（Codex 0.156.1 / 当前 Claude CLI）
- [ ] WBS 重排：补 M4/M6/B12/B14 估算与关键路径；PR #49 按四线拆分（Worker 桥须按 A-20 语义返修后另审）

## 4. 证据归档

- 原始结果：`docs/c0/results/`（handoff 分支），命名沿用 `ahastation-<日期>-*`。
- 每项打勾必须附：命令、环境（设备/OS/Node/CLI 版本）、结果文件链接。没有证据的项目保持未勾。
- 真实账号注意脱敏：不要提交 token、cookie、含密钥的配置。
