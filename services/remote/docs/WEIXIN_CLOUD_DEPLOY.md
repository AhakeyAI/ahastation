# 微信云托管：ahastation-hub 源码云端构建

本指南对应 [微信云托管控制台](https://cloud.weixin.qq.com/)；不是通用 CloudBase，未使用 tcb CLI、微信专属 SDK、callContainer/connectContainer 或腾讯 CloudBase 菜单替代桌面验收。本机不代用户部署/购买/修改 DNS，也不改动 `https://ahakey.com/`。2026-10-12 用户确认平台已构建并推送镜像，但源码权限导致容器启动失败；这不是运行验收通过。

## 部署前需核实

已有环境显示名 `prod`，真实环境 ID、地域、资源和权限需在实际控制台核实。服务名 `ahastation-hub`，期望正式域名 `hub.ahastation.com`；**未确认注册、备案、DNS权限、证书或已部署地址**。本机未装 Docker，未进行 Docker 构建，使用平台上传源码云端构建。不要把文档示例域名配置成已连接服务。

先上传 `ahastation-wss-probe-source.zip` 为独立临时服务，依 [probe/README.md](../probe/README.md) 验证普通桌面 HTTP/WSS、Upgrade、路径和 Authorization、空闲/持续心跳、断网重连及版本重启。保存实际测试域名限制/有效期/续期/浏览器确认及云端证据。入口不支持普通 WSS 时停止正式服务发布并报告证据；小程序示例成功不算桌面成功。

## 独立 MySQL 与初始化

在微信云托管本环境 MySQL 管理和账号管理确认版本（要求兼容 MySQL 8/InnoDB，utf8mb4）、内网 host/port、独立库创建能力、连接配额、备份恢复入口。只在获得具体授权后创建 `station_hub`，不得改其他业务库。

用管理权限建立独立 schema 和迁移账号；SQL 示例由运营者在 MySQL 管理工具执行，密码自行生成并保密：

运行依赖包含 MySQL8 caching_sha2_password 的 RSA 认证依赖，见 [PyMySQL 官方说明](https://github.com/PyMySQL/PyMySQL#installation)。若环境提供 MySQL TLS/CA，设置 `MYSQL_SSL_CA` 为运营者配置的证书路径并严格核验服务身份；内网地址/版本/认证方式必须按实际管理面板核实，不能通过改回弱认证来通过测试。

```sql
CREATE DATABASE station_hub CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
-- 账号按平台提供的账号管理/来源限制创建，避免应用使用 root。
-- 迁移账号仅 station_hub.* 的 CREATE/ALTER/INDEX/SELECT/INSERT/UPDATE。
-- 初始化后 station_hub_app 只授予 station_hub.* SELECT/INSERT/UPDATE/DELETE。
```

执行包内 `deploy/schema-v1.sql`（仅在空 station_hub）或使用迁移凭证运行 `python deploy/migrate.py migrate`。`check` 只读 schema版本，启动不自动建表/降级；`ddl` 可审查生成 SQL。版本1没有后续ALTER，未来迁移先备份、逐版执行，不对未知version自动覆写。应用username=root会被拒绝。长期应用账号不授予全局库权/DDL/账号管理。

只把实际内网 MySQL 地址和 `station_hub_app` 密码设置在 Hub 服务环境：`MYSQL_HOST/PORT/DATABASE/USER/PASSWORD`，兼容微信官方模板的 `MYSQL_ADDRESS/MYSQL_USERNAME`。数据库凭证不发给 Station/Bridge。随机生成并离线安全备份 `HUB_SECRET`（至少32字符，建议 `python -c "import secrets; print(secrets.token_urlsafe(48))"` 在可信运维机）；换 secret 会使所有凭证/配对/恢复码校验失效，需要新身份恢复或配对，不能当作普通滚动配置。

## 上传、构建、发布

在仓库实际工作树运行 `python scripts/package_hub.py --output runtime/deploy`。它显式导出当前未提交及未跟踪必要代码和 SHA256清单，不是 Git 历史 archive。ZIP根目录 Dockerfile/.dockerignore/requirements-public.txt/device/web/deploy/docs，绝不包含 .git/.venv/node_modules/.env/用户项目/runtime/真实密钥。检查清单后上传。

1. 在核实后的 `prod` 环境新建开启**普通公网访问**的服务 `ahastation-hub`，上传源码ZIP，构建目录=解压根，Dockerfile=根目录 `Dockerfile`；不要误选包含 ZIP 的上级目录。官方模板说明参考 [WeixinCloud/wxcloudrun-express](https://github.com/WeixinCloud/wxcloudrun-express)，模板 `container.config.json` 不等于手工部署所需配置。
2. 端口8787/监听0.0.0.0；Dockerfile Python3.13.5 固定标签和依赖pins、非root UID10001，一个Pythonworker。云端镜像拉取/CPU架构与依赖安装结果需查看实际构建日志，当前未构建容器。若平台不允许 HEALTHCHECK，配置实际HTTP健康路径 `/health` 和数据库就绪 `/ready`；后者数据库失败不报就绪。
3. 服务环境按 `deploy/hub.env.example` 替换占位项，`WEB_CONCURRENCY=1`、`HUB_FEEDBACK_DAYS=7`、`HUB_MAINTENANCE=0`；BRIDGE_DOWNLOAD_URL只填自己已经发布且验收的HTTPS交付地址，当前留空。禁止公网使用旧POCKET_VIBE_TOKEN/TOOL_TOKEN开发值。
4. 通过当前控制台真实资源/扩缩容选项设置常驻、最小=最大=1、单实例，从环境支持的小规格测试并监控调整。具体套餐能力和开关名称需本环境确认；不要猜容量。**单版本100%流量**，禁止新旧版本随机分流/多实例，即使MySQL已持久化也没有分布式设备连接路由。
5. 首次云端构建成功后先检查构建日志及运行标准输出、health/ready，再执行普通桌面探针/身份配对隔离验收。公开入口交给应用自身身份鉴权，不要求微信客户端认证。检查平台是否过滤 Authorization 或 Upgrade，并核实WS最长/空闲时长、实例发布断连及常驻策略。
6. 运营正式域名确认注册/备案/权限/匹配证书后按该服务的自定义域名入口完成域名校验、HTTPS证书和平台给出的DNS/CNAME；不要猜CNAME或动ahakey.com。证书应覆盖hub.ahastation.com，无重定向丢Authorization或WSS路径。DNS生效后对正式域名重复探针与真实桌面配对任务。
7. 将通过验收的地址写入 Station `resources/remote-service.json` 和 Bridge `build_bridge.py --service-url` 运营构建入口；高级自托管可覆盖。发布安装包本轮未获授权，文件仅本机准备。

默认公网域名只供测试，平台实际有效期、确认页和续期限制由部署时记录；不能正式推广。普通公网没有微信私有调用链路的防刷/DDoS能力，自定义域名/HTTPS不自动提供该防护。应用限流/隔离只是应用层；正式推广前核查入口网络防护容量、WSS透传、超时、费用和日志。若接入第三方防护，重新验收WSS和授权头；不擅自购买。

## 监控、备份和维护更新

查看微信云托管实际构建日志/运行日志、服务请求状态/连接及CPU/RAM/流量、MySQL连接/慢查询/容量/备份任务。应用只记录方法耗时、连接断开和数据库故障，避免Token/密码/敏感请求。限额/保留见 [协议说明](PUBLIC_REMOTE_CONTROL.md)。费用从当前环境服务/构建/公网流量和MySQL账单入口核查，测试额度不表示正式免费，套餐/赠送/续费以实际账单为准。

备份使用平台本库备份/导出或受限备份账号 `mysqldump --single-transaction --databases station_hub`（密码配置安全文件，不放日志/命令）；加密离线保存schema版本、应用版本/source-manifest、HUB_SECRET/配置。定期在**独立恢复库**恢复并验证账号/设备/key墓碑/反馈/取消状态；不覆盖现有业务。容器本地文件不是备份。

发布/回滚：暂停新任务HUB_MAINTENANCE=1 → 等现有任务退出并收ACK，或记录仍执行/取消未确认并安全请求取消 → 留存DB和配置备份 → 停旧连接入口/确保单版本 → 更新兼容版本 → ready通过 → Bridge重连核对收据和结果/取消，交付未知不重派 → 核查设备/目录 → 恢复接收。数据库不能随便降schema；不兼容迁移需备份恢复及明确不可同时运行的窗口。回滚同样单实例单版本，不能为恢复流量把未确认任务标完成。

## 普通Linux服务器迁移

解压同一个源码包，在通用Linux Docker环境将示例env复制为私有 `deploy/hub.env` 并设置外部MySQL，使用 `docker compose -f deploy/compose.yaml up --build`；绑定仅127.0.0.1:8787，前置受管HTTPS反代需Authorization/Upgrade、足够WS时长和心跳。不依赖微信SDK。迁移先按维护流程处理任务→导出独立库/保密key配置→新机同版schema恢复→服务单实例ready→固定域名/DNS切换→Bridge退避重连核对任务→补交结果/取消→恢复接收。DNS短时缓存、WS断连和TLS证书需实测，不能承诺只改DNS全状态恢复。保留DB+secret+固定URL可保留凭证，缺任一需身份恢复/配对；跨owner换服务不会自动上传旧反馈。回滚保持只有一个环境接受任务，避免两处相同会话并行操作。

当前云端操作待授权及真实环境ID/地域/配置、MySQL内网账户、域名DNS/备案/证书条件；在最终可审查ZIP准备后再提供具体待批准动作，本轮不自行部署。

## 2026-10-12 源码权限修复与重新上传

已确认启动错误 `python: can't open file '/app/device/public_hub.py': [Errno 13] Permission denied`：旧 ZIP 普通文件默认0600，Docker COPY后归root，USER hub无法读取。导出器现在为全部条目声明Unix权限，普通源码/生成清单/根Dockerfile/.dockerignore均0644，若有显式目录则0755；Hub与WSS探针共用此函数并保留原白名单及DEFLATE压缩。

Hub Dockerfile在USER hub前将/app目录规范为0755、普通文件0644，兼容上传解压后的权限变化。源码继续root所有、hub只读；不改数据库、认证、端口、启动命令或健康检查。未凭 `/app/cert/initenv.sh` 生命周期报错推断另一个故障，不改成root运行。

本次包位于 `runtime/source-permissions-2026-10-12/ahastation-hub-source.zip`。重新上传时填写：**端口8787、目标目录`.`、Dockerfile名称`Dockerfile`**；ZIP根目录就是构建上下文，无额外顶层文件夹。根Dockerfile与deploy/Dockerfile字节一致。保留当前数据库/密钥配置，核对云端新构建日志和启动日志，再检查health/ready。本机无Docker，未执行容器构建或hub用户容器内读取/启动验收；修复后平台运行结果待用户重新上传验证，不代发布。
