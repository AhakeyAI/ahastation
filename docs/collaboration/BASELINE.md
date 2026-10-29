# etrnal-dev：可复现源码基线

> 当前状态以 [REVIEW_STATUS.md](REVIEW_STATUS.md) 为准：PR #55 已存在且保持草稿，ADR 0019 已调整 Worker 执行分工；下方保留早期基线记录。

> 2026-10-27：main本地整合、K01修复、K02诊断及最终验证见 [当前交接](REVIEW_STATUS.md#历史证据) 与 [实际验收结果](REVIEW_STATUS.md#历史证据)。下方旧基线历史保留；本地整合不等于公开发布。

> 2026-10-24：本分支新增 collaboration.5 开发快照，当前进展、启动依赖、验证限制和未修问题见 [DEV_SNAPSHOT_2026-10-24.md](REVIEW_STATUS.md#历史证据)。下文保留最初基线与四项契约的历史状态；“未完成”等描述不能当作最新实现清单。

本分支用于向新成员交接已有源码，并作为后续公共契约与多设备开发的起点。
它不是“共享会议、多设备 Worker 已全部实现”的产品发布。

## 代码来源与合入方式

- 目标仓库：ShawnyinsGit/ahastation-internal；目标分支：etrnal-dev。
- 合入前远端提交：c134de22efed4fbf17bb5af1c727f6f7c36a15f6，保留其全部提交。
- 本地 Station 修改原基线：8f1506e4d22c51b07805cfc5f49c1fb25d634cdd。
- 原本未提交的 Station 远端控制、会议恢复、启动修复和相关回归测试一并纳入。
- services/remote 导入必要 Hub、原生兼容、部署和测试源码，来源及原始文件哈希见
  [UPSTREAM_SOURCE.json](../../services/remote/UPSTREAM_SOURCE.json)。
- 合入在独立 worktree 完成；原本 Station 和 Pocket Vibe 工作目录未被覆盖。
- 凭证、原生历史、运行数据、依赖和构建产物不在提交范围。

## 已有能力与下一阶段

已有：本地会议／任务调度；Station 远端身份与原生会话选择；Hub／Bridge 通信；
任务幂等、取消与恢复；Codex 桌面共享服务兼容源码；会议恢复与启动回归。

未完成：Station 原生接收设备、projectId 绑定、共享会议、按设备调度 Worker，
以及四项契约的生产实现。完整目标和分工见
[整体交接文档](MULTI_DEVICE_COLLABORATION_HANDOFF.md)。

## 干净克隆后启动

使用 Git、与 CI 一致的 Node.js 22 或兼容的更新版本。

~~~powershell
git clone --branch etrnal-dev https://github.com/ShawnyinsGit/ahastation-internal.git
cd ahastation-internal
npm.cmd ci
npm.cmd run typecheck
npm.cmd run build
.\Start-AhaStation.cmd
~~~

Windows 使用 npm.cmd；macOS/Linux 使用 npm。
开发热更新需要两个终端：先 npm run dev，再 npm run dev:electron。
Start-AhaStation.cmd 是 Windows 源码启动辅助，不是正式安装包。

Hub/Python 安装、隔离测试、初始化和源码 ZIP 说明见
[services/remote/README.md](../../services/remote/README.md)。
不再需要另外克隆 pocket-vibe-agent 才能运行源码内的 Python fixture。

## 测试配置

- 隔离评审只使用显式配置的本机 Hub，不连接 resources/remote-service.json 中维护者配置的公网地址。
- 新成员使用独立协作测试账号；账号密码私下交接。
- 模型／Git 登录保留在各自电脑，不进仓库。
- MySQL、HUB_SECRET 等只在 Hub 的私有配置中；不分发给 Station 客户端。
- Node 中的 Python 联调用例由 POCKET_VIBE_TEST_PYTHON 显式启用。
- 原生 MySQL、真实 GUI、模型、公网和 ARM64 验收与离线测试分开记录。

## 合入中特别保留的行为

- 远端最新的终端／已邀请 Host 恢复、聊天响应提示和异步认证探测。
- 已结束／失败会议不能仅因 registry 有记录而被标成运行中。
- 多项目迟到恢复必须维持用户当前选中会议；本地终端和远端成员共同恢复。
- Leave 与主进程 close 的超时保护，以及恢复标签和远端引用保留。
- AhaBar 对无意第二次启动的防打扰规则，与主窗口初始化／重新聚焦兼容。
- 公网身份不作为模型 API Key 输入；原生目标和权限约束保持。

## 验证记录

本次在 Windows 的独立 worktree 安装依赖，并对未改动远端版本和集成版本分别运行全量测试。

| 检查 | 实际结果 |
| --- | --- |
| npm ci | 通过；安装 529 个依赖，有既有依赖安装脚本提示 |
| renderer／Electron 类型检查 | 均通过 |
| renderer／Electron 构建 | 均通过；Vite 保留大 chunk 提示 |
| 未改动远端 Node 全量 | 922：883 通过、34 失败、5 跳过 |
| 集成后 Node 全量 | 972：933 通过、34 失败、5 跳过 |
| 集成后 Python 全量 | 110：92 通过、0 失败、18 跳过 |

两次 Node 的失败名称逐项一致；新增 50 项均通过，含三项真实本地 Hub／Bridge／Station 回环（离线执行器、临时项目）。全量退出码仍为 1，不能称为全部通过。双方均使用 concurrency=4、每文件 120 秒超时，没有 --test-force-exit。

34 个失败涉及已有观察／平台解析及 Windows 上 Qoder fs.watch 的 EPERM；本次没有修改这些实现或屏蔽测试。完整失败名单和数字见 [BASELINE_CHECKS.json](BASELINE_CHECKS.json)。Python 本次零失败不表示历史失败已被业务修改修复。

原生 MySQL、部署 Hub、公网、真实 GUI／模型以及 macOS／Linux／ARM64 安装包未在本次验收。原始测试日志仅本机保留，提交的是脱敏摘要。旧文档保留有日期的历史记录。

## 公共契约进展（2026-10-21）

四项契约已转为 Schema／类型、TS/Python 校验函数、共享正反例、可注入接口、内存模拟和真实本机核验，附独立测试及离线调用 demo。使用入口见 [CONTRACTS.md](CONTRACTS.md)，本轮验证见 [CONTRACT_CHECKS.json](CONTRACT_CHECKS.json)。

本页上方验证表是源码基线历史记录；新的契约实现没有切换现有 Station／Hub 入口。

仍需完成：

1. 双方阅读当前可调用契约，按后续实现需要提出版本化变更。
2. 新成员将 mock 端口替换为真实设备／项目服务，并由维护者部署新路由和迁移。
3. 固化新的 Station 设备通道和版本，完成真实最小消息往返；旧 Bridge 入口保持兼容。
4. 新成员在自己的干净环境复现契约测试，再联调会议和任务链路。

上传本基线不等于这些后续工作已完成，也不会自动创建／合并 PR 或部署 Hub。
