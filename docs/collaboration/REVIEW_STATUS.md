# 跨设备协作评审状态（2026-10-29）

评审入口是 [PR #55](https://github.com/AhakeyAI/ahastation/pull/55)。本轮验证基线为 32f3801 加已审查的本地增量，现固定为 etrnal-dev 上的本地修复快照提交。对外评审必须附实际完整提交号并对应测试证据，不能只引用原基线。四批独立交付尚未完成。10-29 已核对任务 Issues 和 IF-2/3/4 新草案，接口确认在对应 Issue 进行，不能将邮件草案视为已冻结契约。

## 当前方向

Station 负责跨设备派发、持久化、回执、核对、状态同步及交付授权；终端线负责 Worker 原生 CLI、hooks、接管机制和进程树。Host/专家仍走 SDK。Python Worker 本周保留，执行端接口就绪后再迁移，不能删除仍有其他调用者的原生兼容模块。

产品版协作入口保持关闭：不启动恢复、探测、连接、重连或定时器，IPC 只提供关闭状态，拒绝操作。开发环境只有明确指定隔离 profile、AHASTATION_ENABLE_COLLABORATION=1 和 AHASTATION_REMOTE_ALLOW_LOOPBACK=1 才可进入本机预览；预览拒绝公网 HTTP/WSS。设备签名/验签未完成，不开放正式入口。

关闭门同时覆盖本分支新增的公网身份请求、目录查询和 Pocket Vibe 公网会话，包括已经保存的公网凭据；main 原有 LAN 兼容方式保留。跨设备首版目标为 Claude 和 Codex，两者的原生 CLI 路径仍需终端线和真实 B04 验收，不能把当前过渡 Codex 路径当作双 Agent 已完成。共享本机/远端并发 2 也需与终端线 scheduler 对齐。

## 验证与依赖

K01 和跨 attempt P1 已获增量复核解除阻断，完成证据、退出证据和当前 attempt 的约束继续保留。Codex 基准为 0.156.1，允许区间由 contracts/runtime/codex.json 唯一定义；区间扩大仍需要真实冒烟和兼容检查。

既有实际测试在本地证据目录 `docs/collaboration/evidence/2026-10-28/`；10-29 增量影响评估、回复草稿及验证记录另存 `docs/collaboration/evidence/2026-10-29/`。过程性资料不属于四批正式合入内容。最新已读取 main 为 597532e（包含 #54/#120），#53 尚未合入；C1 rebase 尚未执行。Mac、双机、三平台 CI、真实模型 B04 仍须单独验收。

IF-6 已准备受控组件及现有数据投影的[本地候选接口](SHARED_PANEL_INTERFACE.md)，由 he-1102 确认接口、产品验收布局；尚未对外发送或获得确认。IF-2 v0.2 所需可信启动身份及单写接口尚未接通，旧 owned.json 登记不能当作新协议通过。IF-3 项目权威注册与历史 alias、IF-4 接管快照和控制栅栏、IF-7 设备清单、IF-8/IF-5 终端流均待共同确认和实现；不以模拟数据或网络重连补足这些证据。

来源和许可状态见 [UPSTREAM_NOTICE.md](../../services/remote/UPSTREAM_NOTICE.md)。公网 Hub 环境、维护归属和线上版本仍待维护者确认，评审不连接它。K02 历史现场根因仍待原始脱敏日志。

## 本机最短验证

安装 Node、Git 和 Python，依赖安装期间不启动 Agent：

```powershell
npm ci
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r services/remote/requirements-public.txt -r services/remote/requirements-station-native.txt
$env:COLLABORATION_PYTHON=(Resolve-Path .venv/Scripts/python.exe).Path
$env:POCKET_VIBE_TEST_PYTHON=$env:COLLABORATION_PYTHON
$env:AHASTATION_BUILD_PYTHON=$env:COLLABORATION_PYTHON
npx playwright install chromium
npm run typecheck
npm run test:collaboration
npm test
```

macOS/Linux 使用 `.venv/bin/python`。隔离运行器设置临时 HOME、模型配置与状态目录，清除模型凭据，Node/Python 网络只允许 loopback。它不是操作系统网络沙箱：原生 Git、浏览器及冻结组件仍需受控夹具与人工检查。真实模型测试是独立命令，本轮不执行。

Hub 最短隔离步骤和建库工具见 [remote README](../../services/remote/README.md) 与 [MySQL 5.7 升级说明](MYSQL57_HUB_UPGRADE.md)。可以复用 scripts/rehearse-collaboration-mysql.py，它绑定 127.0.0.1、使用独立数据目录及数据库。现有 Compose 只包含 Hub，仍需外置 MySQL；本轮没有 Docker 验收，不把 Compose 当作开箱即用的数据库环境。

仅检查协议时，在仓库根目录运行本机 SQLite 夹具（不代表 MySQL 验收）：

```powershell
& $env:COLLABORATION_PYTHON services/remote/tests/station_collaboration_fixture.py
```

它输出本机地址和临时测试身份，保持终端运行；输入回车停止。需要真实 MySQL 5.7 时，将发行目录替换为本机已解压位置，运行独立演练，工具自动建库、建非 root 测试用户、迁移并在结束后关闭自有实例：

```powershell
node scripts/test-offline.mjs mysql '<mysql-5.7-directory>' runtime/local-mysql-review
```

两种方式都不读取公网连接配置。使用新的 output 目录，保留日志与数据库证据。

可信代理默认关闭。维护者确认真实 ingress 的 IP/CIDR 后才能设置 HUB_TRUSTED_PROXY_IPS，禁止通配所有来源；不能直接采信客户端转发头，也不能推测云托管的代理地址。

## 历史证据

历史修复报告、开发快照、提示词和验收过程记录已移到本地忽略目录 `runtime/evidence/2026-10-28/history/`。`HISTORY-MANIFEST.json` 保存原路径、归档路径及 SHA-256，原文保留，未将历史通过数改写成本轮结果。未跟踪的 ROOT_CAUSE_AUDIT_2026-10-26.txt 保持原样。

正式合入仅选契约、当前使用说明、必要架构说明和实现测试，不包含本机过程报告或提示词。实际四批边界见 [REVIEW_BATCHES.md](REVIEW_BATCHES.md)。
