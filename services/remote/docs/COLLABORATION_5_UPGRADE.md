# collaboration.5 / Q108–Q112 升级与回退

本版 Station 0.19.0-collaboration.5 与同包 Hub 配套，新增特性 unified-hardening-v1，保留 unified-meeting-v1、unified-review-fixes-v1、unified-stability-v1 和旧 Bridge／原生接口。

## 数据与部署

**schema=2 无新增 DDL**。沿用 MySQL5.7 的 station_hub、原 LONGTEXT 实体、事件与 collab_requests 表。无需运行账号获得建表权限，不换 HUB_SECRET，不清库，不轮换密码或注册全部设备。SQL 文件与 .4 保持一致；仅 schema=1 的原库按随包 MySQL57 指南备份并做既有幂等升级，不能把它当本版新增迁移。

1. 受控备份原数据库、HUB_SECRET、非公开环境配置和各设备 collaboration 本机记录。私密配置不在发布 ZIP 中。
2. 使用 Hub ZIP 根目录 Dockerfile 和固定依赖构建；维持原数据库连接、域名、密钥与 HTTPS/WSS 设置。先在隔离配置验证 lifespan、health/ready、正常登录、原设备、历史与收据。
3. 升级执行／协调设备到 .5，再开放新工作。原执行未知时留原设备核对，不改派、不重建会议。旧 Station 读到新轮次字段时 Hub 返回明确 426，旧凭据不会因此失效；升级后继续原身份。
4. 本任务仅交付包和隔离演练，不发布生产或修改云端配置。实际容器构建／公网结果以交付报告记录为准。

## 兼容与恢复

新增只读 GET /api/collaboration/v2/message-receipts?requestId=原提交（另保留 /{requestId} 形式），按当前设备＋原提交查 collab_requests 的既有成功结果；不执行原命令、不解出注册凭据、不新写事件。旧成功回执缺 submissionId 仍可核对。匹配部署包中的 v2 契约定义 messageSubmissionReceipt，原 messageReceipt 命令契约保持原义。

本机升级读取原 outbox／messageSubmissions。已确认的请求不被迟到错误降级；原 submissionId＋sourceDeviceId 同步消息也可确认。旧 pending＋messageId＋空 outbox 优先核对原快照，再只读原请求收据；仅有 messageId、digest 或空正文不构成重发依据。没有可靠证据时保留原因与核对入口，不伪造成功或新建请求。原命令存在才按原 requestId 和冻结内容补投。

停止意图、turnOutcome、后续执行准入和交付分别管理。正常结束证据允许原授权成果继续交付，停止后不新启动模型或测试；真实中断仅同步已有事实，部分文件留本机，不自动新增提交／推送／PR；未知结果继续核对，不能默认退出或发布许可。旧记录缺字段不作为正常结束证据。原生 journal 保留实际轮次结果、退出码和退出证明，旧幂等与历史保留。

原卡“重新核对”与后台使用同一执行身份，慢调用不在公共 pump 中等待；同执行重复操作合并，有界辅助进程并发，未知资源占用保持。最近错误成功恢复后收起，原核对记录保留。交付失败只保留交付待处理，不重跑模型。

## 回退

保留 .3／.4 冻结包和本版源码、证据。新轮次字段进入 Hub 后不能直接将活跃执行设备降到不识别它们的旧版；先关闭新接收，原设备完成／停止并核对执行与在途 Git，再选择匹配的 Station／Hub 版本。数据库无需逆向 DDL。必要时按运维流程从同一时点备份恢复数据库及配套设备记录、原密钥；恢复备份会涉及之后新数据，必须由运维明确安排，不自动回滚 Git 或删除文件。优先修复前进而非用旧程序重放未知执行。

正常结束且已回传的非代码成果，用户可在原入口明确手工检查和最终验收，不要求为此重跑模型或新开测试。停止意图和原attempt保留；只有已核验的真实正常成果才可供原获准依赖使用，未知／中断／未核验仍等待。代码组合测试不会借此获得停止后的新启动许可。

Station最终补核包含H07账号迁移代次隔离：切换期间原输入草稿保留，旧账号加载／探测／注册与重新接入回调不得覆盖新账号；原pending消息继续保存在原账号档案，不转投其他服务。该补修无Hub表结构或凭据变更。最终Node与安装器证据见交付verification；MySQL与真实模型证据分别来自本轮短路径隔离联测。
