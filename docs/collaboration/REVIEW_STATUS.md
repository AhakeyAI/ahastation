# 分批交付与验证

本页只描述当前分支实际包含的代码。C1 以 AhakeyAI/ahastation 的 main@86a14661df036cbef820c89648acd9dfcd948d36 为基线；etrnal-dev 中的其他协作功能、冻结候选和测试安装包不在本批。

## C1 / #88：Codex 区间与异步凭据

TS、Python、原生接收器、校验脚本与构建资源读取同一份 [Codex 运行契约](../../contracts/runtime/codex.json)：bundled 0.156.1，支持区间 [0.156.1, 0.157.0)。自动兼容调查仅生成候选/失败卡，不自动放宽区间。

remoteControl 与设备凭据通过 Electron 异步 safeStorage 保存/读取，warmSecrets 在启动时预热明文缓存。旧密文格式保持兼容；安全存储失败保留原密文，未加密令牌只在内存中使用。显式清理/账号变化不能被迟到结果恢复。设备凭据调用方与现有回归同步改为 await。

### 开发回归

前置：Git、Node 24、Python 3.13、Electron 45 依赖、Chrome/Chromium。使用独立 Python 环境安装 services/remote 的 requirements-public.txt、requirements-contracts.txt 和 requirements-station-native.txt；可复用本机已验证环境。

PowerShell 示例（按机器实际位置替换 Python 和浏览器路径，不使用生产账号或数据库）：

~~~powershell
$env:COLLABORATION_PYTHON = (Resolve-Path .venv/Scripts/python.exe).Path
$env:POCKET_VIBE_TEST_PYTHON = $env:COLLABORATION_PYTHON
$env:AHASTATION_BUILD_PYTHON = $env:COLLABORATION_PYTHON
$env:STATION_CHROME = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:AHASTATION_TEST_EVIDENCE_DIR = 'C:\aha\c1-verification-new'
npm.cmd run typecheck
npm.cmd run build
node scripts/test-offline.mjs collaboration
node scripts/test-offline.mjs all
~~~

协作命令负责本轮原生接收器构建；源码不变时不要在其前后重复原生构建。npm test 与 npm run test:collaboration 是会先构建 Electron 的便捷入口，不必在上面序列内重复调用。离线入口隔离 HOME/profile、模型凭据、代理及网络，默认不连接真实 Hub。

### 真实 Electron 凭据重启读回

先完成 Electron 构建，再运行：

~~~powershell
node scripts/verify-credentials-electron.mjs
~~~

也可加 --output 指定尚不存在的新目录。该入口生成测试令牌，在独立 profile 下用实际 OS safeStorage 和生产保存/读取函数操作；第一进程写入并落盘后正常退出，第二个不同 PID 的 Electron 45 进程通过 warmSecrets 读回。检查 base64 OS 密文、磁盘无明文、零窗口与零网络请求，不登录、不接入协作，也不读取或覆盖日常凭据。它独立于 #116 的准入实现。

默认结果位于 runtime/t/cred-*；设置证据目录时位于所选目录下。result.json、write.json、read.json 和各自日志记录本轮平台、PID 与实际退出码，不记录令牌。exit 0 = 加密重启通过；exit 2/limited = 系统安全存储不可用，仅内存回退得到验证；exit 1 = 失败。

macOS 在自己的候选根目录安装依赖后直接执行：

~~~bash
npm run typecheck
npm run build:electron
node scripts/verify-credentials-electron.mjs
~~~

Mac 真实凭据重启读回仍待实机验收；Windows 结果不能替代它。本批代码和测试不等于整项 #88 已验收或可以自动关闭。

## 本轮执行记录

2026-11-03 Windows x64 本轮：两侧 typecheck、Renderer/Electron 构建退出 0；实际 Electron 45.1.0 两进程 safeStorage 读回通过，零窗口/零网络、磁盘无明文。定向 56 项中 55 通过、1 个 Mac ARM64 用例跳过。最终完整离线 1,324 项：1,318 通过、6 个平台跳过、0 失败/取消，exit 0。

原生接收器只构建一次；13 组 Python 协作回归共 169 项通过。首次协作 Node 248 项中全文链路旧版本夹具失败；首次全量另有六项测试路径失败。将夹具改为读取同一 bundled 契约、公共路径辅助函数跟随实际 profile 后，受影响 33 项全部通过，最终全量覆盖全部 25 个协作 Node 文件。产品/Python/原生构建的 441 个输入哈希不变，因此复用这轮 Python/构建/OS 结果。保留首次 exit 1 原日志，不将其命令改记为 exit 0。

本轮详细日志保存在独立交付证据目录，不进入安装包；Mac 仍待上述同类入口实测。
