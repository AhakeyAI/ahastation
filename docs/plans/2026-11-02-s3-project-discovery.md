# S3 本机项目候选探测（#100 前置实现）

依赖 S2 的 PR #145，以及 #94 IF-3 v0.1。eternal904 已确认由 Hub 做账号范围的
原子 getOrCreate、唯一性与 alias 迁移；He-1102 的接口确认及 Hub 实现仍待完成。
本次交付本机只读证据模块，不关闭 #100，不宣称已生成权威 projectId 或完成界面归类。

## 本次模块

`electron/observe/project-discovery.ts` 提供两个入口：

- `discoverProject(cwd, {getAccess, isCurrent})`：仅对当前获准目录按需读取 Git 元数据。
  调用方必须传入扫描授权 getter 和本轮 generation 校验；撤权后再授权同一目录仍要使旧任务失效。
- `groupProjectCandidates(results)`：按规范化 origin、完整根提交和对象格式生成本机候选组，
  各 clone/worktree 保留独立挂载，cwd 位于同一工作树时不重复创建挂载。

候选键只用于本机临时分组；它不是 projectId，也不发送到 Hub。provider=`none` 只是
探测结果中“无 origin”的本机表达，不新增生产 wire schema。候选对象含本机路径，
不得直接序列化成 IF-7 清单。现有路径 SHA1、会议、历史 JSONL、授权记录均未改动。

GitHub HTTPS、SCP、SSH URL 统一 owner/repo；只认 origin，fork 不跟随 upstream 归并。
同一 remote 不同根提交保留不同候选，无远端只在无远端命名空间按完整根匹配。
SHA-1/SHA-256 均保留完整 OID。浅克隆、无提交、多根、未知远端、缺对象与失败均未解析，
非 Git 目录单独返回，不因探测而写入项目文件或随机稳定 ID。

Git 子进程不使用 shell；每次 2 秒/64 KiB 输出上限、整轮 12 秒预算、隐藏 Windows 窗口。
禁用懒加载取对象、所有传输、fsmonitor、replace refs/grafts、全局配置与继承的 GIT_* 路由覆盖。
它不执行 fetch、status、checkout、hook、维护或写配置。Git for Windows 使用 NUL，
避免 Node 的设备路径 `\\.\nul` 被 Git 拒绝。失败只返回固定原因码，不转发 stderr 或原始 URL。

起止复核 HEAD、分支、origin、浅克隆状态和仓库几何；元数据发生变化时不混合身份。
授权与真实路径在返回前再次检查；目录消失、链接改指或撤权不能发布旧候选。
Git 初次 rev-parse 不可避免地查找路径上层的路由元数据，但在读取 origin/历史前必须确认
工作树根及 common .git 也在当前读取授权内。只授权 src 子目录或单独 linked worktree、
未授权其 common .git 时返回 metadata-outside-grant，不扩大目录权限。

## 后续生产接线

本模块目前没有接到 ObserveService 定时扫描、IPC、界面或 Hub 客户端；它是可独立审查的
前置提交，不让未确认接口改变现有看板。后续应：

1. 在 S2 已授权、已过滤归属的会话上，按唯一 cwd 调度有并发/总量上限的按需探测；
   不在 2 秒进程快照循环中对所有仓库重复遍历全部历史。明确失效条件，不能永久缓存 branch。
2. 将已解析候选交给 eternal904 的权威 registry。离线或接口未就绪时保留本机候选，
   不各自在设备生成一个 UUID 后宣称跨设备项目已经归并。
3. registry 返回 projectId 后绑定独立 mountId；消费明确的未解析、历史冲突及 alias 状态。
   多路径不覆盖，归并不继承授权，不重写旧 JSONL/任务/回执。
4. 按产品确认的界面显示项目、各 worktree/branch；S4 的执行/分享授权另行确认。
   IF-7 只取获准的稳定 ID 与元数据白名单，丢弃这里的 cwd/gitCommonDir 等本机路径。

Hub 的 getOrCreate 请求/响应、唯一性错误和 alias wire 接口仍需使用方提供；本提交没有
虚构 API 路由或复制同事的 registry 实现。IF-7 格式提案见
`docs/plans/2026-11-02-if7-session-inventory.md`，其中新增字段及重连语义等待确认。

## 验证

Windows / Node 24.19.0。17 项新增回归使用临时真实 Git 仓库，覆盖 clone/worktree/子目录、
fork/upstream、无远端、历史重建、移动目录、分支变化/分离 HEAD、浅克隆、无提交、多根、
嵌套仓库/子模块、SHA-256、缺对象、replace/grafts、读取前后原文件哈希、授权/撤权代次、
符号链接、命令失败不泄漏和继承环境不能换仓库。没有扫描个人 CLI 会话或联网取仓库历史。

两端 `npm run typecheck` 和 `npm run build` 通过；全部观察层、项目和项目清理回归合计
174 项、174 通过、0 跳过、0 失败。基础 PR #145 同步 main 后全量 1320 项、1314 通过、
6 跳过、0 失败；这是基础提交的结果，不冒充新增提交的全量或 Mac/N5095 实机验收。
新增提交的三平台全量结果以其独立 CI 为准。

## 2026-11-04 IF-7 合同复核

IF-7 草案修订为 v0.2：建议由发送设备按接收方及其范围版本分别签名和编号，Hub 不修改
签名正文，避免权限过滤导致验签失败或假跳号。新增 receiverDeviceId/scopeRevision、流
重置和撤权语义均待 eternal904 确认，未改变生产协议。正文建议 96 KiB、完整帧最多
128 KiB，并同时受实际通道和校验复杂度限制；撤权发送失败不能报告远端已删除。

本分支同步 #145 的三端进程采集修复；相对基础分支仍只有原来的 4 个文件。
本地项目探测逻辑未改，正式 Hub registry、S3 调度/界面和 S6 接线仍按上文边界推进。
