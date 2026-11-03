# 原生 CLI Worker 验收：CLI 自身审批模式

日期：2026-11-02（Asia/Singapore）；证据更新：2026-11-03（Asia/Taipei）。依据：[当前接线规划](../../plans/2026-11-02-native-cli-worker-integration.md)。新路线已完成下述隐藏离线接线验证；**真实 Claude/Codex 引擎、账号和模型验收尚未执行**。旧 `scenarios.json`、harness 和 `results/` 是其各自 SHA/配置的历史材料，不修改或覆盖，不把旧结论迁移为当前通过。

本清单复用创建、追问、拒绝、停止、恢复和成果验证的目的；不要求子任务向 Host 发送工具审批，也不以 Host 没有收到请求作为失败依据。SDK、跨端用户审批等其他模式继续适用各自契约。

## 场景与通过标准

| 场景 | 验证行为 | 通过标准 |
| --- | --- | --- |
| N1 派工与启动 | 从现有产品入口派一个本机任务，创建/选定工作区并启动原生 CLI | 一个任务对应当前 attempt 和终端；信任/登录未就绪时不误贴任务；保留用户选择的 CLI 权限、模型与登录方式 |
| N2 追问与问答 | Host 给当前任务补充要求；Worker 通过任务通道提问或说明阻塞 | 进入同一原生会话，没有重复派工；问答不创建 Host 工具许可 |
| N3 CLI 原生审批 | 在隔离验收配置中选择该 CLI 支持的原生确认策略，分别允许和拒绝测试动作 | 直接在 CLI 原生入口处理；允许后执行，拒绝后目标不变并反馈拒绝原因；没有 Host 审批卡/许可依赖，也没有为通过测试启用 bypass |
| N4 成果回报与验收 | CLI 编辑自有测试仓库并回交当前任务的报告 | 报告带真实文件差异、测试结果与未完成项；持久化为候选后返回回执；Host 验收或返工。Stop/EOF/退出/终端打印字符串不能直接生成成功交付 |
| N5 幂等与身份 | 重发同一报告，提交不同内容重放或旧 attempt 报告 | 相同报告复用已持久化回执；冲突、无凭据、错误任务和旧 attempt 被拒绝；不会串任务或重复交付 |
| N6 停止 | 在自有根进程和后代仍活动时请求停止 | 先停止自动输入，再中断并按已有生命周期能力清理；只有独立整树退出证据才标确认，此后 30 秒无新动作。证据不足显示未确认，不伪造成功 |
| N7 接管与交还 | 自动任务中用户接管，修改后交还 | 中断/暂停状态明确且只有一个输入者；自动消息不与人工键盘竞争；交还先读实际改动再继续，不默改 CLI 权限 |
| N8 断线与重启 | 丢失应用连接、重启应用或 CLI，再处理任务 | 状态明确为可继续、已结束或未知；没有重复派工；旧任务通信凭据无效。未证明的自动恢复能力不声称支持 |

N3 只证明所选 CLI/版本/配置的原生允许和拒绝。目录、网络等限制仅在 CLI 实际支持并启用相应策略时按该策略验证；应用的任务说明不自动构成 OS 沙箱。无法表达的限制明确标为不支持，不通过修改引擎或新增 Host 逐次审批来补齐。

## 执行范围与证据

先用隐藏、自有 fixture 验证产品接线、报告和生命周期；真实原生 CLI、登录/信任交互和模型回合使用另行授权的指定环境。真实模型、付费、个人配置修改或可见终端操作不能从旧 B04 的授权记录推断。

每次记录应用 SHA、lockfile、CLI 实际版本与权限配置摘要、平台、task/attempt/终端或原生会话引用、命令/结果、diff/文件 hash、回报回执、停止证据及未验证项。公开记录脱敏，不含凭据或个人原始会话。模拟、真实引擎、CI 和用户验收分别记录。

Leo 交付本机接线及证据；主对话独立复核；Shawn 的指定平台验收与合入职责沿用现有分工，不视为对方已接受新的日期。本次本机 Claude/Codex 终端调度入口已接线，不等于生产验收或发布授权。

## 2026-11-03 离线接线证据

源码基线 `02f647f92a9f6b1a3b0ae1506718a62739cc439d`，分支 `codex/codex-native-production`；证据对应本次提交中的 `tests/native-cli-worker-n1-n8.test.mjs`。运行环境为 Windows x64（10.0.26300）/ Node v26.12.1，`package-lock.json` SHA256 为 `a3df1bbc02be91b14815d6add9613de6e600d6bc32af9cc76d8b8791a7dd18c8`；不读取个人 `~/.codex`、`~/.claude`，不调用账号或模型。临时 CLI 的版本字符串是夹具数据，不能用作已安装 Claude/Codex 版本证据。

| 场景 | 已执行的离线证据 | 仍待真实环境验证 |
| --- | --- | --- |
| N1 | 实际 Orchestrator 派单、工作区及 attempt 绑定；注入 PTY 的登录/信任文本门控、模型配置继承和无 bypass 参数 | Claude/Codex 的真实启动、登录、信任 UI 与任务输入 |
| N2 | 实际 `aha-worker` shim/HTTP、邮箱持久化确认、重复读取不重发、同一 PTY 追问及问答不产生工具许可 | 真实引擎在工具回合中消费追问与提问 |
| N3 | 隐藏 Node CLI 夹具模拟原生允许/拒绝；实际文件保持或改动，并通过真实回环上报 | Claude/Codex 原生审批入口和所选策略；本项不是第三方引擎审批证据 |
| N4/N5 | 自有 Git 工作区实际 diff、领域验证命令、冻结候选、持久回执、逐块审阅/返工/接受及临时用户仓库最终交付；幂等、冲突、无凭据、错误任务和旧 attempt 拒绝 | 模型自行编辑/测试并调用报告入口；报告中的自述测试结果不自动成为独立证据 |
| N6 | Windows 隐藏自有 Node 根进程和子进程；按绑定 PID 树停止、OS PID 退出检查、停止后 30 秒活动日志不增长；另有未确认分支和重复停止回归 | 真实 CLI 工具后代树及指定硬件；POSIX 的枚举与退出检查需以对应平台结果单列 |
| N7 | 注入 PTY 的单一输入者暂停；真实临时 Git diff 与新增文件摘要先于交还输入 | 真实 TUI 的人工键盘接管与继续执行 |
| N8 | 同进程内模拟应用重建/断线，恢复记录分类、无重复派工、旧凭据拒绝、显式重试保留原生后端 | 真实应用崩溃/重启及 CLI 会话恢复；未证明自动恢复 |

重跑（PowerShell，先将 `C:\Program Files\nodejs` 加入 `$env:PATH`）：

```powershell
npm.cmd run build:electron
node.exe --test --test-force-exit --test-concurrency=1 --test-timeout=120000 --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" tests/native-cli-worker-n1-n8.test.mjs
```

本地结果：N1–N8（N4/N5 合并为一个测试，共 7 个）及 9 个相关回归文件合计 **71/71 通过，无跳过**；`npm.cmd run typecheck`（Renderer/Electron）与 `npm.cmd run build` 通过。回归文件为 `claude-terminal-adapter`、`codex-terminal-adapter`、`global-hooks-admission`、`kickoff`、`pty-host`、`renderer-native-cli`、`renderer-plan-validation`、`terminal-sessions`、`worker-runtime-contract`（均为 `tests/*.test.mjs`）。

跨平台全量测试与构建以 Draft PR 的最终 SHA CI 为准；绿色 CI 不替代上表的真实引擎、模型、硬件或生产验收。
