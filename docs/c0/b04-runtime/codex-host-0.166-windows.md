# Windows Codex Host 0.166.0 接线验证（2026-11-04）

## 触发与修复

用户提供的原生终端截图显示 Codex `0.166.0` 以 `gpt-6.1-sol` 回复成功，
同一窗口的 Host 却返回 `model_not_found`。本地检查发现 Host 的解析器优先选中
内置 `0.156.1`，原生终端使用 PATH 中 npm 安装的 `0.166.0`。这证明运行时不一致，
尚不能单凭这两项证据认定全部服务端拒绝均由版本引起。

Host 现在优先解析本机 CLI；Windows npm `codex.cmd` 解析为其同安装目录下的
原生 `codex.exe`，不将批处理文件传给 CreateProcess。无可用本机运行时才寻找
原有内置可执行文件。启动时仍由 app-server 版本门槛检查兼容性。

版本门槛保留原 `>=0.156.1 <0.157.0`，仅在 Windows 增加精确 `0.166.0`。
不接受 `0.166.1`、预发布版或 macOS/Linux 的 `0.166.0`。模型拒绝提示不再猜测
账号只支持 gpt-5.x，也不默认建议改用 API key；应比较 CLI、配置、账号，
并以同一原生 CLI 的 `/model` 目录为准。没有修改 Codex 引擎、个人全局配置、
登录方式或用户模型选择。

## 已执行证据

- 使用本机 npm 安装的 Windows x64 `codex.exe`，`--version` 返回 `codex-cli 0.166.0`。
- 在自建临时目录设置独立 `CODEX_HOME`、`HOME`、`USERPROFILE`、`TEMP`、`TMP`，
  执行 `app-server generate-json-schema --out <fixture>/schema`。
- 同样隔离环境中实际执行 stdio `initialize`、`initialized`、
  `account/read { refreshToken: false }`；返回运行时 `0.166.0`、平台 Windows、
  `account: null` 与 `requiresOpenaiAuth: true`，没有个人登录态。
- 用 Ajv 对该可执行文件生成的 `ClientRequest.json` 校验六类 Host 请求：
  `initialize`、`account/read`、`thread/start`、`thread/resume`、`turn/start`、
  `turn/interrupt`，全部符合 Schema。后四类仅做本地校验，没有发给真实 CLI。
- 五个相关测试文件共 54 项：53 通过、1 项 macOS 专用 fixture 跳过。
  包含原生路径优先、Windows npm shim、版本/平台门槛、模拟会话生命周期、
  模型参数继承和错误提示。
- renderer 与 Electron 类型检查、`npm run build` 通过。

本次本地原始证据目录为 `%TEMP%\ahastation-codex0166-contract-Hug4to`，
其中包含 `schema/`、`rpc-handshake.json`、`request-schema-checks.json`；
该临时目录不随源码分发。

## 验收边界

以上为协议形状、隔离握手和模拟回归证据；不等于真实登录账号下 Host 模型回合
验收，也不等于 Worker 任务交付验收。本轮没有自动发送真实模型提示词。
重启后的 Host 仍需用户重试一条消息，确认不再出现原拒绝并正常收到回复。
