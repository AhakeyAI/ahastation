# 本轮验收记录（2026-10-10）

实现不是云端发布。本机仅Windows和WSL Ubuntu；无Docker/云账号操作条件/第二台跨网电脑/真实macOS。下表随最终本机运行结果更新，未运行项保持待验收。

| 类别 | 当前证据/边界 |
|---|---|
| 起始Station全量 | 本轮实跑905项：860通过、40失败、5跳过；需最终逐项比较失败名称，非历史904数字替代 |
| 起始Python全量 | 51项：36通过、1失败、14跳过；故障注入 native creation exception 清理确认失败，单独复跑通过，完整最终仍需核对 |
| 公网协议 | `test_public_remote.py` 7项真实回环HTTP/WS+现有文件扫描器+Windows/WSL测试进程通过；包含撤销握手/数据库故障不取消和目录队列状态。Station新增4项覆盖安全存储、两轮、恢复、实际公网协议回环和取消；显式注入SQLite只作协议自动化，不代表生产MySQL |
| 进程监管 | Windows全量63：46通过、17平台/MySQL跳过；WSL Python3.13.16全量63：48通过、15平台/MySQL跳过。包括原子Job、逃离SID/doublefork、崩溃/复用身份、未确认阻断、真实取消；只操作临时目录测试进程。起始单个故障注入失败在单独和最终全量复跑均通过，不为全绿改无关监管规则 |
| Windows冻结包 | PyInstaller onedir原生构建、Tcl8.6.15/冻结自检、Job实际能力probe通过；冻结Codex适配器用OS内置测试CLI验证native ID/权限/cwd和文本，打包监管使用自身runtime验证正常任务、取消及后续会话任务。测试任务不依赖系统Python；普通GUI/托盘仍待人工 |
| Station人工GUI/托盘/自动启动 | 待人工；当前未操作用户桌面或修改真实登录启动项 |
| 麦克风 | 待真实声音输入；语音生产逻辑自动化不等于麦克风验收 |
| 原生macOS/Linux/ARM64 | 待原生实机；macOS测试脚本既有、构建入口新增，WSL不是原生Linux桌面/ARM64；不把模拟darwin称为macOS通过 |
| 真实Codex/Claude | 当前Codex0.162.0-alpha.2登录ChatGPT；仅一次新临时项目/会话bootstrap，生产适配器返回“Could not create README.md: local tools failed during sandbox setup. The sandbox must be repaired before retrying.”，CLI exit0且cleanup_confirmed，但未产生请求文件，所以不算真实两轮/停止完成。未提升权限/修改登录/重复付费调用；先前0.160两轮只是历史证据。Station捆绑Claude CLI独立auth status未登录，不自动登录 |
| 两电脑跨公网 | 待两台设备不同网络；回环不是LAN/跨公网验收 |
| 微信云托管/普通桌面WSS/正式域名 | 探针和源码ZIP已设计，需实际上传云端构建、入口限额/域名有效期/重启重连/HTTPS自定义域名验收；本轮未云端发布 |
| MySQL生产/迁移/备份恢复 | 提供显式v1 DDL/迁移check及独立原生数据库测试；本机无DB服务，注入SQLite不等价MySQL，待专用MySQL实跑及平台恢复演练 |

## 可执行验收

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe scripts/build_bridge.py --output runtime/packages
.\.venv\Scripts\python.exe scripts/frozen_smoke.py --exe 解压包路径/AhaStationBridge.exe
.\.venv\Scripts\python.exe scripts/package_hub.py --output runtime/deploy
```

macOS原生：安装Python/Tk和 `requirements-bridge.txt`，运行全套tests，重点 `test_macos_native.py`（无目标、固定原生ID/两轮、跨Bridge串行、遗留后代、超时/setsid/doublefork、提前退出/guardian崩溃/创建元数据窗口、身份复用与未确认阻断），再构建`.app`验证冻结监管、签名/公证和CLI恢复实际权限。不通过能力探测时GUI不可宣传可执行。

WindowsGUI：打开独立产品→配对/根授权/CLI认证→关窗托盘→选择用户启动并注销再登录→短断网→删除授权根/符号链接边界→解绑，核对配置与任务状态；Station设置注册保存恢复码、加电脑、双成员两轮、切换标签和重启快照、明确远端失败无本机执行、文本附件拒绝、语音唯一/重名/普通email。麦克风用真实标题空格/下划线/连字符/大小写差异及多个候选并观察实际成员输入。

真实执行器仅新建隔离项目和新原生测试会话（不要用户历史），配置本机workspace-write不提升权限，连续两轮修改并读取结果，再发慢任务停止观察实际文件不再变化；未确认不能开始下一轮。Claude未登录只记录缺认证。跨网络两电脑/微信云托管依探针文档核验，留存版本、时间、错误类型和去敏截图，不记录凭证。

部署源码清单/哈希、实际完整测试结果与待验收更新在本轮交付结束填写。

## 最终本机记录

- Station renderer和Electron typecheck退出0；两端构建通过（Vite已有大chunk提示）。全量909：864通过、40失败、5跳过；相对本轮起始905/860/40/5新增4项通过。40失败**名称逐项一致**，差集为空，见Station `docs/PUBLIC_REMOTE_TEST_BASELINE.json`。
- 公网HTTP/header/WS空闲/心跳探针与源码ZIP工作树清单/校验2项通过；这不是微信云托管WSS验收。MySQL原生3项因本机无服务明确跳过；提供手动CI MySQL8.4独立空测试库及逻辑备份恢复，未运行CI，不声称平台备份通过。
- 当前WSL系统只有Python3.14.4，固定pydantic_core2.33.2/PyO3最高3.13，不为测试升级产品依赖；隔离下载官方项目Astral Python3.13.16，SHA256 `24801ea31c7d406d559a17e2226325c723d50c56900b9c0da7b62adaae2affc9`，使用 `/root/.cache/ahastation-public-313/env/bin/python`。未装系统服务/Docker，未读取临时仓库副本。
- 真实Codex证据临时目录 `C:\Users\79142\AppData\Local\Temp\station-real-public-m0u84e7k`；仅新会话 `01a12580-e44d-7b30-846b-70ac60ce6b62`，未修改用户项目或旧历史。Bootstrap失败发生在启动测试Hub前，其guardian结束并确认退出；临时目录和新原生测试记录保留供检查。
- 所有测试Hub/Bridge/server任务按fixture退出，包输出目录runtime仅构建产物，不包含真实凭证。最终交付 ZIP 及SHA256见 `runtime/delivery-manifest.json`；没有真实公网部署、DNS/网站改动、提交/推送/发布。

## 2026-10-11 三项审查问题修复

本次只增加取消事务/提交归属及托盘降级保护，未改各平台进程监管、会议调度、其他 backend 或打包配置。

- Hub：`hub_store.py` 的取消事务与派发准入共享 owner→task 行锁，事务内以最新状态决定未派发取消或等待 Bridge 证明；`public_hub.py` 提交后发送取消，并在准入/发送之间发生取消时补发。新增真实回环测试三次重复暂停取消观察 queued 后放行派发，持有 Bridge 最终退出反馈，确认 Hub 未虚报完成、取消送达正确 Bridge、错误 owner 被拒绝；另覆盖取消先于网络任务消息的情况。继续保留取消墓碑和断线重连测试。
- Station：生产普通/恢复轮询与取消绑定 submission ID、原轮询控制器，pending 在现有写队列内条件清理。新增三项测试覆盖迟到确认、重复取消、steer 队列及恢复，验证新任务 pending/轮询/反馈和下一任务可停止；安全存储测试覆盖旧引用条件清理。
- Bridge：生产 `TrayWindow` 四项故障注入测试覆盖启动失败后关窗与后台最小化、未就绪/已就绪区别、显示图标失败、部分 setup 线程恢复。使用替身窗口和托盘后端，**不是原生 GUI 实测**。

实际运行结果：

| 检查 | 本次结果 |
|---|---|
| Station 起始全量 | 909：864通过、40失败、5跳过 |
| Station 最终全量 | 912：867通过、40失败、5跳过；失败名称逐项相同、差集为空，见 Station `docs/PUBLIC_REMOTE_TEST_BASELINE.json` |
| renderer/Electron typecheck及构建 | 两套退出0；Electron及renderer构建通过，Vite仍有既有大chunk提示 |
| Windows Python 起始全量 | 63：46通过、17跳过、无失败 |
| Windows Python 最终全量 | 70：52通过、18跳过、无失败 |
| WSL Python3.13.16 最终全量 | 70：54通过、16跳过、无失败；包含既有 Linux 监管及本次取消协议测试 |
| MySQL 原生 | 四项跳过（新增16次双线程取消/派发事务竞争），本机没有专用MySQL；协议测试注入SQLite不证明MySQL行锁实测通过 |
| 最新Windows冻结包 | 原生构建、冻结自检、Job能力probe通过；对同一解压包运行冻结烟测，首轮与renderer构建并行时报告 `Frozen task did not start`，没有输出guardian诊断，首轮原因未证实。构建结束后独立复跑通过，验证原生ID/权限/cwd/文本、真实取消退出及下一任务，不修改无关监管规则，也不隐藏首次失败 |
| 原生 GUI、macOS/Linux/ARM64、跨公网、微信云托管、真实模型、麦克风 | 本次均未运行，继续待实机验收；未付费调用、未自动登录/提权、未部署或更改DNS |

最新交付输出目录为 `runtime/cancel-race-2026-10-11`，使用已有 `scripts/build_bridge.py` 和 `scripts/package_hub.py` 生成；保留旧 `runtime/review-delivery` 等包。SHA256、字节数和当前工作树源码清单核对后更新 `runtime/delivery-manifest.json`，旧 manifest 备份在新输出目录。冻结验证针对本次解压包，不以旧包结果替代；原生 GUI/托盘验收仍未进行。

## 2026-10-12 微信云托管源码读取权限

用户已确认云端镜像构建及推送成功、容器报 `/app/device/public_hub.py: Permission denied`；本轮未操作云端。旧导出文件为0600，复制后root所有，hub无法读取。仅修改 `scripts/package_hub.py` 的ZIP条目Unix权限及 `deploy/Dockerfile` 的复制后权限修正，不修改数据库、认证协议、Station/Bridge业务或运行用户。

新增包权限回归对Hub/WSS两个实际导出包逐项检查Unix类型、普通文件0644/显式目录0755及DEFLATE压缩，包括SOURCE-MANIFEST.json、根Dockerfile和.dockerignore。修改前新回归失败，修改后 `test_probe_package.py` **3/3通过**，同时验证白名单、根目录布局、文件清单哈希和根Dockerfile字节一致。无需付费模型调用。

最新源码包目录 `runtime/source-permissions-2026-10-12`；保留旧包与未改动的Bridge包，delivery-manifest仅替换重新生成的Hub/WSS包条目并记录本次权限验证。重新上传：端口8787、目标目录`.`、Dockerfile名称`Dockerfile`。本机Windows/WSL未发现Docker，**未完成容器构建、hub容器内读取及云端重新启动验收**。不将生命周期 `/app/cert/initenv.sh` 错误当作已确诊独立问题，不改root运行。

## 2026-10-12 Codex 桌面版验收记录

代码增加桌面组件自动发现、metadata-only RPC 会话目录、原生引用核对和本地控制切换。自动优先当前桌面实际子组件，备用可信目录按版本确定选择；手工高级设置保留。Windows 桌面版本26.1007.2314.0，组件0.162.0-alpha.17.2，login status已登录。RPC显式vscode/appServer等来源，本机桌面记录为vscode/Codex Desktop，真实cwd来自thread/read并核对session_meta；不读取完整历史、不上传凭证。

- 新增10项回归调用生产发现/RPC/适配器逻辑，其中RPC fixture是真实stdio子进程、有分页/变更/失败及重复来源；覆盖无PATH、多候选/更新失效/手工保留、真实cwd/本地数据/不可恢复引用、占用未知/切换控制、两轮同ID、权限/model默认、不偷偷新建和取消后历史标记残留。
- Station本轮起始及最终均912：867通过、40失败、5跳过；名称逐项相同，且与之前记录的40名逐项相同，差集为空。renderer/Electron typecheck及构建退出0；Vite既有大chunk提示保留。electron/main.ts SHA256 未变化。
- Windows Python全量81：63通过、18跳过；WSL Python3.13.16全量81：64通过、17跳过，无失败。Windows原子Job、Linux subreaper/pidfd真实进程测试、取消/断线重连及旧CLI/Claude协议回归保留；WSL不是原生Linux桌面或ARM64打包验收。
- 真实执行使用Codex桌面新建的独立项目 `C:\Users\79142\Documents\Codex\2026-10-12\bridge-desktop-acceptance-20261012`、原生会话 `01a12ee6-1b9e-7412-8707-4ae4ce9486db`，未操作用户工作会话。Desktop首轮写README标记，独立exec resume接续上下文写SECOND，均同ID/cwd；原权限workspace-write/never，没有提权。发现任务结束后桌面仍可能持有writer；首次恢复明确writer冲突，归档期间明确archived错误，仅对这个新测试会话由桌面归档/恢复释放writer后再恢复成功。
- 两次原生恢复分别使用生产LocalAgentRunner初始执行与Bridge/Hub回环（注入SQLite），不连接部署服务；写REMOTE_ONE/REMOTE_TWO并收到文本，慢任务pulse文件写入后请求取消，真实监管证明退出且文件停止增长。随后发现旧inProgress误阻断新任务，本轮修正且新增回归；修正后的后续真实执行及最终冻结验证结果在交付manifest补记。没有把上述首次失败隐藏成全程成功。
- 冻结包保留旧包，最新输出及大小/哈希/自检/Job probe/烟测记录以 `runtime/delivery-manifest.json` 为准。Hub/WSS包条目保留，未重建云端服务或协议。新模块须在最新包自检中出现 desktop_catalog_sources；旧包自检不替代新包。

仍待验收：Station原生GUI实际点击选择/配对、回桌面界面重新打开同一会话核对、桌面组件真实更新/重启GUI、原生macOS桌面组件发现/执行/取消、原生Linux/ARM64交付、托盘/自动启动、MySQL、跨电脑公网/WSS、麦克风及Claude真实模型（本机捆绑Claude CLI存在但未登录）。当前只读查询、协议fixture、模拟darwin不算这些实测。没有发布、推送、云端部署、DNS修改或自动登录；所有自建回环Hub/Bridge均退出，保留隔离测试证据。

本轮真实取消后的续发补充：修正历史 inProgress 判断后，同一原生ID的新指令已实际开始并写出 AFTER_CANCEL.md；CLI随后返回 `Selected model is at capacity`，未得到成功最终文本，因此“取消后完整一轮成功反馈”仍待验收。没有为此切换模型、提权或重复付费调用。两轮与取消证据在 `C:\Users\79142\AppData\Local\Temp\station-real-public-qv5l0x_z` 的bootstrap、独立SQLite任务记录及after-cancel-result.json；后续失败也保留。pulse在取消后不再增长，桌面主进程仍在。适配器现在把桌面恢复/writer/模型失败原因写入持久反馈，避免只留下泛化失败。
桌面回读补充：通过本机桌面API read_thread只读回读这个测试ID，已能看见Bridge后续turn、取消的interrupted及容量错误，cwd和原ID一致；这验证本地历史连续性，仍不当作原生GUI重新打开的视觉验收。两轮成功恢复分别经过LocalAgentRunner初始执行与公网Hub/Bridge回环，未完成Station GUI两轮点击验收。


## 当前桌面共享执行增量

桌面模式已改为同一常驻服务的原生 thread/turn 通道，不再独立 exec resume 或要求日常声明释放。上一版归档/恢复与独立监管结果属于历史验收。首次联动启动、权限、按会话排队、准确停止和崩溃阻断见 BRIDGE_PRODUCT.md；本轮真实/模拟证据与待验收项见 [SHARED_DESKTOP_ACCEPTANCE.md](SHARED_DESKTOP_ACCEPTANCE.md)。已部署 Hub 的协议、数据库与云端没有改动。

## 2026-10-13 桌面断联核对

丢失完成通知导致 Station 永久等待的场景已由订阅连接协议测试复现并修复。Windows/WSL 最终 110 项分别 92/93 通过、18/17 跳过，无失败；共享通道 29 项（本次新增 10 项）通过。Station 两套 typecheck 通过，本次没有 Station 业务代码变化或全量/构建复跑。包与冻结检查见 delivery-manifest，详细恢复条件、故障注入范围与未验收项见 SHARED_DESKTOP_ACCEPTANCE.md。本次未进行真实 GUI/模型或云端验收。
