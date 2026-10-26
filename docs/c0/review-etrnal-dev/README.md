# `etrnal-dev`（collaboration.5）评审：R1

日期：2026-10-26。评审者：Claude（Mac）。对象：`etrnal-dev` @ `5f76c3a`（`0.19.0-collaboration.5`，基于 `c134de2`，333 个文件，约 4.76 万行）。依据：决定 G1（先评审再定跨设备基础）、G9（只在本机隔离环境评审）、B04 的一票否决口径。

本评审只读代码、只在本机跑测试，**没有修改 `etrnal-dev`，没有连接公网 Hub，没有开 PR，没有调用付费模型**。隔离做法和网络记录见 §6。

## 1. 结论

**建议：部分采用，有条件。** collaboration.5 的 Hub 账号体系、Station 持久化和「核对后再恢复」的状态机，比 C0 只停留在设计上的跨设备方案成熟得多，值得作为实现基础。但目前不能直接合入，有 3 个阻断项和 3 个需要负责人裁决的设计冲突。

| # | 类型 | 问题 | 处理 |
| --- | --- | --- | --- |
| **B1** | 阻断（一票否决） | K01：缺少 `turnOutcome` 的旧记录被当作正常完成，会自动提交、推送、开 PR | 作者修复并补回归 |
| **B2** | 阻断 | 接收组件写死 Codex app-server **0.144.1**（`services/remote/device/station_codex.py:142`）。B04 F1 已证明该版本对 ChatGPT 账号不可用，运行时修复分支已升到 0.156.1 | 改为与 G8 一致的已验证版本区间，并在 0.156.1 上重新验收 |
| **B3** | 阻断 | 基于 `c134de2`，没有包含 PR #47 和运行时修复（A-14–A-20） | rebase 到 main，在运行时修复合入之后 |
| **D1** | 待裁决 | 信任模型：Hub 是**受信任的中转**，能看到会议和任务明文，可以向已配对设备下发任务；C0 的 ADR 0014 要求端到端加密、Hub 不受信任 | 列入 R2 冲突表第一项 |
| **D2** | 待裁决 | 远端 Codex 任务用 `sandbox: workspace-write` + `approvalPolicy: untrusted`；运行时修复（A-14）经 B04 实测，已改用 `read-only + on-request` | 列入 R2；无论怎么裁决，都要在 N5095 上补 B04 S4/S5 场景 |
| **D3** | 待裁决 | 执行端只支持 Windows（Job 对象）和 Linux（subreaper），macOS 会拒绝执行。Mac 只能当 Host | 与 C0「Mac + N5095 双机」的验收计划冲突，列入 R2 |

## 2. 阻断项详情

### B1 K01：旧记录绕过发布许可

作者自己的复审（`docs/collaboration/REVIEW_COLLABORATION_5_2026-10-23.md`）已经复现，代码里也能直接看到：

- `electron/collaboration/station-service.ts:925`（`authorizeDelivery`）：只有 `local.turnOutcome` 有值、而且不是 `completed` 时才拒绝，字段缺失时放行。
- 同文件 `:502–503`：`executed + exitConfirmed` 的记录会被 pump 自动送去交付。
- 同文件 `:887`：交付时用 `receipt.turnOutcome ?? 'completed'` 补出「正常结束」。

修复方向同意作者的写法：按原 `taskId + attemptId` 去核对 journal 或原生轮次结果；没有证据时保留成果，状态停在待核对，不产生任何 Git 副作用。回归至少要覆盖：

- 字段缺失时，零新增 commit、push 和 PR；
- 有可靠证据时，原交付能恢复，并且不重跑 Agent；
- 重启后再核对一次。

本机（macOS）无法复现 K01，原因见 D3：交付用的 Git 操作也要经过执行守护进程。复现要放到 N5095 上做，用 `scripts/review/reproduce-legacy-outcome.mjs`。注意这个脚本**退出 0 表示缺陷存在**。

### B2 Codex 版本写死

```python
version=re.search(r'/(\d+\.\d+\.\d+)(?:\s|\(|$)',initialized.get('userAgent',''))
if not version or version[1]!='0.144.1':raise RuntimeError('Codex app-server protocol version is incompatible; task was not submitted')
```

后果分两种情况：

- 在用户机器上，如果装的是 0.144.1，ChatGPT 账号会登录失败（F1）；
- 如果是任何其他版本，任务会被直接拒绝。

运行时修复合入后，Station 自带的 Codex 是 0.156.1，跨设备任务会全部被拒。需要按 G8（已验证区间 + 每周兼容检查）改，并重新验证 app-server 协议字段，包括 `thread/start`、`turn/start`、审批请求和 `account/read`。

### B3 基线落后

- 分支没有 PR #47，所以作者报的 K03（Windows 34 项失败）很可能已经由 #47 修掉了：作者复审里核实的三类原因（CRLF 夹具、Kimi 的 Windows 路径、Qoder 的 EPERM），正是 #47 修复的三类。
- 它也没有 A-14–A-20：A-20 停止撤销与进程树、A-16 fileChange 路径、A-18 就绪超时。
- 和运行时修复、PR #49 同时改了 `electron/orchestrator.ts`（+144 行）、`electron/main.ts`、`package.json`。另外 `main` 入口改成了 `dist-electron/bootstrap.js`。

建议的顺序：

1. 运行时修复合入；
2. 本分支 rebase；
3. 按作者回复中的拆分方案（契约 → Hub → Station → UI → 构建 → 文档）分批开 PR。

## 3. 设计冲突（交 R2 裁决）

### D1 信任模型

| | `etrnal-dev` | C0（ADR 0014、`design/remote-control.md`） |
| --- | --- | --- |
| Hub 角色 | 身份、设备目录、会议状态、任务、审批、事件、文件引用的权威来源（`FIRST_RELEASE_SPEC.md` §3） | 只做转发，内容端到端加密 |
| 命令真实性 | Hub 认证设备令牌（HMAC 摘要），设备信任 Hub 下发的任务，再用本机授权（项目绑定、Agent 白名单、目录授权）做拦截 | 设备之间直接签名，Hub 不能伪造命令 |
| Hub 被攻破或账号被盗 | 攻击者能读全部会议内容，并能向该账号所有已配对设备下发任务，只受本机授权范围限制 | 只能丢弃或延迟消息 |
| 文件 | 走用户指定的 GitHub 仓库（`etrnal-dev` 的 ADR 0006） | 加密信封；GitHub 交接是选项之一 |

`etrnal-dev` 的做法更简单，而且已经能运行。代价是 Hub 的运营方（目前是微信云托管上的公网服务，见 `resources/remote-service.json`）必须是可信的。需要负责人决定以下三种之一：

- 接受这个信任模型；
- 先接受，之后叠加端到端签名作为后续卡；
- 要求首版就有端到端签名。

### D2 远端执行的沙箱

- `station_codex.py:157` 用 `thread/start {sandbox: request.permission, approvalPolicy: 'untrusted'}`。新任务的权限限定为 `read-only` 或 `workspace-write`（`:90`）。
- B04 实测，Codex 在 `workspace-write` 下写工作区内的文件**不经过宿主**（S4 一票否决就是因此失败）。所以运行时修复把本机 Worker 改成了 `read-only + on-request`，由宿主按路径裁决。
- `etrnal-dev` 的任务工作区是独立 worktree，粒度是整个工作区，这可以算一种设计选择，不一定是缺陷。

但还有两点需要实测：

- Windows 上 Codex 的 `workspace-write` 沙箱能否真正拦住工作区以外的写入；
- 获批命令是否在沙箱外运行。这是 G4 已经确认存在的缺口，在 `untrusted` 策略下同样存在。

建议在 N5095 上对 `etrnal-dev` 的接收组件补跑 B04 的 S4、S5、S6。

### D3 平台

`station_codex.py:100–104`：

- `win32` 用 `WindowsJob`；
- `linux` 用 `LinuxTaskTree`；
- 其他平台抛出 `This guardian platform requires native containment integration before execution`。

这是安全的失败方式，不会越权执行。但这意味着首版 Mac 只能当 Host 或查看端，和 `etrnal-dev` 的 ADR 0005（「首版 Windows 双机」）一致，和 C0 计划的 Mac + N5095 双机验收不一致。

## 4. 做得好的地方（建议直接沿用）

- **Hub 账号与凭据**：
  - 密码用 PBKDF2-SHA256，60 万次迭代；
  - 账号不存在时也计算一次哈希，防止枚举账号；
  - 令牌只存 HMAC 摘要；
  - 配对码 144 位、10 分钟有效、一次性，用条件更新防并发重复领取；
  - 每个账号最多 10 台设备；
  - 登录、配对、领取都有限流；
  - 请求体 64 KB 上限；
  - 强制单 worker、单实例；
  - 关闭了 `/docs` 和 OpenAPI。
- **账号隔离**：协作接口都从凭据取 `owner` 再查询；`x-station-device` 与凭据不一致时拒绝。
- **状态机**：
  - 「已接收」以执行端确认为准；
  - 停止未确认时不释放名额；
  - 断线后先核对原任务，不重跑；
  - Git 操作逐个记录，退出未确认时不重复发布。

  这些和 C0 的 B03 契约、A-20 的停止语义方向一致，可以直接映射到 C0 的 command journal 设计。
- **路径校验**：`safeRelative` 拒绝 `..`、`.git/`、`//`；输入图片限制在任务工作区内、限 8 张、每张 25 MB 以内。
- **作者自己的复审**很诚实：明确列出 K01–K03，没有用「新增失败 0」宣称全部通过。

## 5. 其他问题（不阻断，合入前处理）

| # | 问题 | 位置 | 建议 |
| --- | --- | --- | --- |
| N1 | 代码可读性：`station-service.ts` 共 1277 行，其中 59 行超过 300 字符，最长一行 748 字符，一行里塞多个控制流 | `electron/collaboration/station-service.ts` | 合入前用格式化工具重排，不改行为。否则评审和后续维护都很难做 |
| N2 | 限流按 `request.client.host`，但 uvicorn 没有配置可信代理（`forwarded_allow_ips`）。放在云托管网关后面时，看到的可能是网关地址：所有用户共用一个限流桶，或者限流失效 | `public_hub.py:165、191`，`:417` | 核对微信云托管实际转发的头部，配置可信代理后取真实客户端地址 |
| N3 | 路径校验依赖平台：macOS 上 `safeRelative('C:/private')` 不报错。Windows 接收端会拦下，但校验规则在各平台不一致 | `electron/collaboration/git-files.ts:20` | 所有平台统一拒绝盘符、反斜杠和冒号 |
| N4 | 测试不完全离线（§6）：Agent 登录状态检查会启动自带的 Qoder CLI，它会连阿里云 HTTPDNS 和 Qoder 服务；Git 测试会经 HTTPS 连 github.com，并且会用到系统的凭据助手（macOS 上是 osxkeychain） | `StationService.probe()`、Git 测试夹具 | 测试里替换 backend registry；Git 测试设置 `GIT_CONFIG_NOSYSTEM=1`、清空 `credential.helper`，并用 `url.<本地>.insteadOf` 把远端指向本机 |
| N5 | `station-collaboration.test.mjs` 单独运行时卡住超过 24 分钟，全量运行时 44 秒失败（清理时 `ENOTEMPTY`）。原因与 D3 有关 | 测试 | 不支持的平台上应快速失败或跳过，并说明原因 |
| N6 | 仓库里有提示词文件（`docs/collaboration/*PROMPT*.txt`），以及原验证机的本机路径（例如 `C:/Users/79142/...`） | `docs/collaboration/` | 脱敏，或移到证据目录 |

## 6. 本机运行结果（macOS arm64，Node 24.22.1，Python 3.13.13）

**隔离做法：**

- 单独的 detached worktree；
- Python 虚拟环境放在仓库外；
- 用 `env -i` 清空环境变量；
- 使用临时 `HOME`，里面只有一个测试用的 git 身份，没有任何 Agent 登录；
- `PATH` 只包含 Node 24、npm、Python 虚拟环境和系统目录，不含 `codex` 或 `claude` 命令；
- 每 0.5–1 秒用 `lsof` 记录一次所有非本机连接。

**`npm run test:collaboration`：**

| 部分 | 结果 |
| --- | --- |
| Python 契约与 Hub（9 组） | 120 项全部通过，其中 15 项跳过 |
| Node（15 个文件） | 130 项：124 通过，5 失败，1 跳过 |

5 个失败逐个核实过：

| 测试 | 原因 | 性质 |
| --- | --- | --- |
| H11/H12 真实本机 Git | 守护进程报 `requires native containment integration`，没有生成提交 | D3：macOS 不支持执行 |
| 两台 Station 共享 Hub 状态 | 清理目录时 `ENOTEMPTY`；单独跑时会卡住 | D3 / N5 |
| 真实 Git 传输 | `safeRelative('C:/private')` 在 POSIX 上不报错 | N3 |
| F2 断线后 Hub 重启 | 固定端口重新绑定时 `Address already in use`（macOS 的 TIME_WAIT） | 测试夹具 |
| stability UI | 缺少 Playwright 和 Chrome（文档已说明需要单独准备） | 环境 |

结论：没有发现 macOS 上的新逻辑缺陷；执行链路必须在 N5095 上验证。全量 `npm test`（作者报 1118 项）没有在 Mac 上跑，因为执行相关的用例在 macOS 上注定失败，应在 rebase 后由 N5095 跑。

**网络记录：**

- **没有出现公网 Hub 的地址**。本机代理把 Hub 域名映射为 28.0.0.30，记录里从未出现。
- 能确认来源的对外连接有三类：
  - Qoder CLI 登录状态检查：203.107.1.1、47.57.243.249、8.212.124.35；
  - npm 的版本更新检查：registry.npmjs.org；
  - Git 测试经 HTTPS 连 github.com。测试用的仓库（如 `station-fixture/hardening`）在 GitHub 上不存在，不可能被写入。
- 首轮全量运行中还有少量 node 进程连到代理地址 28.0.0.43 和 28.0.0.44，单独重跑没有再出现，无法归属到具体进程。
- 临时 `HOME` 里没有任何 Agent 登录，所以这些检查都返回未登录，没有产生模型调用。

## 7. 需要作者回答的问题

1. K01 的修复计划和预计时间。
2. Codex 版本门（B2）准备怎么改；是否愿意采用 G8 的已验证区间。
3. 本机起 Hub 的最短步骤。本次只验证了用 SQLite 夹具跑测试；MySQL 5.7 的演练步骤需要作者提供。
4. K02 的原始拒绝原因：`Guardian.call` 把 RPC 错误统一压缩成了一句提示。
5. 公网 Hub 由谁运营、是否是生产服务；D1 的裁决需要这个信息。
6. macOS 执行端（D3）是否在规划内，大约什么时候。

## 8. 下一步

- 负责人：裁决 D1–D3，与 R2 冲突表一起处理。
- 作者：处理 B1–B3，回答 §7，按拆分方案开 PR。
- N5095：rebase 后跑 K01 复现脚本、全量测试，以及 D2 的 S4、S5、S6 场景。
- Mac：R2 冲突表；R3 按裁决结果修订 `design/remote-control.md` 和 `meeting-mode.md`，并重估 X1–X8。
