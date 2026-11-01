# 原生 CLI / 守卫能力矩阵

2026-11-01。证据等级：S=固定官方源码/schema；V=隔离实际二进制启动；O=真实 OS/broker sentinel；E=真实模型工具回合；B=B04 实机。各列独立，不能用 S/V/O 冒充 E/B。下表 V/broker 证据继承固定 #148 `8bbb7e0`；本轮新增 O 只针对自有隐藏 ConPTY 映像，不重复执行 CLI。

会话身份限制：离线守卫 relay 的 `fixture-*` ID 不是 CLI 原生 sessionId。工厂仅在显式新建的隔离验收 profile 工作，普通 profile 拒绝；原生会话的 IF-2 绑定仍 unknown。main 注册和 scheduler ports 是接线准备，实际 terminal adapter 启动/报告到此守卫的产品链尚未完成。

## 平台 × 版本

| 平台/provider | 固定版本 | 本轮证据 | 引擎强制控制/准入 |
|---|---|---|---|
| Windows x64 Claude | 2.1.150 / SDK 0.3.150 | #148 V：隐藏临时 HOME/config `--version` 及 AppContainer/Job 启动；O：broker；本轮 ConPTY O 为自有映像 | provider PTY/工具/联网/原生 session/owner E/B unknown，默认关闭 |
| Windows x64 Codex | 0.156.1 / SDK 0.156.1 | #148 V/O：同上；本轮共用自有 ConPTY O | provider PTY/工具/联网/原生 session/owner E/B unknown，默认关闭 |
| macOS arm64/x64 Claude | lockfile 目标 2.1.150 | 未在本轮执行目标二进制；仅共享配置/schema 参考 | E/O/B unknown，关闭；Shawn 指定 Mac |
| macOS arm64/x64 Codex | lockfile 目标 0.156.1 | S：下述固定 tag；未在本轮执行 | E/O/B unknown，关闭 |
| Linux x64/arm64 Claude | lockfile 目标 2.1.150 | 未在本轮执行；本 helper 不支持 Linux | E/O/B unknown，关闭 |
| Linux x64/arm64 Codex | lockfile 目标 0.156.1 | S：固定 tag；未在本轮执行 | E/O/B unknown，关闭 |

Windows 实际二进制 SHA256：Claude `904de86d9f93b753fb00c7536b36fa47e552a18832471b40ad3193b49a878df8`；Codex `70bcb05f9bf1a4e7306edd0cd1b57d02af3267ad02a34b26f45c8c4bb20a3301`。helper hash、Node、lock hash 由当前验收记录给出，不跨构建继承。

## hook 能力与故障

Claude 当前[官方 hooks 文档](https://code.claude.com/docs/en/hooks) 已描述 `onFailure: block`，包括缺脚本、崩溃、无效 JSON 与超时；它仍不能使未安装/禁用的 hook 生效，也不能拦截获批脚本内部动作。当前文档不是 2.1.150 支持该字段的版本证据；本轮不升级，也不将该字段回填为已证明能力。2.1.150 的强制失败行为仍需指定引擎 fixture 验证。

Codex 0.156.1 固定源码 commit `b412ff32c417f855c2b2d1581b77058eed87c84b`：

- [hook engine](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/hooks/src/engine/mod.rs)：禁用后移除非 builtin handler；不是拒绝所有工具。
- [discovery/trust](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/hooks/src/engine/discovery.rs)：有独立 trust 与 required/optional 加载策略；普通 discovery 成功不能当强制边界。
- [PreToolUse 结果解析](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/hooks/src/events/pre_tool_use.rs)：运行错误/异常 JSON 可产生 failed 事件，但并不自动生成 deny 控制效果；需和实际引擎路径一起验证。
- [PreToolUse output schema](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/hooks/schema/generated/pre-tool-use.command.output.schema.json) 只描述消息格式，不能证明缺失/超时都被拒绝。

| 故障/动作 | 选定 Windows broker 执行前位置 | 本轮实际证据 | Claude/Codex 引擎结论 |
|---|---|---|---|
| allow / deny | journal flush → 完整动作 permit → broker consume | O：允许精确内容一次；拒绝文件不存在 | E unknown |
| hook 缺失 | AppContainer 不授予宿主私有目标/网络；没有 broker 请求即没有宿主动作 | O 验证隔离目标；未运行引擎 hook 缺失 fixture | E unknown |
| hook 禁用 / 未受信 | 同上；不依赖 CLI 承认 hook | S：Codex 策略；O 仅隔离目标 | E unknown |
| hook 崩溃 / 无效响应 / 超时 | 宿主没有持久裁决就没有 permit；CLI 直接动作仍受 OS 限制 | 协议拒绝/超时核心回归；非上述三种真实引擎注入 | E unknown |
| journal 失败 | 持久化回调拒绝，不能发行 permit | O：真实通道请求无 permit，目标不存在 | E unknown |
| 宿主丢失 | 私有 stdin EOF → helper 关闭 Job；helper 崩溃依赖 KILL_ON_JOB_CLOSE | O：实际 EOF + 存活后代后 active=0；未执行整机崩溃 | E/B unknown |
| 批准后、动作前 stop | 同步封口/撤权，再中断；旧 permit 不能消费 | O：已发 permit、后代存活、stop 后文件不存在；active=0 | E unknown |
| worker 停读、管道写满后 stop/宿主 EOF | 独立控制 reader/回收线程；有界后台 writer | O：连续确认实际 writer blocked，两路径均在 3 秒内 Job active=0；旧 caa8f9e 加停读 fixture 可复现失败 | E unknown |
| UTF-8 跨块、非法/截断字节 | 严格流式帧解码；错误封口 | 每个字节分割点/逐字节回归；O：中文/emoji 审批与实际文件内容一致 | E unknown |
| 凭据伪造/旧代次/重放 | 私有管道 OS 身份 + nonce + run basis + permit map | O：伪造凭据封口，变参/过期/重放不写；旧代次核心回归 | E unknown |
| Windows DOS 设备名 | broker 在裁决/打开前拒绝 CON/NUL/COM 等设备目标 | O：受保护通道提交 CON.txt 后拒绝并整树退出 | 非真实引擎路径 |
| 直接/后代越界写 | AppContainer Token 权限检查，broker 无任意 exec | O：受限 root 与实际 descendant 均无法修改私有外部 sentinel | 不概括任意公开 ACL 目标；E unknown |
| shell 间接写/外部写 | broker 不提供 shell/网络；AppContainer 限制直接访问私有目标与网络 | O：后代写和 TCP localhost 被拒；没有 shell/真实远端写取证 | 任意 CLI 脚本矩阵仍 unknown |
| 回报/回执 | 当前 attempt、已创建文件实际 hash、fsync 与 awaited scheduler | O：同 report 同 receipt，只交付一次；核心异步失败回归 | 真实模型 WorkReport unknown |

## 技术选择与下一责任

首个可执行边界是 `windows-offline-broker-v1`。官方 [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) 提供资源权限控制，[启动 API](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) 将安全 capability 绑定到新进程；[HANDLE_LIST](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) 限定继承句柄；[匿名管道权限](https://learn.microsoft.com/en-us/windows/win32/ipc/anonymous-pipe-security-and-access-rights) 支持创建时 DACL。Job/process group 仅作生命期与整树退出依据。

保持原 CLI/SDK 版本。真正支持联网原生任务需要：经版本验证的 fail-closed 原生工具强制入口，或完整隔离执行服务及出口/凭据控制。Mac/Linux 需要各自 OS 实现；不能复用 Windows O 等级。受控模型出口、LPAC、G13 登录配置映射、provider ConPTY 接线与单写者接管仍未完成，不能临时放宽权限绕过。新增自有 ConPTY 原语和下一决策见下节，不改变 provider 准入。

最小驱动：先 `npm run build:electron`（Windows 自动编译 helper），再 `node scripts/accept-native-worker.mjs`。仅启动自有隐藏进程、隔离配置的 CLI `--version`、本地 TCP sentinel；不调用模型、不扫描个人登录。Mac/Linux 驱动明确 skip。默认准入没有 env 开关；`nativeWorkerAdmission` 始终 false。

主对话复审源码/接线；Leo 补真实 provider/terminal adapter 接缝；Station owner 需 #83/#72 真实接口；Shawn 指定 Mac Claude，并在 N5095 对两种 CLI 各执行 S1–S6、S8、S11。真实引擎所需模型/账号/可见终端与全局配置动作需要相应授权，目前未执行。

## 本轮 ConPTY 原语与强制边界判断

具体方案/责任/兼容影响在 [ConPTY 与联网边界交接](../plans/2026-11-01-native-cli-egress-boundary.md)，本轮源/lock/helper hash 与定向结果在 [新验证记录](../evidence/native-worker-conpty/local-validation.json)。`WindowsConPtyProcess.spawnOffline` 只启动新隔离临时目录中的 pinned `.exe`；`PtyHost.adopt` 复用现有终端缓冲和输入/停止，未接入 Worker factory。

| 能力 | 本轮实现和证据 | 限制 |
|---|---|---|
| ConPTY 启动前隔离/归属 | AppContainer 与 PSEUDOCONSOLE 同次 CreateProcess，挂起时 Job attach、token/start/boot/member 核验，显式 resume | 仅 Windows 自有控制台映像；不是 CLI 工具许可 |
| 文件与后代 | 映像只读，临时 home/workspace 可写；实际根/后代未改外部私有 sentinel | 普通 AppContainer 仍可能访问已向应用包公开的资源；无 LPAC/任意外部文件不可达声明 |
| 模型/登录/刷新出口 | 无网络 capability；无继承模型/GitHub token、个人 HOME、代理 env | 当前只封网；真实模型/登录未知，没有单靠 HTTP_PROXY/domain list 声称分流 |
| 工具出口/外部写 | 自有根/后代到宿主正对照可达的本地 TCP 目标没有连接 | DNS/IPv6/重定向/真实 Internet 未验证；无在线 provider 能力 |
| 终端/control 分离 | 原始字节 base64 封装，严格 UTF-8；目标打印伪造 tree-exit 仅显示 | 终端输出不是受保护 hook、sessionId 或 WorkReport |
| stop/宿主 EOF | 输入同步封口；Job active=0；未确认保留 sealed owner，不按 PID fallback/dispose | 未测试完整宿主重启后同一 CLI 恢复；任务成果验收与退出分开 |
| 候选回报与审批 | report claim 禁输入/permit/未决审批；候选落盘期间 stop 不确认旧回执；scheduler 复用 pendingAskCount 并清卡 | 核心/ports 协议证据；新 ConPTY 无 provider report client/Station owner |

当前官方 [Claude sandbox 边界](https://code.claude.com/docs/en/sandboxing) 不覆盖主进程文件工具/MCP/hooks，原生 Windows shell 也未受其内置 sandbox 保护；此事实只作方案参考，不补证 2.1.150 失败阻断。Codex 固定 [配置 schema](https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/core/config.schema.json) 有 provider 认证/凭据和 sandbox 配置，但这些字段单独不证明本产品逐次工具边界。普通 native 进程内的模型流量与工具流量缺少可验证来源；要继续 P3，需选定可实施的强制工具入口及独立凭据/出口方案，不能升级版本或加 env 开关后直接放行。

新隐藏入口为 `node scripts/verify-native-conpty.mjs`，不运行真实 CLI/模型/个人配置或全量本机测试。三平台 CI 全量和打包仍是另一证据层，Windows 用例在 Mac/Linux 明确 skip；两 CLI 的 E/B 保持 unknown。
