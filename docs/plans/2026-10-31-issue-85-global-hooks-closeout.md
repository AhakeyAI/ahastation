# #85 / PR #142：实现收口与指定验收

日期：2026-10-31（Asia/Singapore）。状态：**实现收口，待指定验收；不建议关闭 #85，不解除 #112 前置。**

## 当前基线与范围

- 复用专用 worktree / `codex/issue-85-global-hooks`，从干净的 `f46850193ccb928c722f752cb49509d5786abb57` 开始。源仓库是 `AhakeyAI/ahastation`，更新原 Draft [PR #142](https://github.com/AhakeyAI/ahastation/pull/142)，不使用 fork。
- 已合并实际 main `8770207ca4e41f3f31201d418a980593adf51efd`（含 #135），无文本冲突；复核 terminal adapter 后，Worker 仍在解析二进制、写文件、PTY spawn 和注入提示词前拒绝。保留原 ACL、共享 stateDir 锁、撤权失效、缺 relay 卸载回归。
- [#81 IF-1 v0.1.0](https://github.com/AhakeyAI/ahastation/issues/81#issuecomment-6489503329) 已定稿；[#83 IF-2 v0.2](https://github.com/AhakeyAI/ahastation/issues/83#issuecomment-6489835342) 加[来源澄清](https://github.com/AhakeyAI/ahastation/issues/83#issuecomment-6491405211)已完成使用方确认并关闭。接口确认不表示 schema 2 单写服务或 reserve→attach→bind 已运行。
- #146 仍未合并。本分支仅以 `cherry-pick -x` 复用 `57c02d9`、`b635df2`、`ae9d272` 的通用测试修正：Windows 路径身份比较、首屏 rateLimits 夹具、Hub 有界启动诊断、Worker readiness/异步 predicate/全部事件落盘等待、重启前持久化原生身份。不包含 #130 的权限实现，也不把它当 main 的能力。

## 本轮修正

安装器原先使用 UTF-8 替换解码：若 JSON 字符串内有非法字节（例如 `0xff`），它会变成 U+FFFD 后仍可解析，备份也已失去原始字节，导致卸载无法逐字恢复。先用独立临时配置复现了“应拒绝但安装成功”，再改为 fatal UTF-8 解码；非法编码在配置写入前拒绝，合法 BOM 保留到原始备份。新增回归检查原文件字节不变且没有安装 manifest。

扩充 `scripts/probe-global-hooks.mjs`，支持 `--bundled` 使用锁文件中的当前平台二进制，也保留显式绝对二进制参数：

```powershell
node scripts/probe-global-hooks.mjs --bundled
```

- 使用临时 HOME/USERPROFILE/CODEX_HOME/CLAUDE_CONFIG_DIR，清空模型凭据；安装器内置能力探测的子进程也使用隔离环境。没有模型 turn、原生 hook 信任变更或日常用户配置写入。
- Codex `0.156.1` 实测规范开关 `features.hooks`；显式关闭时拒绝且 TOML 原字节不变。不写旧 `codex_hooks` 别名。`hooks/list` 精确核对四种事件、零解析错误、enabled=true、managed=false、trust=untrusted。
- 两家配置均覆盖安装、幂等、升级、保留既有用户 hook、BOM/CRLF 原样卸载；执行的是配置中实际 command，经 Windows cmd 或 POSIX `/bin/sh`，包含中文和空格路径。
- 每家五轮四类 hook，记录无宿主的每次与累计墙钟；另测有宿主、宿主关闭、未解归属不投影为 user、可疑内部来源主动 deny、去敏与卸载。投递为 40ms 内尽力而为，记录实际到达数，不把丢包掩盖成必达，也不扩大产品预算。
- 三平台 build-matrix 新增同一隔离探测步骤。CI 数值属于 runner 上的命令壳/relay 证据，不能替代真实桌面 CLI 整轮体验。

首次新 CI 的 macOS 全量测试暴露系统临时目录 `/var → /private/var` 别名触发私有目录拒绝；16 个 hooks fixture 在开始前失败。修正为仅对自建临时根/可信系统临时父目录取 realpath，产品对用户配置和状态路径的 symlink 拒绝不变；不跳过或删除原测试，修订后的 SHA 重新跑三平台全量。

## 复现环境与验证记录

Windows x64，Node `26.12.1` / npm `11.17.0`；`npm ci --no-audit --no-fund` 按当前 lockfile 安装。Qoder 下载关闭；npm 的既有 allow-scripts 警告不算 Qoder 实机证据。

与 CI 相同，隔离 `.venv` 安装 `requirements-public.txt` 和 `requirements-station-native.txt`，构建 `scripts/build-station-native.py`，安装 Playwright Chromium 后设置：

```powershell
$env:COLLABORATION_PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
$env:POCKET_VIBE_TEST_PYTHON = $env:COLLABORATION_PYTHON
$env:POCKET_VIBE_MACOS_TASKS_SUPPORTED = 'true'
npm run typecheck
npm test
npm run build
node scripts/probe-global-hooks.mjs --bundled
```

首次缺少 Python 环境变量/浏览器/native receiver 的测试已中止，不计通过；补齐环境后的中间执行因新增 UTF-8 修复而被最终代码验证取代。最终结果与当前 SHA 的远端 CI 见 PR 正文，只有完整结束的运行计入通过。

本地随后完成的全量为 1319 项 / 1312 通过 / 6 跳过 / 1 失败，失败是 process-recovery fixture 的 receiver 20 秒启动超时，不能计全绿。用户报告大量弹窗后停止继续自动本机全量，核对时原测试 shell 和进程树已退出；没有按进程名清理其他任务或插件服务。源码确认 `StationService.initialize/configure → probe → 全部 backend resolveBinary/checkAuthStatus`，只测 file-test 的子 receiver 也会探测个人 CLI；日志反复出现 Codex `login status` 文本。已补后台 subprocess、npm/where 查找、Claude/Codex auth status 的 `windowsHide:true`，并将纯 file-test 进程恢复夹具与个人 CLI 探测隔离。它们是已证实的无窗口选项缺口和触发链；未逐一关联实际可见窗口，不把 hooks 中已隐藏的 PowerShell/relay 当根因。只跑纯 mock 的后台探测和隐藏启动的隔离进程恢复定向验证，不再自动重跑本机全量；最终全量以远端各平台结果记录。

第二轮 CI 的 macOS 测试、隔离 hooks 探测和打包通过；Ubuntu 仅 process-recovery 失败。源码显示首次 Hub running 在持久化 `executionInvoked` 及原生身份前发出，测试过早杀 receiver 会落到尚未启动分支。修正测试等待同 attempt、原 receiver PID、真实 nativeThreadId 与已落盘 executionInvoked 后再模拟崩溃；不改产品停止/恢复语义，不增加时间预算或跳过断言。

后续 Windows CI 发现私有文件校验失败和中文 npm launcher 查找失败。保留既有 owner/DACL 校验，新增 `createPrivateHookFile`：密钥、manifest/journal/备份临时文件、runtime、宿主端点在 Windows 创建时就附带当前用户 owner 与私有 DACL，再写内容；配置替换仍逐项保留原配置 ACL，不接受其他 owner 来迁就 runner。并发测试改在加密备份 rename 的同一持锁阶段确定性交错，独立 journal fixture 也按相同权限规则创建。

Windows PATH 优先按原生 Unicode 路径与支持的 PATHEXT 查找真实文件，跳过 extensionless sh shim 和同名目录，不先解码 `where.exe` 的代码页文本。后台默认 owner 与编码差异最初是待验证假设；新增 `probe-windows-hook-files.mjs` 在 CI 的临时自有目录输出 token/default/file owner 对照、原严格校验结果、原始 where 字节与退出码，以及新创建/查找结果。它不执行个人 CLI 或 PTY，也不修改原生配置；最终以该 SHA 的 runner 诊断与全量回归确认触发条件。Windows 已有宽权限目录/文件、无法保留 ACL、权限提供程序失败、事务冲突等仍拒绝，未删除或跳过原断言。新增 PowerShell 创建只在安装/存储及宿主启动路径，不进入逐次 relay。

## 具体接线与验收责任

| 项目 | 现有入口 / 证据边界 | 后续责任与停止点 |
| --- | --- | --- |
| 普通观察服务 | `electron/global-hooks/host.ts` 的 `classifyAuthorized/start/getSnapshot/subscribe/stop` 已可调用；产品代码中尚无调用该服务的组合入口。`electron/main.ts` 仍创建和自动启动旧 `ObserveService`，只注入 `getSelfExclusion`，不提供扫描授权或 IF-2 v0.2 三值查询。 | #72 / Dryoung95 接入明确的本机扫描同意、撤权与 IF-2 entry+pending launch 查询，再组合新服务。不用常量 user、旧 UI 状态或 fixture classifier 代替真实授权。宿主关闭/未授权时不自动装 hooks 或扫描。 |
| IF-2 | 当前分支没有 `owned.json` schema 2 单写服务及 reserve/attach/bind 实现；#83 关闭只代表契约确认。 | Station 接线由 eternal904 负责；Leo 的运行/Worker 模块交付真实 runtime/进程代次及受保护凭据证据，双方绑定实际 permissionOwnerRef。登记不能授予执行权。 |
| 原生 Worker | `requireNativeHookWorkerAdmission()` 始终拒绝；relay 的 controlled/可疑来源没有 allow 分支。 | #86 交付独立守卫、启动绑定、权限逐次校验与 stop 栅栏，#109 B04 验真实 CLI 的脚本缺失/改写/超时/禁用/未信任等路径。不得为验收移除本门，也不在 #85 扩大实现完整 #86。 |
| 真实 CLI 识别与执行 | Codex 的 hooks/list 识别有效，但仍 untrusted。Claude `2.1.150` 仅核实际版本；本轮命令壳执行验证了 relay，不是 Claude/Codex 原生 hook 引擎的执行/阻断验证。 | Shawn 指定验收人使用临时 profile，通过 CLI 原生界面审阅 hook 后验证真实事件、保留用户原生审批、失联拒绝。模型付费调用、真实个人配置变更须有覆盖动作的授权。不得使用 `onFailure:block`（目标 Claude 版本不支持）。 |
| 延迟与产品验收 | Node/壳启动不计入 relay 内部 40ms timer。四类累计墙钟须按整轮评估；CI 不模拟真实桌面负载。 | Shawn / 目标使用者指定 macOS、Linux、Windows 实机与整轮可感知延迟验收。现有数值不支持宣布全部平台“无感”；需要进一步 launcher 优化时独立评估，不默改两家原生 shell 或开放 Worker。 |

安装器说明、崩溃恢复和手动处理陈旧锁见 [10-29 实现记录](2026-10-29-issue-85-global-hooks-implementation.md)。Windows 文件 symlink 权限不足的历史测试不计为已验证；CI 的 POSIX symlink 覆盖仍不能替代 Windows 真机。无原始 ACL 策略不能猜测恢复旧版已丢失的 ACL。

交付到主对话独立复审；保留 Draft、#85 OPEN。未合并 PR、关闭 Issue、修改日常 CLI 配置或自动信任 hooks。
