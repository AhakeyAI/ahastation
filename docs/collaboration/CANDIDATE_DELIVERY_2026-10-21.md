# AhaStation 协作候选版交付记录

版本：`0.19.0-collaboration.1`，Windows x64。本文记录可复核事实；实际第二台电脑、用户指定 GitHub 仓库和云端新版部署仍需正常登录和本机授权后验收。

**1. 工作现场与 Git**

全部增量位于 `C:\Users\79142\.codex\worktrees\collaboration-baseline-upload\station-ctrl`，分支为准确拼写的 `etrnal-dev`，HEAD 为 `b0cd16d1b7c4f9c91f9135ea163a7532ce1f2a1b`。原目录 `C:\aha\ahastation\station-ctrl` 的既有修改，包括用户的 `electron/main.ts`，没有被覆盖。需求和 ADR 的原有未跟踪文件保留。本轮未提交、未推送、未创建真实 GitHub PR、未合并、未正式发布。测试中的 PR 地址是受控接口夹具。

**2. 已实现的生产路径**

| 模块 | 实际行为 | 主要文件 |
| --- | --- | --- |
| M1a 账号、设备与连接 | 复用登录／恢复；稳定设备身份、系统加密凭证、注册重试、撤销和本机重新接入；检测与允许 Agent 分开；接收开关和全设备并发；同协议 HTTP/WSS、心跳、代次、退避、持久事件补拉 | `electron/collaboration/station-service.ts`、`connection.ts`、`network.ts`、`durable-state.ts`；`services/remote/device/collaboration_routes.py`、`collaboration_store.py` |
| M1b 项目与授权 | 共享逻辑项目、本机选目录／工作区、确认后克隆、GitHub 能力检查、每次执行前真实授权和准确基线校验；撤权停止受影响任务；普通目录和资料仓库分别授权 | `station-service.ts`、原有 `electron/collaboration/local-project-access.ts`、`workspaces.ts`、`git-files.ts` |
| M2 会议和交付 | 创建者固定协调；真实 Codex Host 统筹；计划批准与自动分配独立；持久接收后回执；新任务用内置 Guardian 和 Codex 运行时；独立 Git 工作区、提交、PR、交付重试；原有单机会话保留 | `coordinator.ts`、`execution.ts`、`native-helper.ts`、`github.ts`；`services/remote/device/station_codex.py` |
| M3 原生会话 | 授权目录发现和分页目录；仅同步选定正文及后续历史并标来源；保留原身份、cwd、模型和审批；通过同一常驻桌面网关串行接续；等待项取消、两向准确停止、共享审批竞态 | `station-service.ts`、`native-helper.ts`；`services/remote/device/station_native.py`、`codex_shared.py`、`codex_shared_service.py` |
| M4 恢复与集成 | 跨会议共享名额；未知退出不释放；原设备核对而不重投模型；补充编辑／忽略；返工和后继复验；集成候选验证通过后移动会议分支；最终 PR 交用户合并；关窗后台、退出／登出处理；非模型适配器全链路 | `station-service.ts`、`integration.ts`、`electron/main.ts`、`remote-control.ts` |
| 界面与安装闭包 | 设置、设备、项目授权、共享会议、计划、任务、审批、历史、成果和继续入口；Windows 内置冻结 Python 接收组件、依赖和 Codex 二进制，无需独立 Bridge | `src/components/CollaborationPanel.tsx`、`SettingsWindow.tsx`、`App.tsx`、`electron/bootstrap.ts`、`electron-builder.json`、`scripts/build-station-native.*` |
| 公共契约和部署 | TS/Python 协议2一致验证、严格拒绝未知／越权字段；新增四张 InnoDB 表、事务收据与事件、幂等、旧尝试隔离；源码导出白名单、权限及容器依赖 | `contracts/collaboration/v2.schema.json`、`production-validation.ts`、`services/remote/deploy/migrate.py`、`schema-v2.sql`、`services/remote/scripts/package_hub.py` |

**3. 本轮实际执行的自动验证**

证据目录：`runtime/collaboration-2026-10-21/`。使用 Node `C:\Program Files\nodejs\node.exe` v24.22.0，npm 11.19.1；Python `C:\aha\ahastation\pocket-vibe-agent\.venv\Scripts\python.exe` 3.13.5。没有照搬旧 macOS 路径。

| 验证 | 本轮结果和证据 |
| --- | --- |
| renderer + Electron 类型检查 | `npm.cmd run typecheck` 通过；`final-typecheck.log` |
| 正式前端和 Electron 构建 | `npm.cmd run build` 通过；`final-build.log`。Vite 保留大 chunk 提示，不影响构建退出码 |
| 完整 Node 基线 | 实跑 1034 项：995 通过、34 失败、5 跳过；`baseline-node.log` |
| 最终完整 Node 回归 | 实跑 1045 项：1006 通过、34 失败、5 跳过；`final-node-serial.log`。失败名称与基线完全一致，新增失败0；逐项列表及计数见 `baseline-comparison.json` |
| 新增协作 Node 场景 | 完整回归包含 11 项新测试，全通过：契约双语言一致、Host 计划格式／权限、落盘／损坏恢复和真实Windows文件占用、真实 HTTP/WSS 两接收服务、Git 传输和 PR 重试、独立进程崩溃恢复、冻结组件原生接续两向停止、过滤环境后执行／停止／查询记录目录一致 |
| Python 公共契约 | `python -m unittest discover -s collaboration_contracts/tests -v`（cwd=`services/remote`），4/4 通过；`python-contracts-final.log` |
| Hub 生产入口 | `python -m unittest discover -s services/remote/tests -p test_station_collaboration.py -v`，SQLite 8/8 通过；`hub-tests.log` |
| MySQL/InnoDB 生产入口和迁移 | `python scripts/rehearse-collaboration-mysql.py` 通过；真实 MySQL 8.4.13，从旧 schema1 升2保留账号、有效凭证、旧设备，再跑同8项 Hub及6项 Station测试；`mysql-portable/rehearsal-9f0b1e96-9841-4015-b593-c091e9d17ab4/RESULT.json` |
| 原生共享网关回归 | `python -m unittest discover -s services/remote/tests -p test_codex_shared.py -v`，33/33 通过；`native-regression.log`。真实 HTTP/WSS/RPC 和落盘，原生服务端由受控协议夹具代替，未声称当前用户桌面已验收 |
| 进程保护与退出证明 | `python -m unittest discover -s services/remote/tests -p test_station_codex_guardian.py -v`，7/7 通过；含中断 ACK 后未结束、仅清理本任务进程树；`guardian-tests.log` |
| Hub／探针源码包 | `python -m unittest discover -s services/remote/tests -p test_probe_package.py -v`，3/3 通过；`source-package-tests.log` |
| 真实 Codex 新任务 | 一个完整中文任务实际创建两文件、运行 Node 内容断言，确认受管进程退出；`real-codex-42edfd05-dbe9-41cb-bcb6-af04fdcc0be5/RESULT.json` |
| 真实 Codex Host | 实际模型生成两个完整、可通过公共契约的任务计划；`real-host-699f6783-57e4-48db-be54-aef7ce99a63c/RESULT.json`。会议快照是受控测试数据 |
| 真实 Host → 两 Station → Codex 交付 | 真实本机 HTTP/WSS Hub、Host模型生成计划、批准后自动分配，B模型交付完整两节文字，双方结果一致、接收和退出落盘；`real-two-stations-af23b697-3613-41a8-9e50-fbbbff57e58a/CONTENT-VALIDATION.json`。Electron API和安全存储在该服务测试中使用夹具；安全存储另有真实进程测试 |
| Windows 系统加密跨进程 | `node scripts/check-station-secure-restart.mjs`，连续三个真实 Electron 进程解密已保存凭证成功，磁盘无明文；`secure-restart.log` |

完整 Node 命令是在已经完成构建的稳定目录执行，未与清理 `dist-electron` 并行：

```powershell
$env:COLLABORATION_PYTHON='C:\aha\ahastation\pocket-vibe-agent\.venv\Scripts\python.exe'
$env:POCKET_VIBE_TEST_PYTHON=$env:COLLABORATION_PYTHON
$loader="data:text/javascript,import { register } from 'node:module'; import { pathToFileURL } from 'node:url'; register('./tests/electron-stub.mjs', pathToFileURL('./'));"
& 'C:\Program Files\nodejs\node.exe' --test --test-concurrency=1 --test-timeout=120000 --import $loader tests/*.test.mjs
& 'C:\Program Files\nodejs\node.exe' scripts/compare-collaboration-regression.mjs final-node-serial.log
```

历史失败主要为当前 Windows 环境的观察器平台夹具、Kimi/Qoder 路径／进程及文件监听权限场景；未通过跳过或扩范围修改隐藏。中间一次负载较高的回归额外出现旧任务预算测试超时，单独7/7通过；另一次并行测试中原生夹具本地连接中断，执行前检查拒绝接续，单独完整场景通过。最终在稳定源码上串行运行全部1045项，保留原34项失败。一次构建清理目录与测试重叠的无效日志不作为验收证据。中间失败和排错记录全部保留。

真实模型证据的边界：早期一次仅返回“待批准计划”的结果已作废。上述af23运行实际交付了两个标题、每节四条操作和准确末行；原断言额外要求350字而误判，原失败报告保留，由 `scripts/verify-real-delivery-evidence.mjs` 离线逐项复核已持久化的双方快照及接收记录，另存 `CONTENT-VALIDATION.json`。随后一次新模型请求原生返回HTTP429，本轮没有继续重试；最后加入的执行记录目录隔离修复，用真实冻结运行时的非模型命令／停止／查询测试验证，未宣称在429之后又完成最终版本的真实模型复跑。生成的文字仅是测试内容，不作为产品使用说明发布。

**4. Windows 构建与安装验证**

最终候选目录为 `C:\Users\79142\.codex\worktrees\collaboration-baseline-upload\station-ctrl\release\collaboration-candidate\`。

| 产物／检查 | 实际结果 |
| --- | --- |
| 安装包 | `AhaStation Setup 0.19.0-collaboration.1.exe`，NSIS，Windows x64，470153451字节，构建退出码0；`final-package.log` |
| SHA256 | `E045574F949C25D435A41515A9B7F167D97D68F2B10901734C65737352C6379B` |
| 签名 | 安装包和主程序的 `Get-AuthenticodeSignature` 均为 `NotSigned`。构建日志中的signtool行不能作为已签名证据；见 `installer-manifest.json` |
| 包内核验 | 编译输出及源文件清单匹配，两个版本契约齐备；内置冻结接收组件实跑self-test为协议2／Python3.13.5／AMD64，内置Codex实跑版本0.144.1；15384个ASAR条目，未混入本机runtime和测试凭证 |
| 包内应用启动与恢复 | 两个真实Windows应用进程、独立配置、实际系统加密凭证；同一真实本机HTTP/WSS Hub注册／同步，重启后设备ID保留、凭证可解密、连接代次前进，页面加载完成；`gui-07fc939e-8b39-4d84-9ae0-f10d8a263ac4/RESULT.json` |
| 实际安装包的内容 | 用7za从最终NSIS内提取实际负载至隔离目录，再次校验源码／冻结组件／Codex运行时，并实跑两个应用的注册、页面加载、WSS及身份／凭证重启恢复，全部通过；`gui-fd12ef02-9a98-4e6d-9480-05ef5913036a/RESULT.json`、`installer-payload-smoke.log` |

以上自动进程由专用Windows Job管理并已结束；没有覆盖现有安装、没有运行安装向导写入用户注册表／快捷方式，也没有改动原AhaStation配置（原配置文件修改时间仍为2026-10-14）。安装向导和真实第二台电脑由用户后续现场操作。没有测试Linux/macOS安装包，只有兼容代码和CI构建结构。

**5. 云端状态、迁移和部署**

现有地址 `https://ahastation-hub-220629-6-1398334410.sh.run.tcloudbase.com` 可继续复用。本轮只读检查 `/health`、`/ready` 均为200；新 `/api/collaboration/v2/snapshot` 为404，当前云端仍是旧 Hub。`prod` 是历史部署标签，不是技术禁用条件。当前没有正常登录的云控制台部署会话，未升级云端、未改变原数据库、未做云端故障实验。

交付前19:44复查曾出现两次20秒超时及一次503；19:45只读复查health／ready恢复200，19:46新快照路由仍404。保留 `cloud-readonly-check.json` 和三份recheck证据。原因不能仅凭公网响应判定，需在控制台核对实例、常驻配置和日志；本轮没有通过生产重启来试验。

部署说明为 `services/remote/docs/WEIXIN_CLOUD_DEPLOY.md`。在确认可部署的测试服务上，先备份原库和密钥配置，再用本库迁移权限运行 `python deploy/migrate.py migrate`，随后 `python deploy/migrate.py check`。新增四张 `collab_*` 表和schema2，保留原表。应用使用本库受限账号，数据库密码及 `HUB_SECRET` 只在云端。`schema-v2.sql` 用于审查或空库，不对已有库整份重放，不清库。

沿用**单实例、单 worker、单版本100%流量**，不能只因为持久化了 MySQL 就扩容。端口8787，常驻；健康和就绪分别检查。上传导出包后验证未认证新路由401、登录后的快照／事件／WSS心跳与重连、旧 Bridge兼容。发布重启和重复投递已经在本机服务及 MySQL 演练；云端须在明确测试数据上重做。schema2 不能通过改版本号回退给只支持schema1的旧 Hub。

Hub部署包为候选目录的 `deployment/ahastation-hub-source.zip`，包含28个清单文件，SHA256为 `91cf6a5329c038a6f42e75890de58c24fb8dd132f0d6564f9408949e131a1194`；WSS探针包为同目录的 `ahastation-wss-probe-source.zip`。导出使用当前未提交及必要未跟踪源码，包含合同、迁移、依赖和根Dockerfile，普通源码0644；逐文件SHA256、权限、排除项及解压后生产新路由导入均通过，见 `deployment-verification.json`。本机没有Docker，未声称已构建或运行容器。

完整Station源码包为候选目录的 `source/ahastation-collaboration-source.zip`，包含当前工作树的必要跟踪文件和未跟踪实现，附 `CANDIDATE-SOURCE-MANIFEST.json`，不含Git历史、依赖、运行数据、真实凭证和编译二进制。候选目录内 `CHECKSUMS.json` 记录安装包、源码包、部署包和交付报告的实际哈希；`verification/` 收录可移交的验证摘要。完整本机原始测试日志仍在前述runtime证据目录。

从完整 Station 源码包重新构建时，在 Windows 安装 Node、Git 和 Python 3.13，运行 `npm.cmd ci`；用单独 Python venv 安装 `services/remote/requirements-station-native.txt`，把 `AHASTATION_BUILD_PYTHON` 指向该 venv 的 Python，再执行 `npm.cmd run dist:win`。内置组件由构建机冻结生成，安装使用者无需另装 Python。Hub 的 MySQL／FastAPI 依赖来自独立的 `requirements-public.txt`，不需要把云端数据库凭证配置到 Station 构建机。

**6. 另一台 Windows 电脑的操作**

1. 待测试 Hub 升级就绪后，两台电脑安装同一候选版；在设置的远端协作入口填写该 Hub 的实际 HTTPS 地址，使用同一个协作账号正常登录。
2. 各自准备并登录 Codex，在“同账号设备协作”检查设备注册、Agent检测与本机允许范围；再开放接收，按需设置设备名称和全设备任务并发。
3. 为用户指定的同一个 GitHub 项目选择各自本机副本／克隆位置和独立任务工作区，完成 GitHub 正常登录及本机授权。纯文字无需仓库；普通研究目录另选目录，文件传递再绑定资料仓库。
4. A 打开共享会议，选 B 成为成员；输入完整目标，查看 Host 计划并批准，选择手动分配或自动分配；双方查看同一进度、审批和成果。最终 PR 先审阅，用户自行决定合并。
5. 接续已有 Codex 会话时，B 先保存工作并自行退出当前未联动的 Codex 桌面，再从 Station 的“启动 Codex 联动桌面”进入；在B授权目录后刷新并选择原会话加入会议。完全访问需B本机确认。
6. 验证忙时等待、两向停止、停止后的补充核对和明确继续；关闭会议界面／主窗应后台继续，完全退出按停止核对流程处理。

**7. T01—T28 验收矩阵**

“自动”表示相应实现路径的可执行测试通过；“本机服务”表示真实 Hub HTTP/WSS／数据库／进程链路。以下没有把受控原生协议夹具写成真实 Codex Desktop、实际 GitHub 或真实双机验收。

| 用例 | 本轮已验证部分 | 仍需现场验收 |
| --- | --- | --- |
| T01 | 两个包内实际应用和NSIS提取负载：页面加载、注册、默认不接收、加密凭证重启；冻结组件资源核验 | 正常账号登录、安装向导、第二台安装和缺组件引导 |
| T02 | 本机两 Station 服务共享会议／唯一协调者 | 两个实际界面发言、B不抢前台 |
| T03 | 本机真实接收及非模型双文件交付；真实 Codex 双文件执行 | 用户项目的完整交付 |
| T04 | 自动：计划批准与自动分配分离、合格成员筛选；真实Host→批准→自动分配→B模型正文交付的记录复核通过 | 真实双机自动分配；429之后的最终版本真实模型复跑 |
| T05 | 自动：两设备不同路径、真实本机授权核验 | 两个实际项目副本 |
| T06 | 自动＋真实 Git 传输：准确SHA／选定二进制文件、未推送不报共享 | 用户资料仓库权限 |
| T07 | 真实 Git 分支／提交／取文件；PR接口受控夹具 | 实际指定 GitHub 仓库创建和取回PR成果 |
| T08 | 自动：交付重试、复用PR、合并后返工建新PR，不重跑模型 | 实际GitHub网络／权限失败后的恢复 |
| T09 | 自动＋真实Git：独立工作区、物理目录隔离 | 真实双机并发 |
| T10 | 受控原生RPC：原身份／配置、授权目录、选定历史和来源 | 用户实际原生桌面对话接续 |
| T11 | 冻结组件＋真实网关：忙时排队，真实退出证据后接续 | 当前版本Codex Desktop现场 |
| T12 | 冻结组件全链路：取消等待不影响桌面当前轮次，不占名额 | 两界面的等待／停止展示 |
| T13 | 冻结组件全链路：Station停原生、原生桌面停Station，准确轮次 | 实际Desktop双向操作 |
| T14 | 自动：ACK非退出证明、未知占位、旧事件／尝试隔离 | 用户真实工具子进程故障 |
| T15 | 自动：补充持久化、编辑／忽略、继续、附件授权 | 两端交互体验 |
| T16 | 自动：单会话单会议、换关联前停止核对 | 两界面切换关联 |
| T17 | 自动＋生产授权：越界／提权拒绝、撤权停止、重新授权 | B本机授权及完全访问确认 |
| T18 | 自动：同请求一次有效决定、桌面／Station审批竞态与迟到决定 | 实际工具审批和原生入口 |
| T19 | 本机服务：协调者离线，新工作等待；已接工作和停止保留 | 实际断网两机 |
| T20 | 本机服务＋独立接收进程：Hub重启、B崩溃、凭证失效／续接无重跑 | 真实第二机重启和网络 |
| T21 | 自动：生命周期、退出／登出停止和后台结构；保留原有启动回归 | 主窗、会议标签、托盘和完全退出的界面操作 |
| T22 | 真实Git集成候选和验证失败回退；后继复验／旧证据测试 | 用户实际项目组合验证及最终PR审阅 |
| T23 | 自动：纯文字无仓库、普通目录授权与资料传输接口 | 用户研究文件的范围确认和资料PR |
| T24 | 本机真实服务：非模型适配器接收、事件、双文件结果、停止、进程恢复 | 已完成自动范围 |
| T25 | 最终1045项无新增失败；34项既有失败逐名保留 | 原有模型／用户会话的人工冒烟 |
| T26 | 本机HTTP/WSS＋MySQL双Station服务；最终安装负载的两个实际应用和配置／身份／加密凭证重启恢复 | 新版公网Hub和实际双机 |
| T27 | 本机真实Hub重启和事件补拉、MySQL持久化、回执丢失／去重 | 测试云端发布重启 |
| T28 | 自动：账号隔离、代次、旧绑定／撤权、严格协议／大小限制 | 云入口TLS、Authorization和WSS透传 |

**8. 最后需要人的事项与完成边界**

本机可执行的源码改造、离线／非模型回归、数据库迁移演练、安装包构建、实际安装负载启动及生产HTTP/WSS本地联调已完成。仍不能声称全部现场验收完成：需要正常云控制台登录并明确测试服务，用户指定仓库的正常GitHub授权，以及第二台电脑的安装／登录／本机授权和实际Codex桌面接续。后续完整真实模型复跑需等本机Codex服务的429限制解除，不能用非模型测试代替这一项。现有Hub若实际允许作为测试服务升级，可以沿用；如果它承载正在使用的生产业务，应选隔离测试服务。本任务不包含正式生产发布。不要提供MySQL root、完整模型登录文件或GitHub凭证。

本轮 Windows 界面自动操作被用户物理 Esc 停止，随后未继续窗口操作；尚未完成的视觉／点击验收保留为人工项。自动启动与网络测试通过日志和实际状态另记，不能替代视觉验收。

界面操作使用了 [computer-use 技能](C:/Users/79142/.codex/plugins/cache/openai-bundled/computer-use/26.1013.40934/skills/computer-use/SKILL.md)。其引用的 `docs/guidance.md` 要求：“If Computer Use reports that the turn ended or that the user stopped Computer Use, stop issuing app input.” 本轮因此停止了窗口输入，没有绕过 Esc 继续点击；命令行构建、隔离服务测试和文件核验继续完成。
