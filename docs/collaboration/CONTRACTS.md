当前 collaboration.3 增量协议、认证错误及恢复约定见本文末尾；下方 v1 章节保留原基础契约的历史边界。

# 四项公共契约与开发调用说明

版本：collaboration v1，2026-10-21。适用分支：etrnal-dev。

本次完成的是双方可以立即调用、校验和测试的开发基础。已有 Station／Hub 运行入口没有切换到新接口；没有自动创建云端表、发布服务或改变现有 Bridge 行为。设备／项目的生产实现由新成员接入，会议／任务运行时由维护者接入。

## 1. 从哪里开始

| 内容 | 仓库入口 |
| --- | --- |
| 唯一结构校验来源 | [v1.schema.json](../../contracts/collaboration/v1.schema.json) |
| TypeScript 类型 | [types.ts](../../electron/collaboration/types.ts) |
| 四项接口 | [ports.ts](../../electron/collaboration/ports.ts) |
| 主进程公共导出 | [index.ts](../../electron/collaboration/index.ts) |
| TS 结构／语义校验 | [validation.ts](../../electron/collaboration/validation.ts) |
| Python 同源校验 | [validation.py](../../services/remote/collaboration_contracts/validation.py) |
| 内存 Hub、模拟本机授权 | [mock-hub.ts](../../electron/collaboration/testing/mock-hub.ts) |
| 本机真实 Git／路径核验 | [local-project-access.ts](../../electron/collaboration/local-project-access.ts) |
| 事件投影、去重、缺口处理 | [events.ts](../../electron/collaboration/events.ts) |
| 本机授权变更通知 | [local-changes.ts](../../electron/collaboration/local-changes.ts) |
| 完整数据与正反例 | [examples.json](../../contracts/collaboration/examples.json)、[validation-cases.json](../../contracts/collaboration/validation-cases.json) |
| 离线调用示范 | [demo-collaboration.mjs](../../scripts/demo-collaboration.mjs) |

Schema 的 $defs 名称对应 parseContract 的名称；不支持默默补默认值、忽略未知字段或字符串转数字。字段和枚举有变化时，先改 Schema、TS 类型、共享样例及 TS/Python 测试，再修改生产者和消费者。破坏兼容的修改应使用新的协议版本，不能把现有 v1／v2 Bridge API 改成另一套含义。

## 2. 两个人先跑通相同的检查

需要 Git、Node.js 22 或兼容版本、Python 3.13。以下是 Windows PowerShell；macOS/Linux 使用 npm，虚拟环境 Python 路径为 ./.venv-contracts/bin/python。

~~~powershell
git fetch origin
git switch etrnal-dev
git pull --ff-only origin etrnal-dev
npm.cmd ci
py -3.13 -m venv .venv-contracts
.\.venv-contracts\Scripts\python.exe -m pip install -r services/remote/requirements-contracts.txt
$env:COLLABORATION_PYTHON = (Resolve-Path .\.venv-contracts\Scripts\python.exe).Path
npm.cmd run typecheck
npm.cmd run test:collaboration
npm.cmd run demo:collaboration
~~~

已有正确虚拟环境可以直接设置 COLLABORATION_PYTHON，不必重复创建。它应指向可执行文件，不要加命令参数。独立契约命令会构建 Electron 输出并运行 Python 测试和 Node 测试；找不到 Python／缺少依赖会明确失败。普通 npm test 未设置该变量时只跳过跨语言校验项，不代表独立契约验收通过。

demo 在内存中注册同账号 A/B 两台模拟设备、创建同一个逻辑项目、上报绑定、模拟授权并同步事件。最后会断言：模拟授权无法进入真实执行入口。它不启动模型、不联网、不写实际项目，也不会创建 GitHub PR。

不要把共享样例的假路径、提交号或模拟账号填到真实设备中。它们仅用于检查和开发。

## 3. 契约一：设备信息

接口：DeviceDirectory；方法：registerSelf、updateSelf、listDevices。

DeviceConfig 由设备提交：name、platform、acceptingTasks、maxConcurrency、agents。CollaborationDevice 是 Hub 快照，在上述字段上增加 schemaVersion、deviceId、online、lastSeenAt、connectionGeneration、activeTasks、revision。

| 字段／规则 | 含义 |
| --- | --- |
| deviceId | 稳定设备身份，由认证上下文确定；改名不换身份 |
| ownerId | 不接受请求体自报；认证层派生并隔离账号数据 |
| acceptingTasks | 是否接收新任务；关闭不取消已接任务 |
| maxConcurrency | 1–64；不能用 0 表示暂停 |
| agents | 最多 32 个、agentId 唯一；分别声明 worker／native-session 模式 |
| online | 连接层维护；在线不等于有容量或 Agent 已登录 |
| connectionGeneration | 新连接代次；旧连接断线不得覆盖新连接在线状态 |
| activeTasks | 运行时占用快照；降低最大并发后可暂时大于新上限 |
| revision | 实体版本；updateSelf 必须提交 expectedRevision 做 CAS |

registerSelf 使用稳定设备身份重复提交相同配置是幂等的；已有设备配置变更用 updateSelf。接口不提供“从远端修改任意 deviceId”的能力。

maxConcurrency、activeTasks 是调度参考。原子预留名额、持久化接单、精确取消与执行退出证据属于任务模块；本次 mock 没有实现任务槽或任务执行。

## 4. 契约二：项目与本机绑定

接口：ProjectDirectory；方法：createProject、updateProject、listProjects、reportBinding。

createProject(config, requestId) 要求为每次逻辑创建生成稳定请求 ID；网络重试复用同一个 ID，不能每次重试都新建。mock 会返回首次创建的项目响应，同 ID 不同内容拒绝；生产 Hub 要持久化这一幂等记录并约定保留期。requestId 使用与实体 ID 相同的 ASCII 格式。首次创建后的最新项目状态由快照／事件获取。

共享项目由 projectId、name、repository、可选 repoSubdirectory 和 revision 组成。仓库身份使用规范化的 HTTPS GitHub URL，可附带经过可信来源核实的 repositoryId。后者目前仅作为元数据，不会代替 URL／本机副本核验。仓库改名／迁移应更新项目并重新核验本机绑定。

normalizeGithubRepository 支持 HTTPS、git@github.com:owner/repo.git、ssh://git@github.com/owner/repo.git，统一小写并去掉 .git；拒绝夹带用户名密码、查询参数、端口、路径穿越及仓库子页面的 URL。

repoSubdirectory 是仓库相对 POSIX 路径，例如 packages/app。不能使用绝对路径、盘符、反斜杠、空路径段、.／.. 或尾部斜杠。

两端绑定同一 projectId／仓库／子目录，本地目录不要求相同。例如 A 为 /home/a/station，B 为 D:/working/station。任务消息只携带 projectId 和准确基线提交号，不使用 A 的目录作为 B 的 cwd。

LocalProjectBinding 仅保存在对应电脑可信主进程：

- localRepoRoot：本机 Git 副本顶层，不能是父目录或随意子目录。
- taskWorkspaceRoot：用户明确批准的工作区父目录，可以在仓库外；应选专用目录，避免选系统盘根目录。
- permissionCeiling、allowedAgentIds、confirmed：本机权限上限、可用 Agent 和明确确认。
- revision：每次换目录、变更授权、撤销或重新授权都递增，并持久化。

Hub 只接收 BindingReport／BindingSummary：projectId、deviceId、state、bindingRevision、必要原因码和 Hub revision。结构校验会拒绝带 localRepoRoot 等额外字段的共享摘要。

ready 必须有正数 bindingRevision，不能带失败原因；unbound／invalid 必须给 reasonCode。撤销时不要删除版本信息：递增 bindingRevision 后上报 unbound + REVOKED，迟到的旧 ready 报告会被拒绝。

## 5. 契约三：本机授权核验

接口：LocalProjectAccessPort。任务模块必须调用两次，不能只根据 Hub 的 ready 摘要执行。

~~~text
接收任务并持久化幂等接单
→ resolveAuthorizedWorkspace(projectId, taskId, attemptId, Agent, baseCommit, 权限)
→ 任务模块准备对应 Git 分支／worktree
→ validateWorkspaceForExecution(本地授权引用, 实际工作区, 同一任务与尝试)
→ 检查真实结果，交给现有任务权限／沙箱／Agent 启动入口
~~~

本次 LocalProjectAccess 是可调用的真实核验实现，通过依赖注入读取已有项目／绑定／Agent 状态：

~~~ts
import { LocalProjectAccess, assertExecutableWorkspace } from './collaboration/index.js';

const projectAccess = new LocalProjectAccess({
  deviceId: authenticatedLocalDeviceId,
  getProject: id => localProjectCache.get(id),
  getBinding: id => localBindings.get(id),
  getAgent: id => localAgents.get(id),
});

const resolved = await projectAccess.resolveAuthorizedWorkspace({
  projectId, taskId, attemptId, agentId,
  baseCommit, // 完整 40 或 64 位小写 SHA；接收端必须已有此 commit
  requiredPermission: 'workspace-write',
  executionMode: 'worker',
  expectedBindingRevision,
});
if (!resolved.ok) return showTaskError(resolved.error);

// 由既有 TaskWorkspaceManager 准备工作区。此处省略创建／恢复逻辑。
const checked = await projectAccess.validateWorkspaceForExecution({
  authorizationRef: resolved.value.authorizationRef,
  taskId, attemptId, workspacePath: preparedProjectDirectory,
  baseCommit, bindingRevision: resolved.value.bindingRevision,
  effectiveAgentPermission: 'workspace-write',
});
if (!checked.ok) return showTaskError(checked.error);
const workspace = assertExecutableWorkspace(checked.value);
// 把 workspace 交给既有任务运行时，仍需容量锁、任务权限、沙箱和生命周期核验。
~~~

真实核验内容：

1. 项目、本机身份、已确认绑定、Agent 登录能力／模式／授权范围。
2. 通过 realpath 检查目录，核对 Git 顶层及 origin 与逻辑仓库的关系。
3. 子目录必须留在实际仓库内；准确基线 commit 已在本机。
4. 准备好的工作区必须位于已授权仓库项目目录或 taskWorkspaceRoot 内。
5. 用 Git common directory 核对工作区属于本机同一仓库；同 origin 的另一份未授权 clone 不能冒充 worktree。
6. 项目子目录、HEAD 必须与请求一致；Agent 实际权限不能超过或改变本次请求权限。
7. 第二次核验重新读取配置／真实路径；换目录、撤权、Agent 变化、版本变化、过期、任务／尝试不符均拒绝。

它只读文件系统和 Git，不自动 fetch、创建目录／worktree、启动 Agent 或访问 GitHub。授权引用仅本进程有效，默认 60 秒、上限 5 分钟，最多保留 1024 个；过期或重启后需重新解析。

第一版契约只支持 read-only／workspace-write；完全访问等未声明原生权限会拒绝，不能静默提升授权。已有原生会话如果权限更宽，应明确降低会话权限，或后续另行设计更高权限契约与确认流程。

这不是操作系统沙箱：执行模块仍须防止核验后目录被替换，并按实际 Agent 能力配置沙箱、禁止任意路径执行。assertExecutableWorkspace 是消费侧防误用检查，不是验证远端传来对象的签名；核验服务、授权引用和返回值必须留在可信主进程，不能经 IPC 接收一个自报 local-verified 的对象直接执行。

## 6. 契约四：状态变化通知

共享接口：CollaborationChanges；方法：getSnapshot、replay、subscribe。

账号内共享事件：

| type | payload | streamId |
| --- | --- | --- |
| device.changed | 最新完整 CollaborationDevice | device:deviceId |
| project.changed | 最新完整 CollaborationProject | project:projectId |
| project.binding_changed | 最新完整 BindingSummary | binding:projectId:deviceId |

每条有 schemaVersion=1、scope=account、eventId、seq、revision、occurredAt。revision 必须等于 payload.revision；seq 是账号内全局递增游标；occurredAt 只展示时间，不能决定覆盖顺序。设备上线、离线、配置和能力变化统一发 device.changed，不需要消费者合并半条记录。

CollaborationProjection 提供 loadSnapshot、apply、getSnapshot：

- 相同事件重复到达不重复应用；已覆盖的旧 seq 忽略。
- seq 有缺口时抛 SNAPSHOT_REQUIRED，不跳过缺口继续写状态。
- 事件 ID 被重用、实体 revision 倒退／同版本不同内容，抛 EVENT_CONFLICT。
- 快照比当前 cursor 旧则拒绝；返回数据为副本。
- 每个账号单独建立投影；切换账号要销毁旧订阅和投影，不能复用另一账号的 cursor。

生产连接初始化／重连顺序应为：认证并建立可缓冲事件的订阅 → 获取一致性快照 → loadSnapshot → 应用缓冲中 seq 大于快照 cursor 的事件 → replay(cursor) 补齐。日志过期或仍有缺口就获取新快照。真实适配器必须确认订阅已经建立，不能先读快照再盲目订阅造成漏事件。

本机授权通知另用 createLocalAuthorizationChanges：

~~~ts
const changes = createLocalAuthorizationChanges();
const unsubscribe = changes.subscribe(event => invalidateLocalTaskEligibility(event.projectId));
// 先持久化变更／撤销并递增版本，再通知消费者。
changes.publishCommitted({
  schemaVersion: 1, scope: 'local', type: 'project.authorization_changed',
  projectId, deviceId, bindingRevision: nextBindingRevision, occurredAt: Date.now(),
});
// 同时另发不带目录的 BindingReport，供其他设备刷新调度参考。
~~~

本地事件不进入账号共享事件通道，也不接受 localRepoRoot。通知仅用于刷新缓存／界面，执行前仍必须重新核验授权事实。

## 7. 校验和异常使用

~~~ts
import { parseContract, validateContract } from './collaboration/index.js';
const request = parseContract('authorizationRequest', untrustedJson); // 无效抛 ContractError
const checked = validateContract('device', responseJson); // Result，无效不抛
if (!checked.ok) showError(checked.error.code);
~~~

~~~python
from collaboration_contracts.validation import validate_contract
checked = validate_contract("deviceConfig", request_json)
if not checked["ok"]:
    # 返回标准 INVALID_INPUT；不回传原始 jsonschema 错误或请求值。
    ...
~~~

两端都限制纯 JSON、大小 256 KiB、深度 24、节点 20000，校验不改变输入，也不返回包含原始路径／敏感值的校验错误。Python 适配器只读取仓库内 Schema，不向网络获取远程 $ref。它现在是开发／接口适配入口，现有 Hub 路由没有自动挂载它。

业务方法统一返回 Result<T>：

~~~ts
{ ok: true, value: /* 已校验数据 */ }
{ ok: false, error: { code, message, retryable } }
~~~

| 错误码 | 消费方处理 |
| --- | --- |
| INVALID_INPUT | 修正字段、版本或未支持的权限；不自动重试 |
| NOT_FOUND／DEVICE_SCOPE_MISMATCH | 检查认证账号、设备及项目归属 |
| REVISION_CONFLICT | 刷新快照后重新确认配置修改 |
| PROJECT_UNBOUND | 接收端绑定并确认本机目录 |
| REPOSITORY_MISMATCH／PATH_NOT_AUTHORIZED | 接收端检查真实副本、子目录和工作区授权 |
| PERMISSION_EXCEEDED／AGENT_UNAVAILABLE | 调整接收端授权或选择具备该模式的 Agent |
| BASE_COMMIT_UNAVAILABLE | 接收端 fetch／准备准确基线；不静默换 HEAD |
| BINDING_CHANGED | 重新解析本机授权 |
| AUTHORIZATION_NOT_FOUND／AUTHORIZATION_EXPIRED／TASK_MISMATCH | 获取当前任务／尝试的新授权，不能复用旧引用 |
| SNAPSHOT_REQUIRED／EVENT_CONFLICT | 停止应用可疑事件，刷新共享状态并核对来源 |
| SIMULATION_ONLY | 开发模拟对象误进真实执行，修正依赖注入 |

retryable 只是可重新查询／解析的提示，绝不表示允许重新执行已投递的任务。断线、超时、界面关闭不能被这些接口当成任务已取消或已失败的证据。

## 8. 如何并行使用

### 新成员

从 DeviceDirectory 和 ProjectDirectory 开始实现设置页、主进程服务与 Hub 存储／路由；界面开发先注入 createMockCollaborationHub().forPrincipal(...)。forPrincipal 只是测试上下文，不提供真实登录校验，不能把它暴露给 renderer 或挂成公网接口。

React 端只导入这些文件中的 type，并通过受限 IPC 获取共享 DTO。mock、Ajv/fs 校验、本地授权服务均在 Electron 主进程或 Node 测试中实例化，不能直接把本模块的运行时代码打进 renderer。设置页需要的本机目录展示另用受限显示 DTO，不传授权引用或整个 LocalProjectBinding 作为执行凭证。

本机授权模块可复用 LocalProjectAccess，把本地配置仓库、Agent 状态读取器注入；保存授权后发本地通知和共享摘要。Hub 的身份隔离、注册幂等、CAS、事件与快照一致性需要数据库事务和生产认证，不能直接把 Map mock 当生产服务。

### 维护者

会议与调度先依赖 CollaborationClient 和 LocalProjectAccessPort，使用相同 mock 开发手动／自动分配、资格展示和错误处理，不必等待新成员的设置页完成。生产执行只注入 LocalProjectAccess 或经过同等核验的实现，保留本地核验到执行的可信调用链。

任务幂等键至少关联 taskId／attemptId，接收端独立核验准确基线、本机授权和并发。这里没有新增共享会议、任务命令、租约或任务生命周期协议；它们由维护者后续实现，不得把设备目录事件解释成执行命令。

双方都应在自己的功能分支开发并提交小 PR；公共类型／Schema 改动单独提出，先同步样例和契约测试。此次按用户要求直接上传 etrnal-dev，方便共同起步，不代表以后需要两人同时直接推这个分支。

## 9. 当前已完成与后续工作

已完成：四项类型与端口、同源双语言结构／语义校验、正常及失败样例、同账号内存模拟、事件恢复投影、本地通知、真实本机 Git／目录／权限核验、独立测试与 demo、手动三平台 CI 定义、Schema 打包清单。

仍需功能开发：Station 内置设备 UI／持久化／凭证与生产连接服务、Hub 新路由和迁移、共享会议、跨设备投递／执行／幂等／停止／断线核对，以及实际 PR 交付串联。没有因本次提交修改现有云服务配置。

真实通信后续使用独立 /api/collaboration/v1 与相应认证事件通道（最终 URL 由路由实现 PR 固化）；这些只是预留命名，当前服务器不存在已部署的同名 API。现有公网原生会话 HTTP／轮询及 /ws/desktop 通道继续使用原协议。

无需把 Navicat 连接、MySQL root、HUB_SECRET、Git／模型凭证交给新成员。开发本次基础只需源码与公开依赖；公网联调再提供维护者确认的测试服务地址和独立协作测试身份。

详细本轮实测结果见 [CONTRACT_CHECKS.json](CONTRACT_CHECKS.json)。手动 CI 只定义在 [collaboration-contracts.yml](../../.github/workflows/collaboration-contracts.yml)，本机 Windows 结果不能代替尚未运行的 Linux/macOS 原生验收。
# collaboration.3 增量契约

2026-10-22 R1–R4 修复沿用协议 2；命令与实体仍由 contracts/collaboration/v2.schema.json 同源校验。新增 message.retry={messageId}，仅允许 failed+exitConfirmed+notStarted 的原 Host 输入，按 retryOf 去重；message.event／wireMessage 增加 preparing 和 failed。原输入与错误保留，failed 不是 completed，不允许迟到进度覆盖。

HTTP 错误响应约定为 `{"detail":{"code":"FORBIDDEN","message":"具体操作权限原因"}}`（403）或 `{"detail":{"code":"AUTH_INVALID","message":"认证失败原因"}}`（401）。旧字符串 detail 继续可读；旧无分类 403 用同凭证快照验证区分认证与业务拒绝。认证后的 GET /api/collaboration/v2/identity 返回 ownerId/deviceId，用于安全恢复旧误标；X-Station-Device 必须与 token 的设备身份相符。WSS 4401 仅认证失败，1013 暂不可用，4406 协议不兼容。

capabilities 增加 unified-review-fixes-v1，新客户端同时声明 unified-meeting-v1,unified-review-fixes-v1；缺少新状态支持的旧客户端遇到 preparing/failed/retryOf 快照返回 426。依赖基线修订继续用原 plan.review，准确 SHA 和全部获准字段保持同一严格校验；只允许修改未分发任务，旧批准版本留在追加事件中，不需要新增 DDL。具体兼容与恢复说明见 [升级说明](../../services/remote/docs/COLLABORATION_3_UPGRADE.md)。
