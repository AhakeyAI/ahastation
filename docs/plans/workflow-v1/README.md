# Workflow V1 模块详细设计

初稿日期 2026-11-08。2026-11-09 补充工作身份、用户验收和 GitHub PR 交付。状态为实现设计，尚未完成业务实现与真实 CLI 验收。

依据 [总体架构](../2026-11-08-workflow-host-architecture.md)。用户交互模型为 Host → Worker。Host 自主分工，Worker 自主使用原生 CLI 和内部 subagent。服务用 workId 关联完整工作、委派记录及成果验收。

## 阅读与实现顺序

| 文档 | 内容 |
|---|---|
| [01 原生执行与桥接](01-runtime-and-bridge.md) | 同一 CLI 会话、双通道、轮次、中断、修订接收 |
| [02 存储与状态](02-store-and-state.md) | SQLite、工作身份、队列、事务、恢复与迁移 |
| [03 Host 与消息](03-host-and-messaging.md) | 工具契约、排队、返工、用户答复与交接 |
| [04 原生终端](04-terminal.md) | 输出协议、快照、一致性、输入所有权及留存 |
| [05 成果与交付](05-artifacts-and-delivery.md) | 候选冻结、成果验收、条件推送、真实 PR 与 Diff |
| [06 界面与 IPC](06-ui-and-ipc.md) | 用户流程、状态投影、窗口权限及输入 |
| [07 验证与落地](07-validation-and-rollout.md) | 垂直闭环、故障矩阵、迁移与实施顺序 |

## V1 边界

单设备、本地存储、一个根目录一个逻辑 Host。Host 使用 Codex app-server。Worker 使用 Claude Code / Codex 原生终端，一个工作对应一个仓库。GitHub PR 交付支持同仓库 head 与 base。跨设备、强隔离、多仓库单委派及定时自动化留给后续版本。

关闭单个窗口只解除查看。关闭最后一个窗口时，没有运行中的 Host 或 Worker 则直接退出；有则询问“后台继续”或“停止并退出”，默认后台继续：Windows 与 Linux 常驻托盘，macOS 保留 Dock 图标，从托盘或 Dock 可重新打开窗口或执行受控停止。应用显式退出执行受控停止；崩溃后保留事实并核对仍存活的执行。V1 不承诺 Electron 崩溃后 PTY 仍可重新附着，取决于当前 PTY 所有者生命周期。

现有 electron/main.ts 的 window-all-closed 处理会调用 shutdownAllSlots，并在非 macOS 平台退出应用，与上述行为不一致，属于 V1 必须改造的入口，细节见 06。

## 这次详细设计收敛的选择

| 决策 | 原因及代价 |
|---|---|
| SQLite + Electron 的 node:sqlite | 事务覆盖状态、事件和 outbox，避免额外原生数据库插件。store 接口从第一版起为异步，内部暂用 DatabaseSync，以后移到独立线程不改调用方。node:sqlite 在 Node 24 仍属实验性 API，随 Electron 锁定版本并回归。长日志放磁盘，平台安装包逐个验证 |
| 权威状态由主进程单写 | 服务与 UI 共享一致事实。进程外副作用通过 outbox 和核对完成 |
| 修订在轮次边界生效 | 一个 Turn 对应一个版本。运行中 steer 只提前通知，涉及范围变化时停止旧轮次再切换 |
| 空闲 CLI 的唤醒有通用降级 | 提问后 CLI 停在输入提示，旁路轮询不会被调用。优先使用原生协议或已验证的空闲注入；都不可用时结束进程，用原生恢复命令携带指令重启，代价是 TUI 重启一次 |
| 冻结与交接有通用降级 | 无法证明内部 subagent 和写入进程已停止时，改为结束 CLI 进程并以进程树退出作为静止证据，再按原生会话恢复 |
| 无法核对的执行可由用户放弃 | 旧进程身份无法核对时，Worker 不会永久卡住；用户确认后旧执行进入 abandoned，剩余风险显式记录 |
| 关闭窗口默认后台继续 | 长任务不因关窗中断；代价是需要托盘入口和明确的停止路径 |
| 能力证据按 CLI 版本匹配，执行期间关闭自更新 | 用户升级 CLI 后不会悄悄沿用旧版本的验证结论；未验证版本先快速探测，通过后暂停自动投递，提供验证、改用已验证版本和人工投递入口；自动降级也只使用已验证的能力 |
| Worker 内容对 Host 是数据 | 仓库中的注入文本即使误导 Host，也只能变成申请，权限仍由服务和用户确认把关 |
| 轮次停止、CLI 退出、业务完成分别记录 | 保留真实 TUI，避免进程退出被当成目标完成 |
| 工作身份独立于 Worker，成果逐版验收 | 队列、交接和返工共用稳定 workId。封存成果后释放 Worker，接受或退回绑定一个版本，代价是服务维护独立的工作投影与成果索引 |
| Git 操作通过结构化 argv 和 stdin | 适配 Windows，按明确文件清单处理修改，避免 shell 拼接 |
| GitHub PR 使用平台返回的 Diff 快照，首次推送校验目标不存在 | 真实 PR 可能采用不同的比较基线。快照和接受前的核对增加网络开销，换取明确的可查版本。新分支用空预期值约束创建，已有分支沿用普通快进 |
| 原生终端是主视图 | PTY 数据直接显示，旁路承担机器可读报告。序列化恢复能力需要与原生模式逐项对照 |
| 防误操作级权限明确展示 | 当前用户运行的 CLI 仍可能主动绕过配置，产品不得承诺强隔离 |

Delegation 的 spec 不可变，state 是事件投影并允许迁移。Turn 记录在进程退出后保留。预留字段有利于后续兼容，数据演进仍使用显式 schemaVersion 和迁移。

这些选择是本次建议实现，总代码版本尚未切换。实现前审阅它们的取舍即可，不额外增加逐步骤产品审批。

## 通用协议

所有修改入口使用以下信封，调用者身份由服务根据 IPC sender、Host 工具连接或桥接凭据确定。

```ts
interface CommandEnvelope {
  protocolVersion: 1;
  requestId: string;
  workflowId: string;
  workerId?: string;
  expectedRevision?: number;
  operation: string;
  payload: unknown;
}
type CommandResult =
  | { ok: true; requestId: string; operationId: string;
      disposition: 'applied' | 'queued' | 'replayed';
      revision: number; eventCursor: string; value: unknown }
  | { ok: false; requestId: string; code: string;
      retryable: boolean; currentRevision?: number; detail: string };
```

ID 使用服务生成的 UUID，版本号为对象内递增整数。事件游标、终端字节偏移和日志 recordSeq 使用十进制字符串传输，在服务内用整数类型操作，避免 JS 精度丢失。时间为 UTC 毫秒，展示转换为用户时区。

事件 seq、成员消息 messageSeq 和终端 recordSeq 属于不同序列，游标必须携带所属流身份，各自只确认连续已处理的前缀。它们不能相互比较或替代。

错误至少包括 INVALID_INPUT、NOT_FOUND、STALE_REVISION、REQUEST_ID_CONFLICT、FORBIDDEN、CAPABILITY_UNAVAILABLE、INPUT_OWNED、WAITING_RESOURCE、EXECUTION_UNCONFIRMED、BASE_MOVED、STORAGE_UNAVAILABLE、REVISION_IN_FLIGHT、TARGET_IN_USE、RECOVERY_PENDING、VERSION_UNVERIFIED，以及 PR 版本变化 `PR_REVISION_CHANGED` 和差异无法核对 `PR_DIFF_UNAVAILABLE`。queued 只证明请求已保存。原生投递结果从操作查询或事件订阅取得。

每个来源独立区分 accepted、delivered、consumed、completed。写入 PTY 成功只证明字节已交给终端。没有原生或桥接处理回执时，状态停在 delivered。

## 全局不变量

1. 一个工作流同时只有一个有效 Host 运行代次。
2. 一个 Worker 同时至多持有一个当前委派及一个待生效委派版本。其余完整工作在 Work 队列里等待领取。
3. 同一 Worker 默认至多一个活跃原生轮次。原生内部 subagent 归入该执行。
4. 每个 Turn 固定委派版本和 workId，旧版本消息只进入原工作历史。
5. 单个请求在事务内至多生成一次实体和副作用意图，外部执行结果不明时先核对。
6. 必要验证和交付完成后才能封存 WorkResult，只有用户接受当前准确成果版本才完成 Work。
7. 屏幕快照覆盖一个确定日志前缀，后续实时流严格延续该前缀。
8. 用户决定绑定具体对象与版本，服务自行识别授权，Host 无权伪造用户身份。
9. 会话按进程生命周期计量，自动轮次输入前原子预留执行及独占资源。阻断类条件（未答问题、缺少授权、冻结）必须全部解除；依赖成果类等待按 SetWaitCondition 声明的 all / any 组合计算，两者都满足后才恢复执行。
10. 原生按键与外部副作用结果不明时先核对，持久化请求去重不等于对任意外部动作保证恰好执行一次。
11. Worker 来源的文本（报告、问题、Artifact、终端输出）不能产生权限。扩大范围、交付、推送等动作只能由服务校验或用户结构化确认产生。
12. 能力证据只对记录的 CLI 版本有效；同一 Execution 内 CLI 版本不变。
13. PR 编号、仓库身份、实际 base/head 与 Diff 哈希在成果版本中固定。读取旧成果始终使用原快照，接受前核对当前 PR。

## 第二轮模块复核

本轮补充 Host 验收工具、无遗漏唤醒、资源预留、多条件等待、outbox 领取与撤销边界、终端输入的不确定结果、人工新执行归属，以及验证脚本修改源文件时的处理。交付占用检查已移到分支更新之前。

为控制 V1 实现规模，部分交接由 Host 组合“暂停、冻结、源范围修订、接手委派”完成，复用已有接口并逐步记录恢复状态。各项验收见 07 的复核增补矩阵。

## 第三轮模块复核

本轮补充：关闭窗口后的后台运行；空闲 CLI 唤醒与“结束进程后恢复并携带指令”的降级路径；冻结降级为进程退出证据；无法核对执行的用户放弃路径；store 异步接口与刷盘参数实测；Host 运行时 P0-G 与 Host 工具 requestId 推导；补全辅助对象的状态迁移；输入所有权的自动释放；已检出目标分支的快进交付与只推送远端的交付方式；终端日志刷盘与快照期间的终端查询应答。总体架构已同步，二者不一致时以本目录为准。

## 第四轮模块复核

补充 CLI 版本变化的处理（01“CLI 版本与能力漂移”）：每次启动记录版本，未验证版本先快速探测，执行期间关闭自更新。补充 Worker 内容的信任边界（03“Worker 内容的信任边界”）：Worker 来源文本对 Host 是数据，权限不依赖 Host 的判断，AskUser 与授权界面显示真实来源。对应验收见 01、03、06 和 07。

## 第五轮模块复核

- 未验证的 CLI 版本：自动降级也只能使用该版本已验证的能力，因此暂停自动投递，提供验证、改用已验证版本和人工投递入口（01）。
- 已检出工作区的快进交付：增加未跟踪与被忽略文件、assume-unchanged / skip-worktree 标记、大小写冲突的前置检查，并使用 `--no-overwrite-ignore`（05）。
- 服务端 Git 调用加固：推送凭据只在服务私有的裸仓库中使用；在 Worker 可写仓库中执行的 Git 命令不持有凭据，并禁用 hooks 与 fsmonitor（05）。
- 刷盘：产生外部操作的事务一律 FULL，性能问题优先移出主线程解决（02）。
- Host 工具调用：批内序号只在证明精确重放时使用，否则批次待核对，Host 确认恢复摘要前修改类工具返回 RECOVERY_PENDING（03）。
- 草稿标记：按输入序号把轮次开始证据关联到具体提交点，只清除该提交点之前的草稿（04）。

## 核对证据

本地检查基于 feat/worker-cli-bridge，HEAD 777e176 及既有未提交改动。实际安装 Electron 42.11.18、内嵌 Node 24.19.0；通过 ELECTRON_RUN_AS_NODE 的内存数据库探测得到 SQLite 3.53.3。这是单环境 API 可用性证据，未验证磁盘故障、打包或其他平台。

现有 terminal-cli-adapter 的 readiness 包含定时兜底，worker-cli-bridge 使用静态环境令牌，RealTerminal 依赖环形回放，main.ts 在关闭全部窗口时结束所有执行槽。这些是迁移入口，不能直接视为满足本设计。

官方资料已用于核对 API 方向，文档当前版本不代表本机 CLI 已具备全部功能。[Node 24 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)、[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Claude hooks](https://code.claude.com/docs/en/hooks)、[xterm write](https://xtermjs.org/docs/api/terminal/classes/terminal/)、[序列化插件](https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-serialize/README.md)
