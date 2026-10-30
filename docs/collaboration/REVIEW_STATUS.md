# 跨设备协作评审状态（2026-10-30）

协作修复评审入口是 [PR #55](https://github.com/AhakeyAI/ahastation/pull/55)，修复快照已推送为 `c584e8006b45657236259032005e678666a6ae15`。影响评估、#84 回链及 IF-2/3/4/5/6/8 的本方回复均已发布。后续本地增量的验证与该快照分开记录；历史报告中的“未提交/未推送/未发送”是原阶段状态，不能作为当前事实。

负责人已在 [#136](https://github.com/AhakeyAI/ahastation/issues/136) 改用 [PR #135](https://github.com/AhakeyAI/ahastation/pull/135) 完成第一次统一整合。10-30 只读核对 main 为 `b571b2c`、整合候选为 `d358977`；PR #135 仍是未合入的草稿，历史尚未包含 `c584e80`。本地修复通过不代表整合候选保留了修复，更不代表 main 已验收。原四批保留为[审查边界](REVIEW_BATCHES.md)，不再机械创建四个独立 PR；整合候选需绑定实际 head 核对本方冲突处理。

## 当前方向

Station 负责跨设备派发、持久化、回执、核对、状态同步及交付授权；终端线负责 Worker 原生 CLI、hooks、接管机制和进程树。Host/专家仍走 SDK。Python Worker 本周保留，执行端接口就绪后再迁移，不能删除仍有其他调用者的原生兼容模块。

产品版协作入口保持关闭：不启动恢复、探测、连接、重连或定时器，IPC 只提供关闭状态，拒绝操作。开发环境只有明确指定隔离 profile、AHASTATION_ENABLE_COLLABORATION=1 和 AHASTATION_REMOTE_ALLOW_LOOPBACK=1 才可进入本机预览；预览拒绝公网 HTTP/WSS。设备签名/验签未完成，不开放正式入口。

关闭门同时覆盖本分支新增的公网身份请求、目录查询和 Pocket Vibe 公网会话，包括已经保存的公网凭据；main 原有 LAN 兼容方式保留。跨设备首版目标为 Claude 和 Codex，两者的原生 CLI 路径仍需终端线和真实 B04 验收，不能把当前过渡 Codex 路径当作双 Agent 已完成。共享本机/远端并发 2 也需与终端线 scheduler 对齐。

## 验证与依赖

K01 和跨 attempt P1 已获增量复核解除阻断，完成证据、退出证据和当前 attempt 的约束继续保留。Codex 基准为 0.156.1，允许区间由 contracts/runtime/codex.json 唯一定义；区间扩大仍需要真实冒烟和兼容检查。

既有实际测试在本地证据目录 `docs/collaboration/evidence/2026-10-28/`；10-29 增量影响评估、回复及验证记录另存 `docs/collaboration/evidence/2026-10-29/`。过程性资料不属于正式合入内容。本地版本契约、异步凭据、N1–N6、主持设备专属的计划批准、入口关闭及 IF-6 候选已有修复与回归，不能因尚未整体验收而改记为未实施。C1 的正式前置现为 #136；尚未执行整合版 rebase 或合并。Mac、双机、三平台 CI、真实 CLI B04 仍须单独验收。

IF-6 已交付受控组件、[候选接口](SHARED_PANEL_INTERFACE.md)及实际 React 回归，并在 #98 回复，尚待 he-1102 确认与产品布局验收。IF-2/3/4/5 的本方契约确认已经发布，IF-8 提案等待 Leo 确认，IF-7 尚缺定义方的具体格式。IF-2 v0.2 的可信启动身份与单写接口、IF-3 的权威注册/mount/alias、IF-4 的控制快照与派发栅栏、IF-7 清单及 IF-8 终端流仍有本方实现工作，不能全部列为外部阻塞；旧 owned.json 和历史转发不算新接口通过。

[#138](https://github.com/AhakeyAI/ahastation/issues/138) 的本地修复只免除当前会话实际注册的 5 项内部复核工具的重复用户审批，继续执行工具自身的角色、review 与成果证据校验；普通工具、外部 MCP 和观察会话写操作保留审批。它与原 C6 的主持设备权限回归分别验证。无模型正式回归只能证明适配器和内部工具校验链，不能替代 PR #135 的 macOS Claude 实际复验。

兼容更新脚本读取同一份源 JSON 契约，复用现有校验并核对依赖锁，生成候选或失败检查卡。检查失败时，`updateRequired` 仅通知现有工作流进入调查报告分支；成功检查不触发该分支。两种结果的 `passed`、`canApply` 均为 false，不授权应用版本变更。握手和 adapter/transport 测试通过不满足 G8；脚本不扩大当前区间、不修改内置版本或依赖锁。实际版本扩大仍需另行授权的真实冒烟和评审。

来源和许可状态见 [UPSTREAM_NOTICE.md](../../services/remote/UPSTREAM_NOTICE.md)。公网 Hub 环境、维护归属和线上版本仍待维护者确认，评审不连接它。K02 的脱敏 RPC code/message、任务绑定及持久化诊断链已实现并有回归；历史现场拒绝根因仍缺原始证据，不能从新夹具猜测。

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
