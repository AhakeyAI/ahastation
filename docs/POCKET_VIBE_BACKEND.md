# Pocket Vibe Backend — 交接说明（给后续维护的 CLI/开发者）

> etrnal-dev 源码基线已将必要 Hub／Bridge 兼容源码纳入 services/remote。本文下方相邻仓库和机器绝对路径属于历史记录；当前可复现入口见 [BASELINE.md](collaboration/BASELINE.md)。

> 2026-10-10：当前工作树新增可选公网远端控制：独立所有者身份、单次配对、每设备凭证、MySQL Hub、后台 Bridge 交付和真实取消链路。Station 使用“设置 → 远端控制”，普通流程不再把远端凭证当模型 API Key。使用、当前验证及部署包见 [PUBLIC_REMOTE_CONTROL.md](PUBLIC_REMOTE_CONTROL.md)。本文下方 Token、默认127.0.0.1、无目标 Host/Worker 和“只停止等待”属于显式 LAN 兼容模式；公网没有默认地址/Token，必须选择已有会话，不能用无目标 backend 当会议主持人或自动 Worker。

> 2026-10-05：已有原生远端会话选择功能的使用、接口与离线测试见 [POCKET_VIBE_REMOTE_SESSIONS.md](POCKET_VIBE_REMOTE_SESSIONS.md)。下方机器路径为历史交接信息，请按实际操作系统检查。

> 2026-10-08：已在当前未提交工作树修复远端点名误投本机、附件误投、恢复权限、稳定设备身份/跨 Bridge 锁、执行超时清理和在线引用校验。当前使用、兼容边界、真实 Codex 验证及与基线对照的测试结果见上述文档的“本轮修复验证”。停止等待仍不取消远端进程；只有电脑端执行超时/异常触发任务进程清理。

> 2026-10-08 上轮审查修复：并发目录刷新共享扫描并保留有效快照；实时任务/锁状态优先于历史结果；Windows 创建时原子加入 Job，Linux 使用 subreaper/pidfd 追踪整条后代链。当轮曾拒绝 macOS 执行，本次已加入专用实现；不能将此前的 session 清理测试当作完整后代链验收。

> 2026-10-08 本次修复：语音规范化点名直接绑定实际 hostId，多候选提示文本选择并停止发送；macOS 使用每任务临时 launchd 作业和经过核验的 resource coalition，保留原有命令、配置、入口及会话锁。Windows / Linux 实测与 macOS 模拟验证、待真实原生验收分开记录，详见 [远端会话文档](POCKET_VIBE_REMOTE_SESSIONS.md)。

> 本文档描述 2026-07-26 合入的 `pocket-vibe` 远程 backend。**改动尚未 commit**，
> 任何后续修改都必须基于当前工作区（不要从 /opt 安装版或旧 commit 出发）。

## 这是什么

`pocket-vibe` 是一个**远程 backend**：本机没有 CLI 子进程，任务通过 HTTP 发给
pocket-vibe hub（FastAPI，默认 `http://127.0.0.1:8787`），hub 再派发给注册上来的
远程 agent（Windows/Mac/Linux 上的 Codex/Claude CLI）。hub 源码在仓库外：
`../`（即 pocket-vibe-linux 项目根的 `device/`、`web/`）。

它同时支持两种会议角色：

- **Worker**（默认）：主持人 `delegate_task` 派活，远程 agent 用 ```work-report
  围栏帧交付（无 MCP，与 OpenCode 同模式）。
- **Host/参会者**：`capabilities.coordinate: true`，可在侧边栏"参与者"里被"邀请"
  进会议。协调走 codex 同款 portable 通道：模型输出 ```meeting-command 围栏帧，
  adapter 解析后经 `extra.meetingCommandHandler` 路由给
  `Orchestrator.executeMeetingCommand`。

## 改动文件（git status 可见，未提交）

| 文件 | 说明 |
|---|---|
| `electron/backends/pocket-vibe-adapter.ts` | 新增。`PocketVibeBackend` + `PocketVibeSession`（轮询式，串行队列） |
| `electron/backends/registry.ts` | +1 行注册 |
| `electron/backends/task-profile.ts` | +`compilePocketVibeTaskProfile` |
| `electron/orchestrator.ts` (~465) | PORTABLE_MEETING_COMMAND_PROMPT 追加条件扩展到 pocket-vibe |
| `tests/pocket-vibe-adapter.test.mjs` | 新增，14 个用例（worker+host+auth） |

⚠️ `electron/main.ts` 也显示 modified——那是**用户自己的改动**（RK3588 小屏
clamp + ANGLE/GLES），与本功能无关，**不要动、不要 revert**。

## 怎么跑最新版 app（关键！）

机器上有两个 AhaStation，别搞混：

- `/opt/AhaStation`（桌面图标）：**旧安装版，没有 pocket-vibe**。两者共用
  单实例锁，旧版在跑时新版会静默退出。
- **最新版 = 本源码树**，用项目根（pocket-vibe-linux）下的脚本启动：

```bash
../start-ahastation-dev.sh          # 或绝对路径
/home/cat/ai-voice/ahastation/pocket-vibe-linux/start-ahastation-dev.sh
../start-ahastation-dev.sh --build  # 改过 electron/ 后强制重建
```

脚本流程：检查 /opt 旧版冲突 → 按需构建 `dist-electron/` → 起 vite(:5173) →
开窗口。手动等价步骤：`npm run build:electron` + `npm run dev`（后台）+
`VITE_DEV_SERVER_URL=http://localhost:5173 node_modules/.bin/electron .`

### node 路径（与 AGENTS.md 不同！）

`/usr/local/bin/node` **不存在**。实际 node v22 在：

```bash
export PATH=/home/cat/ai-voice/ahastation/pocket-vibe-linux/.tools/node22/bin:$PATH
```

## 测试依赖：pocket-vibe hub

app 里的 pocket-vibe backend 需要 hub 才能真跑。hub 源码在
`pocket-vibe-linux/device/`（不在本 git 仓库内），启动方式：

```bash
cd /home/cat/ai-voice/ahastation/pocket-vibe-linux/device
../.venv/bin/python device_hub.py &        # :8787，token 默认 dev-token / dev-tool-token
POCKET_VIBE_AGENT_ID=linux-worker ../.venv/bin/python desktop_agent.py &
```

注意：未配 `--local-agent-config` 时 bridge 是 **echo 模拟**（不真跑 LLM），
适合测链路；要真执行需配 `configs/local_agent.example.json` 指向
`examples/codex_cli_adapter.py` 之类。

app 内配置（设置 → Pocket Vibe (远程)）：Base URL = `http://127.0.0.1:8787`，
API Key = `dev-tool-token`，Model = 目标 agent_id（如 `linux-worker`）。
**API Key 输入后需按回车/点保存才落盘。**

## 验证命令（改完必须跑）

```bash
export PATH=.../.tools/node22/bin:$PATH
npm run typecheck          # renderer + electron 两个 tsconfig 都要过
npm test                   # 全量（含 pocket-vibe 用例），基线 679 pass / 2 skipped
# 只跑本 backend：
npm run build:electron && node --test --test-timeout=120000 \
  --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" \
  tests/pocket-vibe-adapter.test.mjs
```

## 已踩过的坑（别再踩）

1. **"未配置"假象**：侧边栏参与者列表的"已配置"只认 `checkAuthStatus()`；
   新 backend 必须实现它（我们已补：有已存 tool token 即 loggedIn）。
2. **resolveBinary() 不能返回 null**：否则 registry 当"未安装"把卡片藏起来。
   远程 backend 返回哨兵 `'pocket-vibe-remote'`。
3. **worker 必须实现** `compileTaskProfile` 和 `normalizePermissionRequest`，
   否则注册表/计划门禁抛错。
4. pkill/pgrep 匹配 electron 路径时会匹配到 shell 自身命令行导致自杀，
   用 `pgrep -f "[e]lectron/dist/electron"` 字符类写法。

## 已知限制（设计使然）

- hub 无流式、无取消：每轮发言是完整远程 turn，延迟以十秒计；interrupt 只停本地轮询。
- 远程 agent 无 AhaStation MCP：worker 完成信号唯一通道是 ```work-report 帧；
  host 协调唯一通道是 ```meeting-command 帧。
- 不配 `POCKET_VIBE_SESSION_ID` 时远程侧无对话记忆（每轮新 exec，靠
  systemPrompt 重放兜底）。
- `FIRST_RELEASE_STABLE_WORKERS` 不含 pocket-vibe → UI 会标"实验"，属预期。

## Codex 桌面版电脑端接入（2026-10-12，上一版历史记录）

以下手动切换要求已由下节共享执行取代，当前桌面模式不走独立 exec。

电脑端 Bridge 已补自动组件发现和 thread/list/read 摘要目录；无需另装 Codex CLI。Station 只补选择器来源/状态说明，仍通过原 Pocket Vibe 适配器发送明确原生ID和电脑端cwd，没有修改本机 Codex transport 或其他backend。必须先在 Bridge 授权项目并确认释放桌面任务、切换控制；桌面占用未知，writer冲突明确失败，不另建会话。公网停止使用既有任务清理证明；LAN模式仍仅停止等待。详情与待验收见 PUBLIC_REMOTE_CONTROL.md、Pocket Vibe/BRIDGE_PRODUCT.md。


## 2026-10-12 桌面联动共享执行增量

Bridge 桌面模式使用同一常驻原生服务和桌面 socket；Station 仍用现有配对、目标引用、参与者、@、轮询和语音文本流程。选择器显示“Codex 桌面联动”来源与桌面执行/等待/Station 执行/停止未确认。首次由用户自行退出旧桌面，在 Bridge 点击“启动联动桌面”；之后不需日常归档、恢复、手动释放。没有共享连接或原生配置/退出证明不足时明确拒绝，不能回退独立 exec、本机或另一个会话。停止请求精确绑定原生 turn；断网和关窗不自动取消。

完整 GUI 双向接续仍待验收。当前已部署 Hub 未改动；本轮不部署、改 DNS 或数据库。实现、平台边界和实际测试分类见相邻 Pocket 仓库 docs/BRIDGE_PRODUCT.md 与 docs/SHARED_DESKTOP_ACCEPTANCE.md；旧独立恢复测试不替代本版共享服务验收。

## 2026-10-13 桌面断联恢复

Bridge 修复已启动桌面 turn 丢失完成通知后的占用核对：Station 等待心跳携带原 threadId，每会话有限频率核对同代原生实例，退出证明充分才释放并继续。证据不足保持待核对并自动重试；原任务仍运行时不提前发送。即使桌面未重连也可查询并确认旧任务退出，待同代桌面 socket 恢复后发送保留的同一 taskId，不重新提交、归档或配对。服务换代保持未确认，不猜测空闲。Station 本次没有业务代码变化，两端 typecheck 通过；协议测试不代表真实桌面界面验收。最新结果见 Pocket Vibe/docs/SHARED_DESKTOP_ACCEPTANCE.md。

## 2026-10-13 会议恢复与 Windows 独立启动

恢复项目记录不等于会议已经启动。桌面单项目也显示“继续会议”；启动中/失败/就绪分开显示，错误可重试。未启动不传 placeholder ID 到远端选择/邀请等真实会议 IPC，也不自动发模型指令。保存与重试保留原 device/provider/native thread/cwd 引用，退出前捕获快照；关闭占位项目更新存储，不清除其他项目。Renderer 重载可接回主进程已有会议。

设置窗口远端启用/登录/退出会通知主窗口刷新，不只依赖 focus。日常 Windows 测试双击仓库根目录 `Start-AhaStation.cmd`；使用本地构建文件，不依赖 Vite。原开发和打包命令保留。日志在 `%TEMP%\AhaStation-launch`，详见 [使用、冲突检查及验收记录](MEETING_RESTORE_AND_WINDOWS_LAUNCH.md)。此前独立启动工具操作被自动审批拒绝“blocked by policy”，本轮未绕过或操作 Station 实窗；脚本交付不等于 Codex 停止对话的实际验收。
