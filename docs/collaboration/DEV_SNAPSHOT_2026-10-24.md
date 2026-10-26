# collaboration.5 开发快照（2026-10-24）

目标仓库：`ShawnyinsGit/ahastation-internal`，分支 `etrnal-dev`。基于 `b0cd16d1b7c4f9c91f9135ea163a7532ce1f2a1b` 的四项公共契约基线，纳入此前未提交的统一会议、多设备接入、Hub、内置接收组件、测试、构建与文档。代码版本仍为 `0.19.0-collaboration.5`；本次是开发快照，不修复下述已知问题，不生成新安装器，不表示正式发布或全部验收完成。

## 当前代码与阅读顺序

1. [需求与最终确认](FIRST_RELEASE_SPEC.md)、[实施方案](UNIFIED_MEETING_IMPLEMENTATION.md)、[术语](../../GLOSSARY.md)。
2. [使用流程](UNIFIED_MEETING_USER_GUIDE.md)：同账号设备、统一会议、Host 计划、明确批准、固定设备与 Agent 执行、消息／成果同步。标题中的 .2 是该说明最初编写版本，后续边界以本页与最新独立审查为准。
3. [collaboration.5 独立复审](REVIEW_COLLABORATION_5_2026-10-23.md)：最新可执行审查结论优先于之前交付报告的“完成”描述。
4. [本版原交付报告](COLLABORATION_5_FIX_REPORT_2026-10-23.md) 与 [证据索引](COLLABORATION_5_H01_H14_S01_S18_EVIDENCE.md)：历史运行范围和安装包验证；其中的绝对路径只描述原验证机器。
5. [Hub 升级说明](../../services/remote/docs/COLLABORATION_5_UPGRADE.md)、[MySQL5.7 说明](MYSQL57_HUB_UPGRADE.md)。

实现涉及 `src` 的统一界面、`electron/collaboration` 的持久接入／编排／执行、`services/remote` 的 Hub 与内置接收程序，以及 v2 协议、回归和本机打包脚本。旧 Pocket Vibe 适配器及原生共享基础按既定过渡保留。其他 Agent 原本机功能仍保留；跨设备新任务与会议讨论首版以 Codex 为核心，不能将其他 Agent 的安装／登录状态当成跨设备执行已适配。

## 已知问题：本快照明确保留

### K01 / P1：缺少 turnOutcome 的旧任务可能未经核对自动发布

旧记录 `status=executed, exitConfirmed=true` 若缺少 `turnOutcome`，`authorizeDelivery` 仍可能放行，交付又将缺值补为 `completed`。独立临时真实 Git 反例证明会新建提交、推送并调用 PR 接口夹具；显式 `unknown` 的对照则不会发布。问题位于当前源码及原 .5 安装包，尚未修复。

临时测试边界：使用独立 Station 配置、没有历史待交付任务的测试账号和纯文字会议；不要用本快照恢复真实旧任务并自动发布仓库成果。不要以删除数据库／凭据、批量清任务或默认补成 completed 绕过。修复需从准确原 attempt 的 journal／轮次结果恢复证据，并覆盖旧 executed / delivery-pending、重启和零新增副作用。

可复现脚本位于 `scripts/review/reproduce-legacy-outcome.mjs`。它使用临时本机仓库、指向本机 bare 仓库的传输及 PR 计数夹具，无真实 GitHub 写入或模型调用。**脚本退出 0 表示缺陷反例成立，不是正确行为测试通过**；不要加入正常全绿回归计数。

### K02 / 待定位：远端专家讨论的 thread/resume 被拒绝

2026-10-24 用户双机会议中，首次点名远端 Codex 正常完成，断线恢复后再次点名出现 `Codex rejected thread/resume; task records and files were preserved`。会议显示实时在线，失败发生于恢复该成员原讨论线程，而非服务器基础连通或正式任务分配。该次新消息尚未进入新的模型轮次。

Station 持久保存并复用专家讨论线程；接收组件 `Guardian.call` 目前把原生 RPC 错误统一缩减为上述文本，具体拒绝原因未保留在会议提示中。尚不能确定为线程缺失、占用或配置变化；需要执行电脑原日志／脱敏原始 RPC 原因及第二次连续点名、断网／进程重启的回归。不要将重建会议后首次调用成功当作接续修复，也不自动丢弃旧上下文或盲重跑未知执行。

### K03：34 项既有 Node 失败和 5 项跳过仍未关闭

最近完整 .5 回归为 **1118 项：1079 通过、34 失败、5 跳过**，不是全仓通过。报告比对确认与该轮修改前基线的失败名称／错误码／断言原因一致。已核实一批原因是 CRLF 夹具与 POSIX 行解析不兼容、Kimi 测试在 JSON 文本中直接替换 Windows 路径；Qoder 符号链接及文件监听还报 EPERM。不能未经核验将全部错误归为权限问题，也不能据“新增失败 0”宣称所有原功能无影响。

真实物理双机／公网链路仍在现场验证，K02 已证明持续讨论接续存在未通过场景；真实 GitHub PR、用户 Codex Desktop 连续接续、音频／屏幕及其他平台尚未整体完成。历史本机多服务、真实模型单次调用和模拟 PR 不替代这些验收。原 .5 Windows 安装器未签名，原报告未构建运行 Docker 镜像。

## 干净克隆后的开发准备（Windows PowerShell）

需要 Git、Node.js 22+；原验证采用 Node 24.22.0 和 Python 3.13.5。Python 仅开发／构建内置组件需要；安装包用户无需单独安装 Python。

```powershell
git clone --branch etrnal-dev https://github.com/ShawnyinsGit/ahastation-internal.git
cd ahastation-internal
npm.cmd ci
python -m venv services/remote/.venv
& services/remote/.venv/Scripts/python.exe -m pip install -r services/remote/requirements-public.txt -r services/remote/requirements-station-native.txt
$env:AHASTATION_BUILD_PYTHON = (Resolve-Path services/remote/.venv/Scripts/python.exe).Path
$env:COLLABORATION_PYTHON = $env:AHASTATION_BUILD_PYTHON
$env:POCKET_VIBE_TEST_PYTHON = $env:AHASTATION_BUILD_PYTHON
$env:COLLABORATION_TEST_MYSQL_FILE = ''
npm.cmd run prebuild:native
npm.cmd run typecheck
npm.cmd run build
```

开发热更新依次在两个终端运行 `npm.cmd run dev`、`npm.cmd run dev:electron`；需要真实模型的操作使用各自本机已有登录。不要把私有配置复制进仓库。UI 浏览器测试另需本机 Chrome / Playwright，使用 `STATION_CHROME` 和 `STATION_PLAYWRIGHT_MODULE` 指向自己的安装，原机器缓存路径不具有通用性。

隔离协议回归入口是 `npm.cmd run test:collaboration`，需上述 Python 依赖和 UI 测试运行时。该聚合脚本并不代替完整 `npm.cmd test`；Host outcome 和 identity 等新测试也包含在全量 `tests/*.test.mjs` 中。完整测试仍预期暴露 K03，不通过删用例或强制退出伪造成功。

复现 K01 的独立命令：

```powershell
node --import "data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));" scripts/review/reproduce-legacy-outcome.mjs
```

## 服务与数据范围

`resources/remote-service.json` 保留已经使用的公开 HTTPS 服务地址，属于客户端配置，不是数据库凭据；克隆源码不会自动登录或授权设备。进行新的协作测试应使用专用测试账号。Station／Agent／GitHub 登录分别保留在各电脑。

Station .5 要求匹配 Hub 的 `unified-hardening-v1` 能力。仅 `/health`、`/ready` 正常不能证明版本匹配；旧 Hub 缺新增接口时，客户端还可能将具体校验原因覆盖为“连接中断，正在核对原任务”。应核对实际线上版本和流量，而不是重新建库或重配 Codex。

沿用 MySQL5.7、`station_hub`、原密钥与账号。已有 schema=2 在本版无新增 DDL；schema=1 的既有升级步骤仅在核对、备份后由维护者操作。Git 推送不会部署 Hub、执行迁移或改变当前云服务。源码内不提交任何真实数据库密码或 HUB_SECRET。

## 本次快照检查与提交范围

本次仅配置仓库本地提交作者、审查与扫描待提交源码、补快照入口及已知问题、运行构建／定向回归，并提交开发快照。原产品实现保持本次开始时的状态，原工作目录和冻结安装包保留；不会为上传顺手修 K01／K02。

本次提交前重新执行结果：

| 检查 | 结果 |
| --- | --- |
| Renderer + Electron 类型检查 | `npm.cmd run typecheck` 通过 |
| 正式源码构建 | `npm.cmd run build` 通过；保留 Vite 大 chunk 提示 |
| hardening 六套，加 review-fixes / stability / unified / 实际 React UI 定向回归 | 73/73 通过，退出 0 |
| Hub `test_collaboration_hardening.py` | 15/15 通过，退出 0；含继承用例，不重复累计覆盖数 |
| 全量 1118 项、MySQL 演练、真实模型、安装包／Docker／生产部署 | 本次未重跑；上述历史记录和 K01–K03 不因定向通过而关闭 |

测试使用独立配置、临时目录和本机 HTTP/WSS 服务，不调用真实模型、不访问生产数据库、不创建真实 GitHub PR、不操作用户 Station 或 Codex 进程。原始本机日志、完整进程输出、敏感扫描副本和安装器均不进源码提交；提供可复现命令与脱敏结论。提交范围包括必要源码、公开协议、测试、构建／部署材料与需求／审查文档，排除依赖、编译目录、发行包、运行状态和凭据。

扫描使用从 Gitleaks 官方发布下载并核验 SHA256 的 8.30.1，开启完整脱敏。首轮发现三处旧 LAN 文档的 `change-me` 示例令牌，确认为占位符而非实际凭据，改为环境变量引用后再扫描。测试中刻意用于隔离／脱敏断言的假凭据保留，公开服务地址保留；不将它们当作真实账号资料分发。最终对完整候选源码和确切暂存内容分别复扫，通过后才提交；具体文件数量和提交号以 Git 提交记录为准。
