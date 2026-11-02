# 公网可选模式：协议、隔离和恢复

公网由 `device/public_hub.py` 单独启动，协议 2；旧 `device/device_hub.py` 是显式 LAN/Tool Token 模式，两套认证及停止语义不互相回退。公网不存在开发默认 Token，不开放旧全局 health/GUI/events/debug 管理接口。未启用远端控制不影响 Station 本地。

## 身份与授权

Hub 没有产品账号依赖：最小所有者账号+12–128 位密码（PBKDF2 600,000 次，随机 salt）+随机恢复码。注册和恢复展示一次恢复码；恢复会旋转码和密码、撤销全部控制端凭证并保留设备。控制端 30 天、设备 180 天随机 bearer 凭证，MySQL 仅存 HUB_SECRET 的 HMAC 校验；到期需重新登录或配对，不自动提升权限。Station Electron safeStorage 加密，Linux basic_text 不作安全持久化；无安全存储时只在当前进程保存 Token。Token/恢复码不返回 renderer，配对码短时显示；恢复码只在原生系统窗口展示/用户点击复制。

144 位随机配对码，十分钟单次有效，事务+条件更新抵抗竞争领取；同 OS 用户稳定设备只能绑定一个有效 owner。创建/领取限流，跨 owner 的设备、目录、任务、结果和取消拒绝。控制和设备凭证范围分开，WS `Authorization` header，不在 URL。客户端自报 owner/device/agent 不作为身份依据；Hub 从凭证派生 Agent ID（device-provider），重连同 provider 拒绝重复连接。目录刷新、加入/发送和交付都核对在线、device/provider/native session/cwd；离线明确目标不静默排队，旧无目标 LAN 等待语义不变。

初版每所有者最多10台有效配对电脑；解除旧设备后可新增。目录/任务响应在Station侧限512KiB，公网适配器请求有20秒网络等待边界；收到网络超时仍保留提交引用，不能当任务未执行而盲目重跑。

Bridge 授权实际 resolve 路径、根目录 samefile 边界和目录存在性：扫描前过滤、启动前及会话锁等待后再次核对。只接受文本/resume/native ID/cwd，不接受服务端 sandbox/approval/model 提权。远端文件、完整会话和 CLI 登录不上传。原生会话身份为稳定 device+provider+native session，Agent ID 只是执行入口；同 OS 用户跨 Bridge 共用内核锁。未监控其他原生客户端，显示未知；执行期间不能在另一个原生客户端操作同一会话。

根目录授权限定被发现、选择和启动的项目/cwd；实际文件能力仍受远端原有CLI沙箱、审批及其本机MCP配置约束。这不是另建一套文件系统隔离器，也不会自动收紧或扩大用户已有CLI/MCP权限。

## 执行、取消与断线

Station 提交前持久化随机幂等 key（service+owner+device/provider/session），Hub 事务保存 task/key 后才派发；Bridge 收据先于 ACK，独占 launch-intent 先于本机执行。重复提交返回原任务，重复投递不重跑。Hub 保存 dispatching/delivered/received/waiting/running/cancelling/result 等 revision；补交结果只有数据库写入后 ACK。交付不确定、丢失收据或启动结果不能证明时阻断并核对，不自动重新执行，也不宣称严格“恰好一次”。键墓碑保留避免旧请求在反馈清理后重跑，每 owner 上限 20,000 需运营处理，不能随意删除仍可能重试的键。

公网停止：Station → 持久化取消（包括尚未提交的 key 墓碑）→ Bridge 本地 marker → 原任务监管清理 → cleanup_confirmed → Station 才清除待处理引用。队列任务可确认未启动；已执行任务仅清理本任务所属链。重复取消/完成竞态不复活任务。断连取消保存在 Hub，重连核对后送达；断网、界面切换、退出 Station 或轮询超时不自动取消。取消请求已接收不是退出证明。解绑先持久化设备 draining 阻止新任务，给既有连接最多八秒补交清理反馈后撤销；离线/清理未知准确报告，Bridge 重连被撤销时会停止自己尚未确认的任务。

2026-10-11：Hub `request_cancel` 与 `admit_dispatch` 采用相同 owner→task 数据库行锁顺序。取消在事务内重新读取状态，只有仍为 queued、尚未完成派发准入的任务才直接确认未启动；准入先提交 dispatching，之后所有交付状态和交付未知都仅持久化取消，等待 Bridge 退出证明。WebSocket 发送在事务提交后进行；若取消发生在准入与任务消息之间，派发后再次核对并补发取消，重连仍补发。task transition 继续保留终态不可复活及退出未确认优先规则，取消前提交墓碑/所有者隔离不变。Bridge 暂无收据时的退出未确认不能视作最终成功，任务随后送达也须实际清理证明。

Station 清理待处理引用使用原写队列中的 submission 比较，并为取消捕获对应控制器；迟到的旧取消确认不清新引用、不停止新轮询、不覆盖新任务状态。同一提交重复取消共享请求，正常轮询可完成旧任务并继续队列。user/steer/shutdown 区别及旧 LAN 行为保持原样。

撤销握手使用带认证错误标识的401/403或明确4401关闭，才触发设备撤销处理。数据库503、重复连接409、资源429及代理通用403采用退避重连，不能被误认为取消；探针需核查相应状态/响应头。

Bridge 突然崩溃后 guardian 自行运行至超时/清理，记录结果供重连补交；同一会话下一任务不得越过未确认记录。guardian 崩溃或 launch-intent 已写、所属记录缺失时宁可阻断，不能把 PID 不存在、根进程退出、SID/原进程组为空或一次扫描为空当作整条链已退出。新内核 boot 证明和平台持久归属证据按既有恢复路径验证；记录丢失/损坏无可靠证明的情况需本机排查，重启后按监管证据恢复，不能手删记录绕过。

平台：Windows `PROC_THREAD_ATTRIBUTE_JOB_LIST` 原子创建且不可 breakaway、Job 关闭杀链及 active processes=0 退出证据；Linux subreaper 收养 setsid/double fork 后代，PID+start_ticks+boot_id/pidfd 验证身份，内核收养链为空才确认；guardian 异常死亡无法证明遗漏后代时保持阻断。macOS 临时用户级 launchd 作业+独立 resource coalition 和 proc unique ID/pidversion/boot identity，验证内核任务计数，恢复缺少 coalition 证明时不放行。macOS 代码及跨平台测试已有，**本机无真实 macOS**；不能将 Windows/WSL 结果称为 macOS 通过。Bridge 在选择前跑真实能力探测，失败的环境目录 available=false/error，不展示必然失败的会话为可执行。

## 数据和限额

生产仅 MySQL；缺连接、schema、权限或数据库不可用会 fail closed，不降级内存/SQLite。连接路由内存只用于在线 WS，持久任务不依赖容器文件。一个实例/worker/单版本；数据库不等于分布式路由。

初始限制：HTTP 64 KiB、读 body 十秒/1024 chunks/128 并发；WS 128 KiB/8 message queue、最多1000握手/连接、每连接240消息/分钟、心跳八秒/35秒失联；账号认证 IP15/账号6、配对创建6/领取IP12、提交30、目录120、取消60每分钟；每 owner 未完16、每设备4，派发执行 owner4/设备2（实际 CLI 继续已有串行队列）。错误反馈最多48 KiB，Bridge 最终文本16,000 bytes、stderr2,000字符。不保证网络层 DDoS 防护；日志只打印方法、耗时、连接断开和数据库不可用，不记录凭证/密码/URL查询/完整敏感请求。部署平台监控 4xx/5xx/连接、CPU/RAM/流量、DB连接/容量；独立库反馈完成七天清理，可配置保留期限，未确认任务不作为过期完成删除。清理/迁移需保留密钥及键墓碑。

源码及包见 [微信云托管部署](WEIXIN_CLOUD_DEPLOY.md)、[Bridge](BRIDGE_PRODUCT.md)、[实际验收记录](ACCEPTANCE_PUBLIC.md)。正式公网发布需要探针、真实 MySQL 和跨网/原生平台验收，不能用回环模拟替代。

## 2026-10-12 桌面组件接入（上一版独立恢复，历史记录）

以下手动切换及独立执行行为已被下节共享执行取代，保留旧验证记录供追溯。

Bridge 在原配置、项目授权和公网协议之上增加 Codex 桌面版接入，详见 [Bridge 产品文档](BRIDGE_PRODUCT.md)。没有改 Hub 数据库结构、身份认证或已部署服务，不要求云端升级。组件路径、版本、来源、codexHome 和认证检查保存在电脑端，目录仍只传原有引用白名单；来源通过 Agent 显示名称及会话标题说明，不新增必需协议字段。Station 沿用当前配对、hostId、原生ID、cwd、聊天、文本结果及取消/恢复。

目录使用组件公开的 thread/list/read 摘要查询，显式包含桌面来源并设 useStateDbOnly；不能用新 app-server 的 notLoaded/idle 宣称桌面进程空闲。占用未知须用户在 Bridge 本地确认切换控制，原生引擎拒绝 writer 冲突，不回退新建会话。历史 inProgress 可能在取消后残留，因此不把它当当前占用锁；跨Bridge互斥和 cleanup-unconfirmed 阻断仍由原有会话锁/监管记录负责。取消只清理 Bridge 自己的独立 exec 任务及后代，不终止桌面后端或其他会话。断网重连沿用持久收据和 ACK，不新增自动取消。

本机桌面版本 26.1007.2314.0 / 组件 0.162.0-alpha.17.2 的真实隔离会话恢复已验证；不是任意版本、macOS 或跨公网的验收结论。GUI、原生平台与真实执行器分别记录在 [验收文档](ACCEPTANCE_PUBLIC.md)。独立 CLI、Claude、Linux CLI 及三平台监管/打包入口保持兼容。


## 当前桌面共享执行增量

桌面模式已改为同一常驻服务的原生 thread/turn 通道，不再独立 exec resume 或要求日常声明释放。上一版归档/恢复与独立监管结果属于历史验收。首次联动启动、权限、按会话排队、准确停止和崩溃阻断见 BRIDGE_PRODUCT.md；本轮真实/模拟证据与待验收项见 [SHARED_DESKTOP_ACCEPTANCE.md](SHARED_DESKTOP_ACCEPTANCE.md)。已部署 Hub 的协议、数据库与云端没有改动。
