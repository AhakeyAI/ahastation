# #85 全局 hooks：实现、独立审查与验证

日期：2026-10-29（Asia/Singapore）。本稿记录实现与两轮独立验证；交付代码供源仓库草稿 PR 审查。没有修改真实 CLI 配置、写入信任记录、调用模型、发布安装包或关闭 Issue。

## 基线与权威输入

- 工作区：`C:\Users\JHJ\.codex\worktrees\issue-85-global-hooks\ahastation-internal1`。
- 分支：`codex/issue-85-global-hooks`；HEAD/实现基线：`fcc7ac2d09808c667e8a2b96f4f65ece7eb48785`，不含未提交实现。
- 开工实时检查：main 为上述提交；#135 仍 OPEN/Draft，head `cab02491596be9ce71774210e1b3ebf89abd9b88`，未合入。不在本任务合并 #135、不重做 #57–#59。主协调任务最终提交前须刷新整合基线。
- 收尾实时刷新：main 仍 `fcc7ac2`；#135 head 已前进至 `f448a7a3f74fd38429f034c848e45aed2967e68c`，仍 OPEN/Draft、mergedAt=null。本工作区未重置/合并该整合分支。
- [#85](https://github.com/AhakeyAI/ahastation/issues/85) 为 OPEN；唯一正式前置 [#81](https://github.com/AhakeyAI/ahastation/issues/81) 已 CLOSED。使用[已发布 IF-1 v0.1.0](https://github.com/AhakeyAI/ahastation/issues/81#issuecomment-6489503329)、[消费者确认](https://github.com/AhakeyAI/ahastation/issues/81#issuecomment-6489857515)、[结项说明](https://github.com/AhakeyAI/ahastation/issues/81#issuecomment-6491014249)。发布正文的“待确认”是历史状态。
- 读取 [ADR0019](https://github.com/AhakeyAI/ahastation/blob/cc562fefce2c6666bd382a5cd5a7a5faaef92f2f/docs/adr/0019-native-cli-workers-with-host-hooks.md) 与[变更说明](https://github.com/AhakeyAI/ahastation/blob/cc562fefce2c6666bd382a5cd5a7a5faaef92f2f/docs/c0/design/native-cli-worker.md)；它们尚未出现在本次 main 的相应路径，读取了指定设计 ref，未复制旧草稿覆盖本地。
- #83 IF-2 v0.2 尚待使用方全部确认。本任务不实现 owned.json 写入服务、reserve/attach/bind 或完整 Worker CLI 桥，不将 #83/#93/#103/#136 或完整 UI 作为 #85 的新增前置。

## 变更与行为

| 路径 | 责任 |
| --- | --- |
| `electron/global-hooks/installer.ts` | 严格 JSON 编辑、标记项合并、加密备份、升级/卸载、锁与事务恢复、真实 Codex feature 探测 |
| `electron/global-hooks/file-security.ts` | Windows 创建时附带访问权限、配置替换前复核；私有状态目录及已有文件权限校验 |
| `electron/global-hooks/relay.ts` | 普通观察的有界尽力投递；固定受控入口拒绝；CLI stdout 只含协议输出 |
| `electron/global-hooks/protocol.ts` | IF-1 去敏输入、供应商拒绝映射、不可开启的原生 Worker 准入门 |
| `electron/global-hooks/host.ts` | 仅 loopback 的观察 ingress、有界队列、授权分类回调、IF-1 snapshot/cursor 与缺口处理 |
| `electron/backends/terminal-cli-adapter.ts` | 真正的受控任务启动前准入拒绝，发生在文件写入、binary resolution、PTY spawn、任务提示词注入之前 |
| `scripts/global-hooks.mjs` | 可实际调用的显式安装/升级/卸载命令；按内容摘要复制独立 relay，避免后续清理 dist 导致脚本消失 |
| `scripts/probe-global-hooks.mjs` | 精确二进制的隔离无模型探测：版本、feature、hooks/list、命令壳与延迟、卸载 |
| `tests/global-hooks*.test.mjs` | 配置恢复、后改内容、故障恢复、授权分流、失联、队满、重放、停止语义和启动拒绝 |

### 配置安全与恢复

Claude 修改指定配置目录的 `settings.json`；Codex 修改指定配置目录的 `hooks.json`。只追加四类事件的 matcher group，command 尾部含 `--aha-studio-global-hooks-v1` 标记；侧文件记录精确所属 group、配置绝对路径、profile、版本、安装后摘要和加密原始内容。JSON 无注释块，故不添加供应商未知的自定义字段。

- 严格解析 JSON，拒绝损坏、重复键、错误根类型/事件结构与超过 4MiB 的配置；不以全文字符串替换编辑 JSON/TOML。JSONC 暂不支持，遇到即停写并返回诊断码。解析错误不回显配置片段。
- 保留其他设置和用户 hooks。未后改时，卸载逐字恢复原文件（含 BOM/CRLF/缩进）；原文件不存在则删除新建配置文件。后改时仅移除仍精确属于本应用的项，保留新增设置、用户 hook、对本应用 command/matcher 的修改；`retainedEdits` 提示人工复查。升级也携带安装后的用户改动，不能恢复成最初的过期快照。
- 所有配置变更前保存 AES-256-GCM 加密备份；事务记录也加密，随机 IV，密钥单独保存。备份记录上一配置/manifest/owner，支持追溯升级。POSIX 文件 mode 0600、目录 0700；Windows 的配置临时文件通过 .NET Framework 的 [FileStream(FileSecurity) 构造函数](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.-ctor?view=netframework-4.8)在创建时带上原访问规则、继承保护、owner/group，校验成功才写入内容，再原子替换；不靠先写入再收紧权限。新状态目录在创建时仅给当前用户和 SYSTEM 访问；校验已有状态时只接受当前用户所有、允许规则限当前用户/SYSTEM/Administrators 的私有目录及文件。权限提供程序不可用、无法保留原权限或发现已有宽权限文件时拒绝继续。备份密钥与密文都须保管，这不构成对同用户恶意进程或管理员的隔离。
- 每次操作先取得整个 `stateDir/install.lock`，再取配置路径的 `wx` 排他锁。共享密钥、manifest、journal 的读取/恢复/提交均在状态锁内；不同配置目录共用状态目录时不能并发覆盖记录。一个 stateDir 的同一 agent 只绑定一个配置/profile；需要同时保留多个配置，分别指定独立 stateDir。owner 侧文件继续阻止同一配置由另一 profile/stateDir 叠装。两家 CLI 的配置不是跨文件原子事务。
- 同目录唯一临时文件、fsync、rename；普通 I/O 失败尽力恢复原配置，进程中断留下加密 journal。下次同 profile 的 install/uninstall 会恢复；若配置已被其他编辑器改动，则拒绝覆盖并保留 journal。备份/锁不能解决不合作编辑器在最后一次比对与 rename 之间的所有 OS 竞态；真实启用时应关闭配置编辑器。没有用时间/PID 猜测删除陈旧锁。
- 拒绝 symlink/junction 配置及运行时路径；测试机无创建文件 symlink 的权限，因此相应测试报告了能力限制，不能计为已验证 Windows symlink 防护。
- 卸载清掉所属配置项、owner、manifest、事务锁；保留加密历史、密钥和版本化 runtime 供回滚。若用户改过 command 仍引用 runtime，必须先人工确认再删除；不递归清理其他任务文件。

### 普通观察与受控拒绝

普通入口只传 session/event/toolName/turn/toolUse/invocation 的最小元数据，不传 cwd、transcript_path、工具输入/输出、命令、prompt、回答、provider agent 身份。宿主关闭（endpoint 不存在）时，连 stdin 都不等，空 stdout、exit 0；有 endpoint 时总预算 40ms，包含 stdin/连接与加载 HTTP 的预算，不重试、不 DNS、不衍生投递进程。调度延迟与进程/命令壳启动不在 JS timer 的保证内。

观察仅入有界队列：16KiB 包上限、默认 128 包、32 连接、限时读取；鉴权失败、Origin 浏览器调用、未知字段、队满等均拒绝/丢弃，不能触发审批。独立观察 token 不具备管理或执行权限，不进 URL/日志。relay 不读响应内容，也不消费任何允许回执。

`GlobalHookHost` 的 `classifyAuthorized` 必须由宿主接入本机扫描授权及 IF-2 三值查找：已授权且确认无受控归属才能返回 `user`；已授权但归属未解决返回 `unresolved`；未授权、worker/station/user-adopted 返回 null。本模块不拿 cwd、自报 session/PID、env 或 owned.json 单条记录制造可信 Worker 身份。源仓库旧 observe/UI 尚未适配 IF-1；本次提供真实可运行服务和授权回调边界，**没有在 Electron 启动时自动开启扫描、安装配置或绕过授权**。#72 消费者在完成本机授权后调用 start/getSnapshot/subscribe/stop 接入，不需等待整套 UI 才能测试本模块。

快照和增量读取在同一 JS 串行点取水位；环最多 1000 包或 5 分钟，session 元数据默认最多 1000 条，invocation 去重最多 1000 条；游标缺口、旧 epoch、溢出要求 resnapshot。新宿主实例更换 epoch/token。每次读取快照或增量也重新核对扫描授权和归属：撤权、收编、归属变为 unresolved 或分类器失败时，清掉相应缓存、旧流和去重记录，重建 publisherEpoch，让已经消费到最新游标的客户端也必须重新取快照。快照容量与流容量不同时，流中的记录同样复核。这个观察 epoch 不授予审批能力。Stop/Post 不证明 idle、任务完成或进程退出，保持 unknown；用户进程状态始终 unknown。对未知归属不改标 user，诊断每类最多一次且总类数有界。

受控入口 `controlled` 固定返回非空原因的 deny，无宿主、超时、队满、畸形响应、伪造/过期凭据、旧 attempt、stop 后迟到允许都没有 allow 分支；env 只作为可疑痕迹，使普通入口保守拒绝，不能认证。`requireNativeHookWorkerAdmission()` 总是拒绝，且已接在现有终端 adapter 的 `executionRole=worker` 或 taskProfile 启动点；手动/host 终端仍保留自己的权限流。既有 SDK 路径未改。

这不是已实现的执行守卫：脚本不运行/被改写时 CLI 本身可能放行，故不能启动受控 Worker 来依赖这个脚本。准入关闭才是此阶段的安全保证；没有依据回执、登记记录或“安装成功”开启受控能力。

## 精确 CLI 证据

- Node `v26.12.1` / npm `11.17.0`，Windows x64。独立工作区 `npm ci --no-audit --no-fund` 使用 `QODER_SKIP_DOWNLOAD=1`；未改依赖声明/lock。npm 对 Qoder 等脚本还有 allow-scripts 警告，本任务无 Qoder 真机验收结论。
- 实际内置 Claude `2.1.150 (Claude Code)`；只验证版本，没有用新文档的 `onFailure:block`，该选项[官方要求 >=2.1.295](https://code.claude.com/docs/en/hooks#block-the-action-when-a-hook-fails)。旧版四类 hook 的实际执行/拒绝覆盖没有伪造为通过；Claude 安装器结果明确标 `activation:not-probed`。
- 实际内置 Codex `codex-cli 0.156.1`：隔离 CODEX_HOME 下 `features list` 返回 `hooks stable true`。配置 `[features].hooks=false` 时实际探测拒绝安装，保留 TOML 字节；不写设计里的旧别名，不把旧终端 profile 的 `-c hooks=true` 当证据，也不静默覆盖用户显式关闭。
- 真实 `app-server` 的 `hooks/list` 识别 PreToolUse、PermissionRequest、PostToolUse、Stop，解析错误 0、enabled=true、managed=false、trust=untrusted。没有调用 turn/start、模型或付费 API，没有写 trusted_hash、没有传 bypass hook trust。用户须先通过原生 `/hooks` 审阅，安装结果不等于运行有效。[官方开关/信任文档](https://developers.openai.com/codex/hooks)。
- 固定源码 `b412ff32c417f855c2b2d1581b77058eed87c84b` 的 [output_parser](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/hooks/src/engine/output_parser.rs)、[PreToolUse](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/hooks/src/events/pre_tool_use.rs)、[command_runner](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/hooks/src/engine/command_runner.rs) 已核对：Pre deny 必须带原因；allow 无 updatedInput 非法，故本阶段从不输出 allow；exit 2 需非空 stderr 才拒绝；Windows 默认 shell 是 cmd.exe。PermissionRequest 用 decision.behavior=deny，普通观察空输出保留原生权限。

### 延迟证据与限制

最终代码通过真实 Windows `cmd.exe /d /s /c` 执行实际安装 command（含空格/中文路径），Studio 关闭、无 endpoint，连续 10 次墙钟 ms：`81.8,74.9,72.8,70.0,66.5,66.2,70.3,67.5,66.1,73.2`，该次样本上界 **81.8ms**，空输出/exit 0。先前两次同类探测的样本上界为 73.4ms 和 82.6ms。无宿主情况下不联网、不重连、不等 stdin；有失联/挂起 endpoint 的测试仍按 40ms 网络预算退出。CPU/OS 调度可能让墙钟超出 timer；这些数值不是任意负载的硬实时上界。

这里证明了有界行为，**未证明整段 CLI 交互在所有平台“无可感知延迟”**：Node 与 shell 每次启动仍有成本，多工具调用可能累计；尚无 macOS/Linux 和真实 CLI 整轮体验证据。目标使用者应复核该预算，必要时另做原生轻量 launcher；不把测试墙钟误写为已通过完整验收。

## 使用、升级和回滚

先构建 `npm run build:electron`，使用真实 Node 执行下例。所有目录必须显式指定绝对路径；本例仅创建临时配置，不能直接替换成真实配置并宣称已获启用授权。

```powershell
$aha85Root = Join-Path ([IO.Path]::GetTempPath()) ('aha85-manual-' + [guid]::NewGuid())
$aha85Config = Join-Path $aha85Root 'claude'
$aha85State = Join-Path $aha85Root 'hooks'
node scripts/global-hooks.mjs install --agent claude --config-dir $aha85Config --state-dir $aha85State --profile review
node scripts/global-hooks.mjs uninstall --agent claude --config-dir $aha85Config --state-dir $aha85State --profile review
```

Codex 使用 `--agent codex --config-dir <独立CODEX_HOME> --codex-binary <0.156.1真实exe绝对路径>`，其余参数相同。有效 feature 必须为 true；若用户关闭，先由用户审阅配置/requirements，安装器不会改 TOML。升级用新构建的同一 install 命令，保留 stateDir/profile；脚本按内容摘要保存新 runtime。卸载不需要 CLI 二进制存在，也不要求原 relay 仍在。需要回到旧 runtime 时用旧构建执行同一 install，仍按精确 owner 项替换。

崩溃恢复：先确认没有正在运行的安装器/宿主，再处理对应 `.lock`，不能凭陈旧时间自动删除。重新执行同 profile 的 install/uninstall 会恢复 journal；遇 `transaction-conflict-manual-recovery-required`，先保留当前用户配置与加密证据，在本机受保护环境人工比对，不用旧备份覆盖后来改动。没有 GUI 自动修复或外传配置。

Windows 安装、配置变更和宿主观察服务启动时需要系统 Windows PowerShell 5.1/.NET Framework 权限 API；只执行内置固定脚本，参数和内容通过 stdin JSON 传入，不加载用户 profile。它不进入逐次 hook relay 路径，不增加每次工具调用的 PowerShell 启动成本。系统能力不可用或旧状态目录/文件权限过宽时拒绝继续，不自动修改已有 ACL。旧实现若已经丢失原文件 ACL，没有保存的原策略就不能猜测恢复；应保留配置和备份，依据已知的原权限处理后再迁移，不能将“字节恢复”当成“权限已恢复”。

## 验证命令与结果

实际运行于本工作区；以下 npm 使用 `C:\Program Files\nodejs\npm.cmd`，Node 使用相邻 `node.exe`。

- `npm run typecheck`：renderer 与 Electron 均通过。
- `npm run build`：通过。只有既有 Rollup 注释与大 chunk 警告。
- `npm test`：970 项，964 通过、6 跳过、0 失败；覆盖新安装器/relay/host/准入及既有手动终端测试。首次全量因观察尽力投递被超时丢弃而暴露测试必达假设，已改成确定性 ingress 断言，不扩宽产品等待预算。
- 独立聚焦验证：全新两份 hooks 测试 + Claude/Codex terminal adapter 既有测试；拒绝发生于实际启动点，fake PTY 无 spawn/prompt 副作用。
- `node scripts/probe-global-hooks.mjs --codex-binary <本工作区node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe> --claude-binary <本工作区node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe>`：通过；独立临时根、真实发现/开关、原生 cmd quoting、延迟、卸载与临时目录清理。曾遇 Windows 退出后文件占用，现等待 close 并有界重试清理；未动真实用户配置。
- `git diff --check`：通过。本地日志 `issue-85-build-results.log` / `issue-85-test-results.log` 受既有 ignore 规则忽略，文档保留摘要，不暂存日志。
- 最后一次 typecheck 与完整测试（全部实现代码定稿后）再次通过：970 项、964 pass、6 skipped、0 fail，35.48 秒。随后精确 CLI 探测 exit 0，四类 hooks 发现/信任状态及卸载结果同上。
- 首次探测失败后遗留的临时目录 `C:\Users\JHJ\AppData\Local\Temp\aha85-capability 中文 whNtZp` 未清理：可选清理命令被宿主自动审批策略拦截，未提供更具体原因；没有重试或绕过。后续已修复的探测脚本能正常清理自己新建的临时根，exit 0。

## 真实启用前审查与 #86 / B04 责任

### 主协调任务独立审查（2026-10-29）

- 修正卸载脚本先读取新构建 relay 的问题：即使当前构建的 relay 丢失，也能使用保留的安装状态卸载并逐字恢复原配置。增加独立不完整构建 fixture，不删除实际构建文件。
- 修正会话撤权/归属变化后的缓存问题：原实现只在收到新 hook 时检查，已授权的旧用户会话仍可能通过 snapshot/replay 交付。补上读取时复核、旧流失效和上述回归覆盖；原生 Worker 的准入门保持关闭。
- 最终代码重新运行 `npm run typecheck`、`npm test`、`npm run build`，全部通过；全量 **972 项，966 通过、6 跳过、0 失败**。日志为同工作区 `issue-85-review-{typecheck,tests,build}.log`，只保留本地，不提交日志。
- 重新运行真实二进制的隔离探测：Codex `0.156.1` 的四类 hooks 均发现、零解析错误，信任仍为 untrusted；Claude 仅核版本 `2.1.150`。宿主缺席时实际 Windows command 的 10 次墙钟为 `77.3,74.3,68,65.6,63.3,70.9,67.7,63.6,77.8,64.3` ms，最大 **77.8ms**；卸载通过。没有模型调用或信任变更。日志 `issue-85-review-probe.log`。
- 发布前 main 仍为 `fcc7ac2`；#135 已到 `086bf58256205e834c894e3d8070e0bc425580f9`，仍 Draft、未合入。此次改动的 terminal adapter 在该候选与 main 间无差异；不将整个候选分支的行为算作本 PR 已验证内容。#135 最新 CI 未启动执行步骤，GitHub 注解是账单/消费额度限制；本 PR 的远端 CI 仍需单独确认。
- 本次按基础实现发布草稿，使用 `Refs #85`，不自动关闭 #85，不解除 #112 的正式前置，也不表示真实 Claude hook 执行、#72 接线、跨平台无感延迟或 #86/B04 已完成。

### 第二轮审查修复（2026-10-29）

原 head `8a2c581` 复核后发现两处问题：Windows 原子替换会丢失独立 DACL；不同配置目录共用 stateDir 时并发写同一份 manifest/journal，会出现两次安装均成功但一方无法卸载。两者均先用临时配置复现，本轮修复上述共享边界：

- 配置临时文件在创建时携带原访问规则、继承保护、owner/group，并在写内容前核对；安装、升级、卸载、事务恢复与回滚均走此路径。新配置使用私有 ACL；权限提供程序失败时不退回普通 rename 写法。
- 密钥、manifest、journal、备份目录、版本化 relay 和宿主端点使用私有存储；已有文件的显式宽权限也会拒绝，不能只检查其父目录。
- `install.lock` 包住共享密钥和所有状态读写，再叠加配置路径锁；竞争者安全失败，已安装配置可正常卸载，随后竞争配置可以安装和卸载。异常退出释放已取得的锁；进程崩溃后仍遵守人工核实陈旧锁的既有规则。
- 新增 Windows 回归覆盖 DACL 在四条生命周期路径不扩大、权限提供程序失败后原配置不变且可恢复、私有密钥/runtime/端点以及宽权限旧文件拒绝；新增独立子进程的确定性并发安装回归。原有未安装/后改保留/字节恢复/缺 relay 卸载行为继续通过。
- 最终 `npm run typecheck`、`npm run build` 通过；全量 **976 项，970 通过、6 跳过、0 失败**；其中 hooks 聚焦测试 **21 项通过**。没有把 Windows 的文件 symlink 权限限制算作验证成功，没有宣称 macOS/Linux 远端 CI 已执行。
- 最终真实 Codex `0.156.1` 隔离探测 exit 0：四类 hook 均被识别，零解析错误，仍为 untrusted，卸载及新建临时根清理成功。宿主缺席的实际 Windows command 10 次墙钟为 `72.3,62.2,69.9,69.5,65,61.5,99.1,68.3,67.2,69.2` ms，最大 `99.1ms`；不改变此前关于跨平台/任意负载延迟的验收限制。两次早期复跑曾在清理阶段报 EBUSY，未计为整项通过；将 app-server 的 cwd 改为稳定的临时父目录，hooks/list 仍显式查询隔离根后，最终脚本完整成功。没有模型调用或自动信任。
- 原生 Worker 准入继续关闭。文件 ACL 修复不替代 #124 的 Windows 管道创建权限，也不替代 #86/B04；#85 继续保持 OPEN/草稿交付状态。

1. 主协调任务独立审查后统一提交/推送源仓库 PR；刷新 #135/main，尤其复核新的 terminal adapter 启动点，不能用旧 base 覆盖整合修订。
2. 本任务没有自动修改 `~/.claude` / `~/.codex`，也没有添加自动安装/自动信任/全盘扫描 UI。真实启用须另有明确授权；#72 按已授权扫描和 IF-2 归属服务接入 `classifyAuthorized`，不能简单返回常量 user 或把旧 observer 的推断状态直接当 IF-1。
3. #86 实现独立于普通全局 hook 的受控启动门：同 profile 的 reserve/attach/bind、受保护受限凭据、真实进程代次、runtime/worker/task/attempt、明确权限所有者、当前 authority epoch/停止栅栏；绑定前不注入任务。无登记/失联/脚本缺失/改写/禁用/未信任/CLI 超时均不能降级到普通入口。通过前保留本次拒绝，不用一个 enabled=true 或虚假 fixture 移除门。
4. #86 的审批服务要按每次 Pre/Permission 独立生成 request/bindingHash，核当前授权、单次消费、截止、审计与答复前二次校验；本观察服务没有此写能力，也不读取用户 transcript 来补授权。
5. #130/#131 的外部写逐次审批和只读无写能力仍归 #86。现有终端 adapter 不主动产生工具审批，单改 policy/G4 事后 diff 不能防 GitHub 等外部写。
6. B04 在精确目标 CLI、真实 OS 权限与全部实际工具路径验证主动 deny，以及脚本不执行/被改写/超时/错误输出/失联/队满/旧 attempt/凭据过期/stop 后迟到回执。尤其 CLI 已读到允许而尚未执行的动作能否撤销、30 秒严格停止和进程树退出，未验证；本次没有 allow 输出，也没有伪称已验证撤回机制。

当前可审查的是完整安装/观察/明确拒绝基础与真实探测材料；受控原生执行、同用户恶意进程隔离、全文件沙箱、跨平台无感延迟和 B04 均未宣布通过。普通 CLI 的审批仍由 CLI 自己处理。
