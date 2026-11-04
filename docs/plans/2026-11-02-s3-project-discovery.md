# S3 本机项目探测与分组（#100）

依赖 S2 的 PR #145，以及 #94 IF-3 v0.1。eternal904 已确认由 Hub 做账号范围的
原子 getOrCreate、唯一性与 alias 迁移；He-1102 的接口确认及 Hub 实现仍待完成。
本分支已把本机候选探测接入 ObserveService 和扫描详情界面。正式 projectId 与 mountId
仍需 Hub 返回，因此不关闭 #100，也不把本机分组宣称为跨设备项目绑定。

## 本机证据

`electron/observe/project-discovery.ts` 提供三个入口：

- `discoverProject(cwd, {getAccess, isCurrent})`：只读探测当前获准目录，起止复核授权及代次。
- `groupProjectCandidates(results)`：按规范化 origin、完整根提交和对象格式生成候选组；
  clone/worktree 分别保留挂载，同一工作树的不同会话子目录归到同一挂载。
- `readDiscoveryFingerprint(candidate, options)`：只读检查缓存元数据，不启动 Git 或遍历历史。

GitHub HTTPS、SCP、SSH URL 统一 owner/repo；只认 origin，fork 不跟随 upstream 归并。
同一 remote 不同根提交保留不同候选；无远端在独立命名空间按完整根匹配。
SHA-1/SHA-256 均保留完整 OID。浅克隆、无提交、多根、未知远端、缺对象和失败保留未解析，
非 Git 目录单列，不因探测而写项目文件、随机 ID 或授权。

Git 子进程不使用 shell；单次 2 秒/64 KiB 输出上限、整次探测 12 秒预算、隐藏 Windows 窗口。
禁用懒取对象、所有传输、fsmonitor、replace refs/grafts、全局配置与继承的 GIT_* 路由覆盖。
不执行 fetch、status、checkout、hook、维护或写配置。Git for Windows 使用 NUL。
失败只返回固定原因码，不转发 stderr 或原始远端 URL。

起止复核 HEAD、分支、origin、浅克隆状态、仓库路径及元数据指纹，变化时不混合身份。
Git 初次 rev-parse 会查找路径上层的路由元数据；读取 origin/历史前须确认工作树根及
common .git 均在授权内。只授权 src 或单独 linked worktree、未授权其 common .git 时
返回 metadata-outside-grant，不扩大目录权限。

## 调度和缓存

`electron/observe/project-scheduler.ts` 在 S2 授权和 IF-2 归属过滤后接收会话：

- 只探测 user/user-adopted，Worker/Station 和归属待核对会话不进入探测队列。
- 每次扫描最多选择 100 个唯一 cwd，真实路径别名共享探测结果；最多同时探测 2 个目录，
  每次扫描最多启动 4 次。未选择的目录仍显示会话和固定原因，不丢弃会话。
- 扫描仅等待目录与缓存的文件校验，不等待 Git 查询。后台结果在下次扫描投影到界面。
- 候选缓存最多 60 秒，失败/非 Git 结果最多 15 秒；到期后重新排队。
  重试排在尚未探测的目录之后，避免慢扫描下持续重试挤占首次探测。
- 每轮校验 HEAD、当前 loose ref、packed-refs、config、config.worktree、shallow、grafts、
  commondir 及 .git 路由；比较文件 inode/设备/大小/时间和 HEAD 内容。
  分支、远端配置、引用或路由变化会作废候选；子目录新建嵌套仓库也作废父项目缓存。
  其他未覆盖的仓库变化由 60 秒到期重探测兜底，指纹不是安全证明或稳定项目身份。
- 路径消失、链接改指、会话移除或归属变成未知时删除对应缓存；授权变化、撤权和停止
  清空缓存并递增代次。撤权后再授权同一路径，旧结果仍无效。
  旧探测直到退出仍占用并发名额，防止反复撤权绕过并发上限。

ObserveService 在调度前后复核 IF-2 登记版本，版本变化时作废整轮；快照只包含仍获准的
会话。缓存仅存在内存，没有后台写入 registry 或原会话文件。

## 本机界面投影

现有 `observe` IPC 快照新增可选 `localProjects`：候选项目显示 owner/repo、各工作树目录、
分支或分离 HEAD；非 Git、识别中、归属待核对分别展示。已收编标记保留在会话行。
主进程广播去重包含该字段，分支或分组变化不会因会话状态相同而被抑制。

投影只含本机显示键、脱敏标签、工作树本机路径、分支和会话引用；不含原始 URL、凭据、
gitCommonDir、根提交或缓存指纹。目录路径只用于已授权设备的本机界面，不能把整个
快照直接序列化为 IF-7 清单。撤权清空投影，旧版快照仍走已有会话列表展示。

现有 ObservedSession.projectId 路径 SHA1、会议、历史 JSONL、回执和授权记录均保留。
本机候选键不是 Hub projectId/mountId；分组没有执行、收编或分享动作，不继承任何权限。

## 待接线边界

1. 等待 Hub getOrCreate 请求/响应、唯一性错误、alias wire 接口及使用方确认。
2. 接收权威 projectId，绑定独立 mountId；消费未解析、历史冲突及 alias 状态。
   多路径不覆盖，不重写旧历史/回执，不因归并继承授权。
3. S4 新项目通知、执行/分享授权、纳入/忽略/关闭仍待产品确认与独立实现。
4. S6/IF-7 按白名单提取获准稳定 ID 和元数据，不能发送本机路径或临时候选。

IF-7 v0.2 提案见 `docs/plans/2026-11-02-if7-session-inventory.md`。
按接收方及范围版本生成/签名/编号、Hub 原样转发等新增语义仍待 eternal904 确认；
本次未修改生产协议、路由、签名能力或开关。正文建议 96 KiB、完整帧最多 128 KiB；
本地撤权发送失败不能报告远端已删除。#94/#95/#100/#104/#115 不因本提交自动关闭。

## 验证

真实临时 Git 仓库测试覆盖 clone/worktree/子目录、fork、无远端、历史重建、移动目录、
切分支/分离 HEAD、浅克隆、无提交、多根、嵌套仓库/子模块、SHA-256、缺对象、
replace/grafts、只读文件哈希、授权/撤权代次、符号链接、失败脱敏和继承环境隔离。
新增调度测试覆盖去重、并发/启动/目录上限、公平排队、缓存失效和到期、旧任务占位、
路径改指及内部会话过滤。服务测试验证非阻塞扫描、历史 ID 保留和撤权清理。
React SSR 与真实 Chromium 验证项目/工作树/分支、待核对状态、撤权及 800px 布局。

本地验证与 CI 结果记录在 PR #151；CI 不替代 Mac/N5095 真实 CLI 或双机授权验收。
