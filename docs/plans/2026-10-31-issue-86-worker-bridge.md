# #86 Worker CLI 桥候选与验收交接

日期：2026-10-31（Asia/Singapore）。负责人 Leo。**Draft、未完成 #86；禁止据此合入或开放原生 Worker。**

## 基线和依赖

- 源仓库 [AhakeyAI/ahastation](https://github.com/AhakeyAI/ahastation)，GitHub 身份 `lin09389`。不使用 fork，不修改 #142/#146 分支。
- 刷新 main：`8770207ca4e41f3f31201d418a980593adf51efd`。
- [#142 / #85](https://github.com/AhakeyAI/ahastation/pull/142)：`6ea1fc1a752967fa19d4ddf08a50b3f75d0fc706`，OPEN Draft。
- [#146 / #130](https://github.com/AhakeyAI/ahastation/pull/146)：`ae9d27246e105c97ea72275a0cbbee91a2980fc8`，OPEN Draft。
- 独立 worktree：`C:\Users\JHJ\.codex\worktrees\issue-86-worker-bridge\ahastation-internal1`，分支 `codex/issue-86-worker-bridge`。
- 从 main 快进到 #142 的明确 SHA，再合并 #146 的明确 SHA，依赖组合提交 **`1ff0468392cfef710c13be52e9a086bd94f84b00`**。共同夹具修复由 Git 识别复用，无人工重复引入。
- **只审 #86 新增：** `git diff 1ff0468392cfef710c13be52e9a086bd94f84b00..HEAD`。面向 main 的 PR 同时含上述未合入依赖；它们不算本次独立新增能力。

已读当前 ADR 0019、`docs/c0/design/native-cli-worker.md`、Pocket Vibe 说明，及 [#86](https://github.com/AhakeyAI/ahastation/issues/86)、[#125](https://github.com/AhakeyAI/ahastation/issues/125)、[#130](https://github.com/AhakeyAI/ahastation/issues/130)、[#131](https://github.com/AhakeyAI/ahastation/issues/131) 最新原文。

IF-2 基线是 [v0.2](https://github.com/AhakeyAI/ahastation/issues/83#issuecomment-6489835342)、[来源澄清](https://github.com/AhakeyAI/ahastation/issues/83#issuecomment-6491405211)、[双方确认与结项](https://github.com/AhakeyAI/ahastation/issues/83#issuecomment-6517382900)。#83 关闭仅表示契约确认。[IF-1](https://github.com/AhakeyAI/ahastation/issues/81#issuecomment-6489503329)、[IF-4](https://github.com/AhakeyAI/ahastation/issues/79#issuecomment-6490598836) 的身份、代次、stop 优先和原生退出/业务完成分离规则继续成立。

## 逐项状态

| #86 交付 | 本候选实际实现 | 未满足的生产/验收部分 |
| --- | --- | --- |
| 1 全局 hooks → task-authority | 新增内部 `NativeWorkerHookRouter` → `NativeWorkerRun` → 既有规范化与 `evaluateTaskAuthority`；每次生成独立审批 ID，校验 session/runtime/host/attempt/凭据引用/权限与控制代次 | **全局 controlled relay 仍 deny-only**。新 router 仅为受保护传输的内部消费者，没有生产端点；观察端点/token 不能调用它。未伪造原生引擎审批已接通 |
| 2 严格停止 | 核心同步置 stop 栅栏、撤待批及未消费 permit、关闭写权，然后 interrupt，超时 terminateTree；迟到 spawn 再终止 | `NativeExecutionGuard` 尚无目标 OS 的生产实现。只有经 guard 核验的整树退出证据可写 stopped；terminate 的布尔值、根退出、EOF、Stop、回报都不算。未验证 30 秒 S6 |
| 3 G4/独立守卫 | `OutsideWriteMonitor` 对宿主明确选定的有限本地边界做前后 hash，变化、不可读、符号链接或资源超限均关闭 | hash 是检测证据，不是阻断或归因；不覆盖全盘/远端。已批准 shell 的内部行为、缺失/禁用/崩溃 hook、allow 已交付后的撤销，都需要独立强制边界。不能用该 monitor 代替 OS 沙箱 |
| 4 当前 attempt、回报、接管 | 核心逐次核当前 grant 完整性/工作区身份；permit 一次消费且绑定完整工具输入；回报同内容幂等、不同内容拒绝。接管撤旧代次、只留人工写者；交还审阅期间双方禁写，stop 不能被迟到 review 解除 | 生产唯一写者、受保护回报 CLI/通道、IF-4 本机接管/完整 diff 审阅证据和事件发布仍待接入；旧 `worker-pty` 人工终端接口不是新受控服务。没有把 core 测试当成 #111 已完成 |
| 5 准入/SDK 默认 | 默认解析、后端状态、计划 UI 和设置写入均保持 SDK；旧终端偏好保留在磁盘但不被执行。Kimi/Qoder terminal 不再声明 Worker 能力；手动终端保留 | Claude/Codex 原生入口依旧关闭；不顺带开启其他 CLI；不自动迁移/删除用户偏好 |
| 6 IF-2 | 新增 Worker 新启动专用单写服务：profile 固定目录、排他 writer lease、schema 2、entries+launches 同事务、flush+原子替换、reserve/attach/bind、CAS、attach/bind 丢回执幂等、活动 attempt 排他、保留 ended 来源；损坏/未知/缺文件为 unavailable | **尚未注册成 profile 主进程的生产统一服务**；当前 writer 仅接受 Worker 子集，不读取/覆盖 Station 或旧数组。Station owner 由 eternal904 从真实授权链提供；须共同接入唯一服务后才能混用。没有 rebind/收编迁移实现；同会话复用明确拒绝，不能绕过旧写者隔离。OS process start/boot identity 与受保护凭据尚无生产采集/传递 |
| 7 #125 信任框 | 已接入旧终端会话的卡片：命中后不贴提示词，重绘不解除，必须本机用户在终端回答后以当前 session generation 明确继续；迟到提交计时器也重验。设置默认关；app 自建 worktree 有主进程创建收据与目录身份检查，不从 env/内容自证 | 自动信任设置目前只保存偏好和限定可核验目录；**没有经过版本验证的自动确认动作，当前仍显示人工卡片**。新原生 Worker 还受总准入门关闭，未实际运行新树 → WorkReport |
| 8 #130 外部写 | 保留 #146 在真实 SDK 回调路径的逐次审批/禁内容指纹复用。新核心测试变参、重复、API 写、git push、别名、重放、stop；明确 shell 包装与混合 command/argv 不进入 native permit | 新核心未接入真实原生执行链。SDK 逐次回调审批不保证已批准脚本内部所有外部写都受控；生产 guardian 必须独立拦截后代执行/外部写，顶层 shell permit 不能授权所有后代 |
| 9 #131 只读命令+联网 | `permissionProfile=read-only-network` 接入计划/权限摘要 hash、grant hash、执行端及 UI；仅指定仓库的精确 `gh issue/pr list/view` argv 与 api.github.com。拒绝 WebFetch/API 任意方法、包装、别名、模板/浏览器/输出文件、工作区写、环境请求、工作区外/常见凭据文件读取；addendum 不扩权，rework 不能去掉档位 | 这是明确的窄档位，不是任意脚本的只读网络沙箱。真正联网成功仍需相应 SDK/受控执行环境支持；本次不调用个人 gh 登录或真实 GitHub 写入取证 |
| 10 #122 auto | Claude 无模型时仍使用 `auto`；未改默认模型选择 | 继续由现有 profile/回归覆盖 |

## 原生准入为什么仍关闭

本机只在新 worktree 的 lockfile 依赖中，以临时 HOME/USERPROFILE/APPDATA/CODEX_HOME/CLAUDE_CONFIG_DIR、隐藏 `--version` 子进程核对：

- Claude SDK 包 `0.3.150` 的 Windows CLI：**`2.1.150`**。
- Codex Windows CLI：**`0.156.1`**。

没有读取登录状态、运行模型、真实 PTY 或安装/信任个人全局 hooks。

[Claude 官方 hooks 说明](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails) 将 `onFailure:block` 的起点列为 2.1.295；不能写到 2.1.150 后假定强制门已生效。[Codex 0.156.1 固定源码](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/hooks/src/events/pre_tool_use.rs) 的无匹配与部分失败结果保留 `should_block=false`。当前 [Codex 官方配置说明](https://developers.openai.com/codex/hooks) 使用 `[features].hooks`；本候选修正了旧手动终端 profile 的 `-c hooks=true` 为 `-c features.hooks=true`。配置可列出 hook 或脚本能返回 deny，都不能证明实际引擎会强制阻断。

`native-worker/admission.ts` 给出具体阻塞；`global-hooks/protocol.ts` 的总门和 `relay.ts` 的受控 deny-only 规则保持。**没有测试开关、环境变量或传入 true 的“能力证明”可以开放生产入口。** 更新 CLI 也不自动获得准入。

下一步必须先提供真实 guard：

核心的 `persistPermissionDecision` 是必填的既有调度器持久裁决接缝：落盘失败/落盘期间 stop 都不产生 permit；本地测试注入内存记录或失败模拟，不证明生产审计已接通。接管先进入 taking-over、撤销旧权限和写权，只有 guard 的在途执行封口/唯一人工写者证据确认后才进入 human；不是按钮点击即完成。交还独立使用 handing-back，普通输入在审阅结束前保持关闭。

1. 启动前将 CLI 及全部后代纳入受控进程树；可核 OS start/boot identity；隔离/退出证据不来自 CLI 自报。
2. 受保护本机 IPC 对端和每运行受限凭据；不把 env/PID/标签/taskId 或 owned.json 字符串当授权。
3. 在实际执行边界消费一次 permit；hook 未运行、未受信、崩溃、超时、已读 allow 后 stop 均无法逃逸。后代 shell/API 写不能继承顶层授权。
4. 实际权限 owner 和当前 attempt 的变更/断连接到 `revoke()`；生产回报接到调度器候选交付路径；唯一主进程 IF-2 服务与 Station owner 接线。
5. 再接入原生 BackendSession、全局 protected relay、工作树信任动作和 IF-4 唯一控制者；期间不借旧人工 PTY 写入接口绕过。

这些不是 Shawn 点一次批准就能补齐的实现。不能为演示而把总门改为 allow。

## 可复现离线验证

使用本 worktree 和 lockfile，不借旧依赖：

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js' ci --ignore-scripts --no-audit --no-fund --maxsockets=1 --prefer-offline
& 'C:\Program Files\nodejs\node.exe' scripts/verify-worker-bridge.mjs
```

第二条完成 renderer/Electron 两侧 typecheck、两侧 build、preload 和源清单，以及经过核对的 14 组 mock/协议测试；所有显式后台子进程隐藏，测试 runner 用 `--test-isolation=none` 避免隐式测试子进程。不会调用全量 `npm test`、个人 CLI 登录探测、真实模型/可见 PTY。Windows 文件权限事务用 #85 的隐藏 PowerShell 辅助验证。专家 kickoff 也保留 SDK，不会绕过默认解析映射到 terminal。SDK 的 permission-broker 同样拒绝该窄档位下无法规范化的脚本/未知工具，不以额外 allow-once 卡片绕过档位。

机器可读结果：`docs/evidence/issue-86/local-validation.json`（绑定源码摘要、lockfile 和验证脚本 SHA256）；详细本地输出：worktree 根目录 `issue-86-validation.log`（忽略文件）。第一次安装出现 ECONNRESET；降低下载并发、使用完整性校验的 npm 缓存后安装成功，没有变更 lockfile。

远端完整三平台测试与打包通过 Draft PR 的 `build-matrix` 运行；其绿色结果也不替代真实引擎/B04。

中间 SHA `872a748` 的 [CI 41205649471](https://github.com/AhakeyAI/ahastation/actions/runs/41205649471) 在 Mac 的新归属 fixture 失败：临时目录经过 `/var → /private/var` 别名，被已有私有目录保护正确拒绝。修复仅规范化本测试自行创建的临时根目录；生产符号链接拒绝和断言保持，后续候选须重新跑完整矩阵。

## Shawn 指定验收与停止点

当前候选不具备开始真实 Worker 验收的条件。guard/生产接线完成后，提供新候选的精确 SHA、二进制与配置摘要、测试和 CI 链接，再由 Shawn 安排：

1. **Mac Claude / #86：** 新建本应用 worktree；记录真实 CLI 版本、profile、runtime/attempt/owner 引用（不得公开密钥）；信任框期间确认无任务 paste/回车；人工确认或已核验自建目录路径通过后绑定真实 session；工具先过权限门；`aha-worker report` 只进入当前 attempt 候选，原生 Stop/EOF 不算成功；Shawn 复核结果。
2. **N5095 Claude、Codex / #109 B04：** 分别跑 S1–S6/S8/S11。只用自有 local/synthetic 目标，外部写每次审批，测试批准后撤权/stop、迟到报告、旧 host/runtime/凭据、脚本缺失/禁用/未受信/崩溃、子进程仍存活和重连。S6 核 30 秒内无新工具/无越界文件变化/整树退出的独立证据。S4–S6 任一失败则继续 SDK。
3. **证据包：** 候选 SHA、平台/CLI 版本与配置摘要、IF-2 事务 revision、去敏裁决流水、原生 session/attempt 与回报回执、进程树退出证据和 sentinel hash 时间线、Shawn 结论；不要上传 token、原始个人日志或个人配置。

本任务不替 Shawn 作 Mac/N5095 验收，不自行合并、关闭关联 Issue 或解锁 #109/#111/#112/#114。普通中间状态留在本对话，最终给主对话精确 SHA 与证据供独立审查。
