# 微信云托管普通桌面 HTTPS/WSS 探针

这是无真实业务数据的独立服务。上传探针源码 ZIP，在微信云托管 `prod` 的**实际环境 ID/地域核实后**新建临时探针服务；构建根目录为 ZIP 根目录，Dockerfile 在根目录，端口 8787，一个实例/worker，允许普通公网访问。仅设置临时随机 `PROBE_TOKEN`，不要使用 Hub/数据库/设备密钥。

运维人员在可信测试机器安装 `probe/requirements.txt`，通过环境变量设置同一个临时 Token（不要放 URL 或命令参数）。

```powershell
python probe/client.py --url https://平台实际测试域名 --seconds 900 --idle 90
```

先检查未带 Authorization 的 WS 被拒绝；有正确 header 时 `/probe/socket` 路径、Upgrade、HTTP health、welcome/heartbeat_ack 应通过。第一次连接完全不发送心跳 90 秒，核对入口空闲超时；随后持续 15 分钟、关闭本地网络后恢复、平台重启/版本切换，观察 reconnects 和 boot_id 变化。再对已确认 DNS/备案/证书及绑定的 `hub.ahastation.com` 执行相同脚本。客户端默认严格证书检查，不能用忽略证书错误验收。

脚本还检查错误凭证的HTTP401和`X-AhaStation-Auth-Error`响应头透传，供产品区别真实撤销与代理403/数据库503/重复连接409；后者不等于取消。普通入口丢失此响应头时应记录并核查，不将断连当授权撤销。

若 HTTP 被要求浏览器确认、测试域名过期/需续期、普通 Authorization/Upgrade 不透传或 WSS 被限制，记录 HTTP 状态、错误类型、平台日志时间（不含 Token），停止正式发布。微信小程序 `callContainer/connectContainer` 成功不能替代本脚本。不同公网入口、防护代理、域名及版本切换需要各自验收。

本机 Windows 回环结果仅验证探针代码；**微信云托管、默认域名时效、自定义域名、两电脑跨网尚待真实验收**。验收完删除临时探针服务和临时 Token；不改动 `ahakey.com`。
