# 可选公网远端控制：当前工作树交付

2026-10-10。在原Pocket Vibe入口增加公网模式；本机后端和原会议路径保留，旧LAN/Token另为显式高级兼容模式。当前没有已部署公网地址，`resources/remote-service.json` 留空，界面显示未配置。正式部署/发布需单独授权及平台验收。

## 用户操作

1. 设置 → **远端控制** → 启用。运营者构建已验收地址可集中预置；高级设置可填自己HTTPS服务，不散落IP或未部署域名。
2. 创建/登录专属远端身份，保存系统窗口展示的一次性恢复码；远端身份不同于模型或CLI账号。失去Station安装后可凭账号/恢复码设置密码，撤销控制端登录而保留电脑；不需要短信。
3. 添加电脑生成十分钟一次配对码，在远端独立Bridge输入并确认本机项目根/CLI权限和登录。WindowsBridge包自带Python；Codex可自动接入已登录的桌面版，无需另装CLI，独立CLI/Claude方式保留。已配对电脑/在线状态/解除配对/任务取消在同一个设置区管理。
4. 先用本机Host打开现有会议 → 参与者Pocket Vibe → 选择远端会话 → 电脑/provider/原生会话 → 加入当前会议。共3成员容量、稳定device/provider/native ID去重、每hostId独立目标和回复沿用原机制。公网没有无目标Host/自动Worker入口，不用MODEL选电脑。模型与沙箱沿用远端本地配置。
5. 聊天`@具体成员`连续两轮恢复相同原生session ID。语音规范化标题唯一时直接加实际hostId；重名/多个候选停止并提示文本选择。普通email含@不妨碍标题点名，显式已知成员@保留。连接中/失败/离线不能转交本机。远端文本加图片/附件在写本机附件目录前拒绝，普通本机附件兼容。
6. 公网“停止”持久请求取消并等待任务guardian整链退出确认；取消中/退出未确认准确反馈，不能把请求已发当任务结束。关闭应用/标签切换/断网/轮询超时不自动取消；未确认引用保留供恢复核对。LAN兼容的停止仍只是停止等待。

## 保存和边界

主进程safeStorage加密控制端Token，Linux basic_text/unknown不作安全持久化；无可用安全存储仅当前进程持有。renderer只收到白名单状态/配对码，不收到长期Token或恢复码（恢复码在原生窗口用户选择复制）。远端引用增加可选service_url/owner_id；切换服务或身份不能让旧成员静默改目标。提交前通过原settings写队列持久化独立幂等引用，重启查询原task而不是把Hub turn ID当native ID或再次POST执行。

Bridge保存收据/启动意图/结果/取消/ACK，Hub MySQL事务保留关键任务状态，断连重连核对后补交反馈/取消；交付不确定不盲目重派。文件与CLI认证留电脑；Hub不复制完整历史/项目或模型凭证。Windows原子Job、Linuxsubreaper/pidfd、macOS launchd/resource coalition保留，跨Bridge同原生会话内核锁；原生其他客户端占用未知，执行时勿同时操作。缺必需监管能力或登录时会话不可用，不能到执行才必然失败。

服务仅一个实例/worker/版本；多用户隔离、限流/大小/并发/队列/保留期限为应用层保护，不宣称网络DDoS防护。生产MySQL不可用失败，不静默内存/SQLite。当前协议测试注入SQLite仅供自动化；本机无Docker/MySQL/云端权限，不当作公网或生产DB验证。

## 文件与运行检查

- `electron/remote-control.ts`、`remote-control-types.ts`、`store.ts`：安全主进程身份/IPC、集中地址、原存储和原写队列中的提交恢复引用；`ipc/settings.ts`注册、`preload.cjs`/`src/types.ts`白名单接口。
- `pocket-vibe-adapter.ts`/`pocket-vibe-target.ts`、`ipc/sessions.ts`/`backend-auth.ts`：Bearer模式、原生目标与身份绑定、目录/加入校验、提交幂等/恢复/真正停止，以及public无目标入口保护。无目标LAN调用继续原路径。
- `RemoteControlSettings.tsx`/`SettingsWindow.tsx`、`BackendSettings.tsx`/`Lobby.tsx`、`SideDrawer.tsx`/`RemoteSessionPicker.tsx`：普通身份配对与现有参与者入口，移出模型凭证及电脑MODEL设置，保留高级LAN配置。
- `voice-final.ts`、`orchestrator.ts`、`meeting-store.ts`：生产语音中的普通@边界、明确成员路由及停止提示，不重写会议/调度。
- `resources/remote-service.json`/`electron-builder.json`集中运营地址；`tests/remote-control-public.test.mjs`及已有远端测试包含真实PythonHub/Bridge/测试进程回环。不修改electron/main.ts。

本轮起始全量905/860/40/5，最终909/864/40/5；40失败名称逐项一致，见 [基线对照](PUBLIC_REMOTE_TEST_BASELINE.json)。renderer/Electron typecheck与构建通过，Vite大chunk提示沿原构建边界不做无关重构。

Windows Python63：46通过、17跳过；WSL Python3.13.16 63：48通过、15跳过；冻结Windows包适配器参数/cwd/文本与监管取消通过。当前真实Codex0.162.0-alpha.2已登录但sandbox setup失败、未创建bootstrap文件，不能声称当前真实两轮/停止已通过；没有提权或重复付费。Station捆绑Claude CLI存在，认证未登录。GUI、托盘/自动启动、麦克风、macOS/原生LinuxARM64、两电脑跨网、MySQL、微信云托管构建/重启/普通桌面WSS/正式域名均分别待验收。

仓库内 services/remote 的 [PUBLIC_REMOTE_CONTROL.md](../services/remote/docs/PUBLIC_REMOTE_CONTROL.md)、[BRIDGE_PRODUCT.md](../services/remote/docs/BRIDGE_PRODUCT.md)、[WEIXIN_CLOUD_DEPLOY.md](../services/remote/docs/WEIXIN_CLOUD_DEPLOY.md)、[ACCEPTANCE_PUBLIC.md](../services/remote/docs/ACCEPTANCE_PUBLIC.md) 包含详细启动/打包/授权/恢复与验收步骤。运营部署包只公开`public_hub.py`；旧`device_hub.py`/控制台是可信LAN高级维护，不部署到公网。

云端目标为微信云托管 `ahastation-hub`、8787、单实例/worker、MySQL station_hub/station_hub_app、普通HTTPS/WSS；实际prod环境ID/地域/MySQL账号、hub.ahastation.com注册/备案/DNS/证书待确认。先上传无业务探针包验证普通桌面入口，再评审授权正式Hub部署；不改ahakey.com，不购买资源、不提交/推送/发布。

## 2026-10-11 取消竞态增量修复

`pocket-vibe-adapter.ts` 将普通/恢复轮询和取消绑定原始 submission ID；取消只中止捕获的轮询控制器，不操作后来任务的控制器。`remote-control.ts` 清理 pending 时在原 settings 写锁内比较 submission ID。旧确认迟到时不会清除新引用、更新新任务状态或阻止后续输入；同一提交的重复取消共享一次请求。user 清除待发队列、steer 保留队列、shutdown 仅停止等待的区别保持不变，断网/关闭/超时不新增远端取消。

新增 `tests/pocket-vibe-cancellation-races.test.mjs` 直接执行生产适配器，覆盖普通任务、恢复任务及 steer 排队：普通轮询先结束旧任务，新任务开始后才放行旧取消响应，核对新 pending、未中止的轮询、正常完成和下一任务仍可停止。原安全存储测试增加在写队列中拒绝旧提交清理新引用的断言。

本轮实际修改前全量 **909：864通过、40失败、5跳过**；修改后 **912：867通过、40失败、5跳过**，40失败名称逐项相同、无新增失败，更新 [基线对照](PUBLIC_REMOTE_TEST_BASELINE.json)。renderer/Electron 两套 typecheck 和构建通过（保留既有 Vite 大chunk提示）。Hub/Bridge 本轮测试、最新包及平台未验收事项见相邻仓库 `docs/ACCEPTANCE_PUBLIC.md`。本轮不调用付费模型，不修改 electron/main.ts 或平台打包配置，不部署/提交/推送/发布。

## 2026-10-12 Codex 桌面版接入（上一版独立恢复，历史记录）

以下独立 exec 和手动切换行为已被下节共享执行取代，不是当前桌面模式的操作要求。保留旧验证记录供追溯。

远端电脑在 Bridge 普通界面选择“Codex 桌面版”自动识别运行组件和登录，无需另装 CLI 或寻找 exe；手工路径在高级设置，旧 CLI/Claude 配置保留。确认允许访问的原项目目录、权限和已释放桌面任务/切换控制后保存配对。在现有 Pocket Vibe 选择器刷新，标题及 Agent 名显示来源，只加入可恢复且已授权的本地原生会话。云端、仅标题、缺恢复数据、归档或引用不匹配显示原因，不回退新建、本机或其他目录。

Station 本机 Codex transport/SDK 锁定版本未修改。没有 Hub 数据库、认证或必需协议字段变动；每个成员仍以独立 hostId 持有原生ID/cwd，模型和权限由远端组件配置决定。桌面占用未知，必须由用户在电脑端确认切换，独立 app-server notLoaded/idle 不是GUI空闲证明；原生 writer 冲突明确失败。公网停止只作用于 Bridge 发起的独立任务及其后代，等待退出证明；断网、关闭 Station 仍不自动取消。

本轮两套typecheck及构建通过；全量912/867通过/40失败/5跳过，失败名称与本轮起始及之前40名逐项相同，见 PUBLIC_REMOTE_TEST_BASELINE.json。Bridge 新增10项生产发现/RPC/适配器回归，Windows/WSL原有进程监管及重连测试保留。真实 Windows 桌面新测试会话已验证原生ID/cwd、上下文续接、两次独立恢复文本（LocalAgentRunner及Bridge/Hub回环）与真实取消；GUI实际选择、回桌面界面核对、真实更新、macOS、Linux/ARM64、MySQL、跨公网与麦克风仍待验收，详见 Pocket Vibe 的 ACCEPTANCE_PUBLIC.md 与最新 delivery-manifest。回环不称为跨电脑验收。
最终Windows包：Pocket Vibe runtime/codex-desktop-final-2026-10-12/ahastation-bridge-0.2.0-win32-amd64.zip（27,248,650字节）；SHA256及81项两平台Python结果、冻结自检/Job探测/烟测/桌面只读预检见交付清单。Hub/WSS包信息保留。真实取消后同ID续发已执行文件修改，最终反馈因模型容量不足失败，完整成功反馈仍待验收。


## 2026-10-12 桌面联动共享执行增量

Bridge 桌面模式使用同一常驻原生服务和桌面 socket；Station 仍用现有配对、目标引用、参与者、@、轮询和语音文本流程。选择器显示“Codex 桌面联动”来源与桌面执行/等待/Station 执行/停止未确认。首次由用户自行退出旧桌面，在 Bridge 点击“启动联动桌面”；之后不需日常归档、恢复、手动释放。没有共享连接或原生配置/退出证明不足时明确拒绝，不能回退独立 exec、本机或另一个会话。停止请求精确绑定原生 turn；断网和关窗不自动取消。

完整 GUI 双向接续仍待验收。当前已部署 Hub 未改动；本轮不部署、改 DNS 或数据库。实现、平台边界和实际测试分类见相邻 Pocket 仓库 docs/BRIDGE_PRODUCT.md 与 docs/SHARED_DESKTOP_ACCEPTANCE.md；旧独立恢复测试不替代本版共享服务验收。

## 2026-10-13 断联等待自动恢复

桌面已启动任务断联时，Bridge 保留原 turn 占用并自动核对，覆盖完成通知丢失。等待心跳指定自身 threadId；证明原生终态、命令和后台终端均退出后才唤醒原等待项，桌面连接恢复后在同一会话发送一次。查询超时或证据缺失会限频重试，不能把断联/重连当成完成；服务换代保持无法确认。没有改 Hub、配对或 Station 业务代码，没有重新执行已有指令。当前验证为协议测试及冻结烟测，真实 GUI 临时断联后接续仍待验收；具体结果和新包见相邻仓库 SHARED_DESKTOP_ACCEPTANCE.md 与 runtime/delivery-manifest.json。

## 2026-10-13 恢复门禁与配置刷新

远端已登录/启用时，若只恢复了项目记录，应点击“继续会议”，等待主 Host 真实就绪后再选择远端会话。新增单项目恢复横条和明确禁用原因；记录不显示假就绪，设置窗口变更会主动通知主窗口刷新。原远端引用、@ 点名、精确取消和断联恢复保留，没有改 Hub/Bridge 协议或已部署服务。

Windows 独立双击入口、退出日志、整体调用链检查、当前失败名称比较及未验收项见 [会议恢复与启动说明](MEETING_RESTORE_AND_WINDOWS_LAUNCH.md)。不再把 ASR 未配置或已完成远端登录解释为此次会议门禁问题。真实公网和桌面 GUI 全链路仍不能据类型检查/协议 fixture 宣称通过。
