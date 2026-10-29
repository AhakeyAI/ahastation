> collaboration.6：schema2 上还需新增文字 manifest/chunk 两张表。保留既有01—03，随后执行04、05；06只做保留数据回退核对，不删除新表或恢复旧数据库覆盖新业务。运行账号继续DML。配套步骤见 services/remote/docs/COLLABORATION_6_UPGRADE.md。

# 复用 station_hub：MySQL 5.7 兼容核验与 Hub 升级

日期：2026-10-21。适用于候选版 0.19.0-collaboration.1。

## 1. 已经核验的结论

新版 Hub 不要求先把数据库升到 MySQL 8。已使用 Oracle 官方 MySQL Community Server 5.7.18，在本机隔离目录、回环端口、真实 InnoDB 上完成下列验证：

| 核验 | 结果 |
| --- | --- |
| 原 Python 迁移程序，从 schema1 到 schema2 | 通过，原账号、有效凭证和设备保留 |
| 新版 Hub 的生产 HTTP/WSS 协作测试 | 8 项通过 |
| Node 协作测试，包含两 Station 服务接收／重连 | 7 项通过，无跳过 |
| 本文提供的 Navicat 增量 SQL | 通过，全部旧表行数据及原凭证保留 |
| 新增表明确使用 DYNAMIC，服务默认 COMPACT | 通过，无需修改服务器默认行格式 |
| 原联合索引在 COMPACT 默认、large_prefix 关闭的单独探测 | 均接受；不能把联合长度相加后直接断定超限 |
| 脚本重复执行 | 通过，不清空原表 |
| 缺表或未知 schema 版本 | 不误提升／覆盖版本 |
| 只有 SELECT/INSERT/UPDATE/DELETE 的应用账号 | ready、设备注册、快照和限流写入通过，CREATE 确实被拒绝 |

MySQL 5.7 兼容本身无需修改 Hub 的数据库代码。随后根据云端启动日志，另修复了浅层目录的契约加载缺陷；发布请使用 release/collaboration-candidate/hub-startup-fix/ahastation-hub-source.zip，旧 deployment 目录的包保留作故障证据，不再上传。Windows 安装包无需因此重建。

测试服务器未注册 Windows 服务，未连接或修改云端数据库。官方 5.7.18 不是腾讯云 5.7.18-cynos-log 的同一二进制；云端参数、权限和实际升级仍需按下面步骤确认，不声称已完成云端实测。

驱动／SQL 审查：使用 SQLAlchemy/PyMySQL，采用 InnoDB、utf8mb4_bin、LONGTEXT、普通事务／SELECT FOR UPDATE 和 ON DUPLICATE KEY UPDATE；新增路径未使用 MySQL 8 专有的 CTE、窗口函数、JSON_TABLE、0900 排序规则等特性。SQLAlchemy 的官方支持范围包含 MySQL 5.7：[文档](https://docs.sqlalchemy.org/en/20/dialects/mysql.html)。

## 2. 准备文件

- 上传到微信云托管的是 release/collaboration-candidate/hub-startup-fix/ahastation-hub-source.zip。
- Navicat 使用下面三份升级文件，必须依次分开运行：
  1. [01-preflight.sql](../../services/remote/deploy/mysql57-upgrade/01-preflight.sql)：只读检查。
  2. [02-create-collaboration-tables.sql](../../services/remote/deploy/mysql57-upgrade/02-create-collaboration-tables.sql)：仅增加四张表，不改版本。
  3. [03-verify-and-set-schema2.sql](../../services/remote/deploy/mysql57-upgrade/03-verify-and-set-schema2.sql)：核对表、字段和主键后，再把版本从1改为2。

不要把完整升级材料 ZIP 上传成云托管源码包；源码包的根目录必须能直接看到 Dockerfile、device、deploy 和 contracts。

## 3. 暂停工作并备份

1. 确认所有 Station／Bridge 任务真正完成或停止，然后显式退出相关接收端，避免迁移时继续发起工作。关闭窗口可能只是后台运行。
2. 记下现有服务版本及环境变量，私下安全保存，尤其是原 HUB_SECRET；本次保持原值，不重新生成。
3. 在 Navicat 打开原数据库连接，右键 station_hub，选择“转储 SQL 文件 → 结构和数据”，保存完整 SQL 备份。确认导出成功且文件有内容。
4. 如果平台有数据库备份／快照入口，同时建立可恢复备份。

备份菜单参考 [Navicat Windows 官方手册](https://www.navicat.com.cn/manual/pdf_manual/cn/navicat_16/win_manual/navicat_cs.pdf)。只备份 station_hub，不操作同实例内其他业务库。

## 4. 在 Navicat 进行只读检查

1. 双击打开 station_hub。
2. 使用能够在 station_hub 内建表的管理账号连接。可使用原有 root 作为本次数据库管理身份，不把 root 配成 Hub 应用账号，也不需要新建第四个账号。
3. 右键 station_hub → 运行 SQL 文件，选择 01-preflight.sql；也可新建查询后打开该文件运行。
4. 查看结果：
   - VERSION() 为实际云端版本；早期截图是 5.7.18-cynos-log，以本次查询为准。
   - hub_schema 中 id=1、version=1：可以按本流程迁移。
   - 原 hub_* 表均应为 InnoDB。
   - 记录原账号、设备、凭证和任务数量。
   - 记录行格式、文件格式和页大小参数，不在该脚本中修改全局设置。
5. 如果已经 version=2，且四张 collab_* 表完整，可跳过建表和版本更新，转到发布新版 Hub；缺表、不认识的版本或非 InnoDB 情况先核对，不能清库重建或强行改版本号。

本地实测参数是 16 KiB 页、Barracuda，默认行格式 DYNAMIC；另测 COMPACT 和 large_prefix=OFF。若云端页大小、引擎或 DYNAMIC 支持不同，需要根据实际错误核查，不能保证所有定制参数组合均已覆盖，也不修改整个云数据库实例的全局参数来试验。

## 5. 增加四张新表，再提升版本

1. 在 Navicat“运行 SQL 文件”窗口，关闭“遇到错误时继续”。
2. 对 station_hub 运行 02-create-collaboration-tables.sql。
3. 必须没有 SQL 错误，末尾查询显示四张表：
   - collab_accounts
   - collab_entities
   - collab_events
   - collab_requests
4. 四张表应为 InnoDB、Dynamic、utf8mb4_bin。此时 hub_schema 仍为1。
5. 再单独运行 03-verify-and-set-schema2.sql。
6. 结果应为 compatible_tables=4、compatible_columns=14、compatible_primary_keys=4，最后 id=1、version=2。
7. 在 Station 重新登录前核对旧表数量；迁移本身不应减少或改写旧账号、设备、凭证和任务。

第二个文件不更新版本；第三个文件有结构保护。遇到错误停在当前步，不继续发布、不删除旧表，也不导入 deploy/schema-v2.sql 的整库初始化内容。MySQL 的 CREATE TABLE 等 DDL 不能依靠外层事务完整回滚。

原表若使用 COMPACT，不要求把它们全部改成 DYNAMIC；本次只给四张新表明确指定行格式。

旧 Hub 只接受 schema1。版本变成2后到新 Hub 就绪之前，旧版本的 ready 可能失败，这是本次维护窗口；请准备好部署包后连贯完成迁移和发布，不能把这一期间的 ready 失败误当成数据库坏了。

## 6. 继续使用原 Hub 应用账号

原应用账号若已经拥有 station_hub.* 的 SELECT、INSERT、UPDATE、DELETE，这些库级权限会覆盖新增表，不用另建账号。

如果原服务 MYSQL_USER 仍是 ahakey_web，但该账号缺少本库应用权限，可由管理账号执行：

~~~sql
GRANT SELECT, INSERT, UPDATE, DELETE
ON station_hub.*
TO 'ahakey_web'@'%';
~~~

仅在确认原账号及主机范围确实是上述值时使用；否则替换为控制台已有账号的准确身份。不要重置该复用账号的密码，以免影响它原来服务的其他应用。

Hub 长期运行继续使用原非 root 账号，不需要 CREATE、ALTER、DROP 或全局权限。Navicat 管理账号和 Hub 应用账号是不同用途。

## 7. 在微信云托管更新原服务

1. 登录微信云托管控制台，选择原环境和原 ahastation-hub 服务。
2. 点击发布，选择手动上传代码包，上传 ahastation-hub-source.zip。
3. 填写：

| 项目 | 值 |
| --- | --- |
| 服务监听端口 | 8787 |
| 目标／构建目录 | . |
| 有 Dockerfile | 是 |
| Dockerfile 名称 | Dockerfile |
| WEB_CONCURRENCY | 1 |
| 实例配置 | 一个实例常驻，最小／最大实例数均为1 |
| 版本流量 | 新版本就绪后100%流量到新版本，不同时分流给旧版 |

4. 原环境变量继续保留：

| 环境变量 | 如何填写 |
| --- | --- |
| MYSQL_HOST／MYSQL_PORT | 原 Hub 使用的云数据库内网地址和端口，不换成 Navicat 的公网域名／转发端口 |
| MYSQL_DATABASE | station_hub |
| MYSQL_USER | 原应用账号，例如经核实的 ahakey_web |
| MYSQL_PASSWORD | 该应用账号现有密码 |
| HUB_SECRET | 原来完全相同的值，不重新生成 |
| PORT | 若原来手动设置，则保持8787，与服务端口一致 |

5. 保留原服务域名、证书及其他仍适用配置，提交发布并检查构建／启动日志。不要创建新数据库来处理 404。
6. 新版启动会检查 schema2 和 InnoDB；不会自动替你迁移数据库。

常见错误：root 应用账号被拒绝、数据库密码填成另一账号密码、把内网端口写成 Navicat 公网端口、遗漏原 HUB_SECRET、未迁移就发布，以及上传了外层材料 ZIP。

## 8. 验证升级

在原服务地址后依次打开：

~~~text
/health
/ready
/api/collaboration/v2/snapshot
~~~

- health 与 ready 应为200且 ok 为 true。
- 浏览器未登录访问新 snapshot，预期401，说明路由已存在且正在校验身份；不要求未登录时返回 ok。
- snapshot 仍404：核对访问的服务、上传源码、线上版本及流量，不能通过重建 MySQL 修复缺少路由。
- ready／启动失败：先看日志，区分 schema 版本、缺表、权限、连接地址和密码。

随后两台 Station 使用原服务地址、原协作账号正常登录。检查设备注册、WSS 和共享会议，再运行双机任务测试；浏览器401不能代替这一步。

## 9. 失败处理和回退边界

- SQL执行中途报错：不运行后续版本提升，保留原数据和错误。建表已成功的部分可能仍存在，DDL不会整批回滚。
- 新 Hub 构建／启动失败：优先依据日志修复并重新发布；原表数据和 HUB_SECRET 保留。
- schema 已是2，不能直接切回只支持schema1的旧镜像，不能只把 hub_schema.version 改回1。需要兼容schema2的回退版本，或在确认影响后按备份恢复；本说明不自动进行回退。
- 不向 Station 分发数据库密码、HUB_SECRET 或 Navicat 配置。

## 10. 可复现核验

~~~powershell
python scripts/rehearse-collaboration-mysql.py --mysql-base <官方MySQL5.7.18解压目录> --output runtime/mysql57-compatibility --navicat-upgrade-checks
~~~

脚本仅创建自有本机回环 MySQL，核对实际数据目录后才改动；不注册系统服务、不读取云端连接配置。只给自己的 fixture 数据库做可重复破坏性测试，结束时关闭所属进程。

官方包来源：https://cdn.mysql.com/archives/mysql-5.7/mysql-5.7.18-winx64.zip
下载字节数：331427935。
本次下载 SHA256：6a3b2d070200ae4e29f8a08aceb1c76cca9beccb037de4f5ab120d657e781353。

第一轮普通迁移及生产接口测试通过。补充脚本最初错误地假定联合索引在COMPACT下必然超限，导致一次测试断言失败；随后改为真实记录数据库接受结果，未修改Hub生产源码，完整补充核验通过。失败记录保留，不把测试断言错误说成已发现或修复产品缺陷。
