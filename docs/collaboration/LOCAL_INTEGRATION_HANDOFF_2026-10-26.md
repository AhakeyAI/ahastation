# etrnal-dev 本地整合交接

本轮只在实施 worktree 完成本地源码、提交整理和隔离验收。未推送、创建真实 PR、移动本地 main、生产部署、连接公网 Hub、调用模型或写用户原 Codex 对话。既有 .5/.6/.7 冻结包不覆盖；它们不包含本次 K01 修复，不能据此宣称可发布。源码版本保留 0.19.0-collaboration.7，以本地提交和构建清单区分。

## 来源与恢复点

| 项目 | 准确来源 |
| --- | --- |
| 原 etrnal-dev | 5f76c3a396daec014727b4f55fd588eb5a094f0d |
| 共同基点 | c134de22efed4fbf17bb5af1c727f6f7c36a15f6 |
| 获取后的 origin/main / PR47 | c8295b91210ccd261aa4a7a2dc5ee1eabc096491 |
| .6/.7 源码 checkpoint（明确 K01 未通过） | c2b6f1800cae571b1e4b65fb1c7c424f0ccd46a5 |
| 隔离 rebase 验证 | 2bb3f687271f103a6354a59f43b6b79f6d354149 |
| 实施目录 rebase 后 | 471c0e7aef1d296001429374dc3b10b8af3fa8fd（与隔离结果 tree 一致） |

本机恢复引用前缀 `refs/backups/etrnal-integration-2026-10-26/`：original、source-checkpoint、rehearsal、final-source。最终六单元 SHA、文件树证明及运行结果见本机证据目录 `runtime/etrnal-integration-2026-10-26/FINAL-REVIEW-UNITS.json` 和 TEST-RESULTS.json。原三个快照仍由备份引用和 bundle 可达，未删除历史。

证据目录另存二进制 patch、包含未跟踪源码的 ZIP、逐文件哈希、原始/checkpoint bundle、失败和通过日志。原 ROOT_CAUSE_AUDIT_2026-10-26.txt 原样保留、未提交；运行目录及私有凭据不进 Git。原主工作区 `C:/aha/ahastation/station-ctrl` 文件及其本地 main 未改。

rebase 无文本冲突。新 checkout 因系统 core.autocrlf=true 留下 18 个纯换行差异的夹具，验证后恢复 HEAD 原始字节，未改全局配置或夹具 Git blob。PR47 六个文件逐项保留：夹具、Windows Kimi、Qoder watcher、CI 上传条件与主构建保留 7 天；collaboration 的 Python3.13/native 构建仍在。

## 六个评审单元

| 顺序 | 范围与配套 | 依赖 | 验证入口 |
| --- | --- | --- | --- |
| a 契约 | v1/v2 schema、用例、校验器、公共类型、GLOSSARY、ADR、完成证据语义 | main；Node 验证依赖由 e 提供 | contracts Python unittest、collaboration-contracts.test.mjs |
| b Hub | Hub/Bridge 兼容源码、鉴权、持久化、生产路由、HTTP 测试、部署 | a | remote unittest、MySQL 演练 |
| c Station/接收组件 | 执行/恢复/发布门禁、Host、Git、后端/IPC/主进程接线及对应回归 | a、b；验证工具 e | K01、station/native/hardening/review suites、Electron typecheck |
| d 界面 | 统一会议投影/操作、RPC 详情及浏览器回归 | a、c | renderer typecheck、实际 React 测试 |
| e 构建/CI/脚本 | 锁文件、固定 Playwright、native/载荷检查、串行运行器、原缺陷探针 | a–d | npm ci、typecheck、build、test:collaboration、npm test |
| f 文档 | 既有需求/历史报告、当前交接、冲突和证据索引 | a–e | diff 检查、整理前后 tree 对照 |

这是有依赖的评审组，不声称每个中间提交可独立打包。类型及必要测试随功能提交，没有第二套协议。ADR0001–0012 原号保留，0013–0016 从 C0 原文同步；本次无需新增 ADR，下一个编号仍为 0017。

[Q/D 冲突表](INTEGRATION_CONFLICTS_2026-10-26.md) 列出双方原文、代码影响和建议，待负责人裁决。未自行合入 C0 的加密、布局、项目落盘或新批准规则；安全升级及版本区间仍属其原分支的未完成前置工作。

## K01 / K02

K01 根因：门禁允许缺失 outcome，执行、恢复和上报又用退出/ok 默认补成 completed。现复用 TurnOutcome、本机 journal、authorizeDelivery、原收据/错误/重试和 Hub task.event，原 attempt 的明确正常完成与实际退出分别成立才允许新增发布。选定文件创建提交前也核验；停止后不启动新增发布或验证。没有新队列、全局锁、数据库字段或第二套成果身份。

删除了三处“ok/退出即 completed”推断、最终上报的 completed 默认值及缺字段门禁放行。executionOutcome 供适配器和恢复共用；FileTest 和直接 Codex 在真正正常结束时明确报告。恢复核对 executionId，保留原正文/文件/错误；缺失或损坏证据不重跑模型。Hub 与 Station 均需同步更新；本次没有新增数据库迁移，既有合法交付/验收历史不重写。

正式 K01 测试用本机 bare 仓库、强制转入该仓库的 Git 传输和 PR 计数夹具。隔离旧源码确认 executed/delivery-pending 缺 outcome 各新增 1 commit、1 push、1 PR，并伪报 completed；修复后各为 0，模型执行为 0，原文件/输出保留。覆盖异常 outcome、反复轮询/重载/重试、缺失/损坏/错 attempt 的 journal、停止交错、正常完成幂等、仓库/文字/选定文件入口。原缺陷脚本及旧 RESULT 保留，退出 0 不算产品通过。

K02 复用 .7 RPC 诊断并补 executionId；保存脱敏 method/code/message/stage、原 thread/turn，任务详情关联 task/attempt。过滤凭据，限制消息长度，不记录请求全文。真实本机守护进程＋模拟 RPC 覆盖拒绝、连续显式接续、重复请求不重试、结果重开与脱敏。**历史现场根因未确认**：没有当时执行电脑原始日志，不能把日志增强通过写成真实现场接续已修复。

停止/越界否决回归保留：停止先于执行/验证不启动子命令，停止与正常完成交错保持事实，停止后新发布为零，越界图片与目录/工作区访问被拒绝。相关任务阻塞不扩散至独立任务和会议。

## 最短复现

实测 Node24.22.0（C:/Program Files/nodejs/node.exe）、Git2.56.0.windows.2、Python3.13.5。本轮在 runtime 新建验证 venv，按两份 requirements 安装；隔离 worktree 独立 npm ci/Electron 安装，不共享源码/dist。新机器在干净 Windows x64 checkout 执行：

```powershell
npm ci
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r services/remote/requirements-public.txt -r services/remote/requirements-station-native.txt
$env:COLLABORATION_PYTHON=(Resolve-Path .venv/Scripts/python.exe).Path
$env:POCKET_VIBE_TEST_PYTHON=$env:COLLABORATION_PYTHON
$env:PYTHONUTF8='1'
npx playwright install chromium
# 可选：$env:STATION_CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe'
npm run typecheck
npm run build
npm run test:collaboration
npm test
git diff --check
```

未设 STATION_CHROME 时使用 Playwright Chromium；无需维护者缓存路径。测试自建临时 profile/账号/密钥/工作区及 127.0.0.1 HTTP/WSS，不要填公网连接。test:collaboration 重建 native 并 self-test；构建和读取同一 dist 的测试串行运行。文件并发为1，单条断言超时未放宽；专用命令总预算适配串行执行。最终通过/失败/跳过/未执行及旧失败逐项对照，见本机 TEST-RESULTS.json / baseline-comparison.json；首轮失败日志不覆盖。

本机真实 Hub/MySQL5.7：复用现有演练工具，将 mysql-base 替换为本机官方 MySQL5.7 发行目录：

```powershell
.venv/Scripts/python.exe scripts/rehearse-collaboration-mysql.py --mysql-base 'D:/tools/mysql-5.7.18-winx64' --output runtime/local-mysql57
```

工具只在新 UUID datadir 初始化自有实例，核对真实 datadir，绑定127.0.0.1/随机端口，独立 station_fixture_* 数据库、非 root 应用账号和随机密钥。迁移保留旧身份/设备，再走生产鉴权、协议能力、HTTP/WSS 和两个独立 Station profile，不只是 health。结束只关闭自有实例，数据及私有连接文件保留在忽略的 runtime，不读取生产连接文件。

Docker CLI 不可用，Docker 未验证。现 Compose 只有 Hub、需外置 MySQL，源码 services/remote 上下文缺根 contracts；不能直接当成完整部署包。可复用既有 Hub 导出工具补齐部署上下文后再核对 Dockerfile；本轮不以未执行 Compose 冒充通过。

## 现场限制

BLOCKED：真实双机、公网/微信云托管、真实 GitHub 写入/PR、原 Desktop 对话、付费模型和在线语音。需要现场环境/原始日志及负责人裁决。本地通过不代表公开发布，也不代表独立安全前置分支已合入。
