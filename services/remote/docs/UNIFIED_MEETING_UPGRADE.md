# 统一会议 Hub 升级与回退

0.19.0-collaboration.3 的 R1–R4 修复、无新增 DDL、原凭证核验恢复、兼容特性和升级顺序见 [COLLABORATION_3_UPGRADE.md](COLLABORATION_3_UPGRADE.md)。下文保留 .2 历史说明，不替代 .3 匹配要求。

适用 Windows 客户端 0.19.0-collaboration.2。继续复用原微信云托管 Hub、域名、Station 账号和 station_hub MySQL 5.7；“prod”只是当前材料中的生产环境标签，并不表示不能使用它。本包未执行生产发布。

## 升级前

- 保存当前云托管服务版本／镜像和非公开配置的管理端备份。保留原 HUB_SECRET、数据库连接、账号、密钥和设备身份；不要换密钥、清库重建或把凭据放进源码包。
- 通过正常管理控制台确认当前部署及数据库结构版本，备份 station_hub（包含账号、凭据、设备、协作实体、请求去重和事件表），演练恢复。
- schema 已为 2 时，本轮无新增 DDL；participants、planTaskId、planBrief、报告等保存在现有 LONGTEXT 实体内。仍为 1 时先使用随包 mysql57-upgrade 材料，按 MYSQL57_HUB_UPGRADE.md 在 Navicat／受控 DBA 会话执行并核验。应用运行账号继续仅 DML 权限。
- 协作有在途执行时保留原执行设备，不强制杀进程。可用 HUB_MAINTENANCE=1 暂停新接任务和继续，允许已有执行核对、停止、保存结果与重复回执。

## 部署与验证

1. 上传 deployment/ahastation-hub-source.zip，使用压缩包根 Dockerfile（不是外层 Station 目录）构建。根包含 device、contracts/collaboration、web、requirements-public.txt 和 SOURCE-MANIFEST.json。
2. 在已有云托管服务上保留原配置，部署新修订。必要的 schema 迁移应先由有权限操作者完成；不要给应用 CREATE/ALTER 权限。
3. 检查原域名 /health、/ready 返回成功。使用正常 Station 登录验证认证后的 v2 snapshot capabilities 含 unified-meeting-v1；401 只证明未认证路由存在，不能当作功能验收。
4. 两端升级为同版本客户端，再创建统一会议；旧客户端遇到新会议字段会明确返回 426 升级要求。旧 HTTP Bridge／原生串行接口保留。生产发布前应在用户指定隔离项目及两台电脑完成 T01–T45。
5. 恢复接收前确认旧执行已核对、事件补拉和设备身份稳定。维护期间的未接任务保持等待，禁止重派未知执行。

## 回退边界

新统一会议不能直接由旧 SharedCoordinator 消费。禁止只换回旧客户端／旧 Hub、保留新会议数据却宣称无损回退。

- 首选兼容回退：保留同版 Hub 数据协议，关闭新任务接收和自动批准，继续核对／停止现有执行；部署该版本的已知可用修订，或修复回滚代码而保留新字段保护。保留任务、文件、提交和运行时记录。
- 需要回到升级前版本时，先进入维护并确认全部相关执行真实退出／完成；保存升级后增量数据和成果，再在有权限的维护窗口恢复同一时点数据库备份及其匹配的旧服务和客户端。会回退该时点之后的共享元数据，须由操作者明确评估，不能在有在途执行时覆盖数据库。
- 旧适配器、旧账号和原生对话不因本次升级删除或改名。原生对话仍从原设备核对并串行接续。

本轮验证为本机隔离 MySQL 5.7.18 上的迁移保留、SQL 可重复执行、应用 DML 账号、LONGTEXT 数据及真实 HTTP/WSS 回归。没有云端容器构建／重启或生产数据库故障试验记录；缺少测试云环境和正常管理端访问条件，不能宣称部署通过。
