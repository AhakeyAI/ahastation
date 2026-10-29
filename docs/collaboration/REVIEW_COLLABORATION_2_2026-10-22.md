# 统一会议候选版 collaboration.2 独立审查

日期：2026-10-22。对象：etrnal-dev 的未提交候选源码、0.19.0-collaboration.2 交付包和证据。此次为审查，未修改生产代码、安装包或部署云端。

## 结论

统一主界面、原 Host 编排、固定目标、独立专家讨论、任务补充和结构化交付确有代码及部分运行证据，不是只有静态原型。仍有四项已用隔离脚本复现的缺陷，当前不能认定全部功能满足要求。建议修复后再产出候选包并安排真实验收。

以下四处涉及的源码已与实际交付的 source/ahastation-collaboration-source.zip 逐字节比较一致；Windows 安装器 SHA256 与 CHECKSUMS.json 一致。不是根据后来编辑的生产代码推断已交付包问题。此结论结合原交付的包内来源核验记录；本次未重新安装或重打包。

## 已复现缺陷

### R1 / P1：Host 在模型启动前校验失败，会永久挡住后续消息

位置：electron/collaboration/unified-host.ts:119–133；electron/collaboration/station-service.ts:280–281、545–558。

Host 在准备输入前即将输入记为 starting；资料授权／解析或 Host 启动失败时，一律转 reconcile。若此时尚未创建 Guardian 执行，worker-inspect 不会产生 cleanup_confirmed 结果，恢复循环无法把它收口。后续普通消息又因该会议存在未完成的 hostMessages 被跳过。

隔离复现：令 prepareInput 抛出“资料未绑定”，确认没有调用模型；输入状态落为 reconcile；加入下一条合法纯文字消息，doPump 调度的 Host 输入数为 0。

修复方向：区分启动前失败和已开始／可能产生副作用的未知执行。启动前失败保存可读错误并允许修正或后续输入；只有实际执行身份存在且退出未知时才进入核对。不能为了通行直接重放已开始的执行。补“未授权附件／解析失败后发送合法问题”的回归。

### R2 / P1：依赖任务的基线变化会抛出整个 pump，阻断无关审批／接单

位置：electron/collaboration/station-service.ts:303–315、875–880。

计划中后继仓库任务保存初始 baseCommit；前序集成后 meeting.verifiedCommit 通常改变。prepareAssignment 因两者不同抛错，但 doPump 未在单项计划内隔离该错误，其后的审批决定投递及本机接单循环不再运行。一个等待基线确认的任务即可阻断其他工作。

隔离复现：前序已经 integration=verified，后继仍持原计划基线；doPump 抛“前序成果已改变基线”，同一快照中已获准的另一项工具审批未被处理。

修复方向：明确前序成果与后继代码基线的版本绑定、展示／修订规则，使依赖任务可继续；如果仍须重新批准，只让该任务进入明确等待，不影响其他审批、停止与独立任务。不能为消除错误而静默改设备或忽略准确提交核验。

### R3 / P1：普通业务权限 403 被持久误判为设备凭证失效

位置：electron/collaboration/connection.ts:26；station-service.ts:138、789–793；services/remote/device/collaboration_store.py:239–240。

HTTP 请求对所有 403 都 stop 连接并回调 credentialInvalid=true，Station 随后持久保存失效状态，正常 connect 会直接返回。服务端对“并非协调设备”等业务权限限制也使用 403，并不表示 token 失效。

可见触发：共享非仓库任务的人工成果检查入口在 B 也显示；B 的 delivery.review 会发送仅协调设备可用的 task.control:review，收到 403，进而把正常设备连接标成凭证失效。

两段隔离复现：真实生产 Hub／SQLite／本机 HTTP-WSS 夹具中，B 的 review 返回 403，但同一 token 立即读取 snapshot 返回 200；客户端 Connection 对该 403 仍断开并通知 credentialInvalid=true。

修复方向：区分认证失效与具体操作越权，业务 403 只报告操作失败；B 上不具备直接权限的操作应明确禁用、提示协调设备或通过已定义请求路径转交。不要要求用户反复撤销／注册设备来掩盖该错误。

### R4 / P1：展示名作为 @ 路由依据，设备改名后中文点名会落到 Host

位置：src/components/SideDrawer.tsx:333；src/lib/unified-meeting-store.ts:47–51。

选择候选时把可变 displayName 写入文本，发送时再按当前 label 匹配，稳定 memberId 未作为独立目标保存。若用户选择“办公电脑 · codex”后设备改名，旧文本不再匹配目标；用于检测未知 @ 的 ASCII 正则又不识别该中文名称，最终发送无目标字段的消息，进入 Host 路由。

隔离复现：选中中文显示名，刷新为改名后的设备状态，再发送原输入；实际命令没有 targetDeviceId／targetAgentId，成为 Host 消息。不是单纯报错或失去显示标签。

修复方向：候选选择绑定稳定目标身份，展示标签只负责呈现；名称、在线状态变化后重新核验目标，未知或失效点名必须明确拒绝，不能回退 Host。补中文／空格／改名／同名设备与发送前状态变化测试。

## 本次验证

| 项目 | 本次结果及范围 |
| --- | --- |
| Renderer / Electron 类型检查 | 两侧通过，本次运行 |
| 统一模块与原功能定向 Node 回归 | 28 项，26 通过、2 需要外部 Bridge／Hub 的场景跳过、0 失败，本次运行 |
| 统一 Hub 协议回归 | 16 项全部通过，实际生产路由＋本机 SQLite／HTTP-WSS，无云端／模型，本次运行 |
| 新增问题复现 | 4 个问题均复现；另有 1 个 Hub 权限与凭证有效性边界复现通过 |
| 交付源码和安装器 | 四处问题源码匹配交付源码 zip；安装器 SHA256 匹配清单 |
| 全量 1054 项 | 核对既有交付比较记录；本次未重跑，34 项既有失败和 5 项跳过未宣称解决 |
| 真实 Codex / MySQL 5.7 / 包启动 | 核对原交付证据及其范围；本次未重跑模型、MySQL 或实际安装 |

复现脚本与结果：

- [Node 四项复现](../../runtime/review-collaboration2-2026-10-22/reproduce.mjs)、[结果](../../runtime/review-collaboration2-2026-10-22/RESULT.json)。
- [Hub 权限边界](../../runtime/review-collaboration2-2026-10-22/hub_boundary.py)、[结果](../../runtime/review-collaboration2-2026-10-22/HUB-BOUNDARY.json)。
- [源码比对](../../runtime/review-collaboration2-2026-10-22/SOURCE-COMPARISON.json)、[16 项协议日志](../../runtime/review-collaboration2-2026-10-22/unified-protocol.log)。

复现仅使用内存状态、临时 SQLite 和自有本机 HTTP 夹具；没有调用真实模型、操作用户项目、改真实凭证、启动用户 Codex 或修改云端。复现脚本的成功表示问题被成功展示，不表示产品符合要求。

## 其余功能判断

- 有代码与定向证据：原组件接入、单 Host 提案入口、独立计划批准、固定设备、成员去重、无项目文字交流、三类上下文隔离、任务补充、真实报告与准确成果引用。属于已经有实现基础，不作全部真实用户场景通过的保证；上述四个缺陷也限制相关链路的完成结论。
- 未发现本次定向回归新增失败：本机 Host 生命周期、计划正文、后端凭证环境隔离、旧远端目标及语音点名路由。但不能据此宣称原其他 Agent、真实语音／屏幕、IDE／技能、全部恢复与平台行为无影响。
- 仍待现场：新版 Hub 部署、双物理 Windows 电脑公网协作、用户指定 GitHub 仓库的真实 PR／冲突与取成果、用户 Codex 桌面的双向接续／停止／断联恢复、真实账号／GitHub 登录完整界面流程，以及硬件相关原功能。

因此 T01–T45 不得标为全部通过。优先修复 R1–R4 并补相应回归，再按既定授权升级测试 Hub、重新构建候选包并进行剩余实机验收。未在此次审查中修复或发布。
