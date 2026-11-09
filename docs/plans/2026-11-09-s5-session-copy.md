# S5 备份与工作副本准备（#112，部分交付）

基于 #170 的独立增量。本次实现不会把“备份成功”记成“收编成功”：
生产 API 只返回 `state: prepared`，没有新建原生会话、打开终端或写 `user-adopted`。
Codex 新会话能力由隔离的真实 CLI 探针单独验证；完整 S5 仍依赖 #104/#85/#86。

## 已实现

`electron/observe/session-copy.ts::SessionCopyPreparer.prepare(observedId)` 是内部模块，
尚未注册 IPC、按钮或扫描自动动作。未来入口必须由用户明确确认并校验项目收编/执行授权。
当前依赖的扫描只读授权仅允许读取源历史，返回的准备记录不携带任何执行权限。

- 只接受最新扫描中的 Claude/Codex、合法 UUID 原生 ID、归属明确的 user/user-adopted。
  核对 observedId 与客户端/原生 ID，不能传入路径、PID、目标文件名或命令。
- 重新读取 IF-2：worker/station、未知/损坏登记、登记版本改变均拒绝。收编过的源会话
  也必须有匹配的 user-adopted 条目；本模块不修改登记或 launch 状态。
- 从既有有界扫描候选中重新找源文件。相同原生 ID 出现多份（含不同 cwd）一律拒绝；
  没找到不会通过 renderer 路径兜底。扫描窗口外的旧历史目前需用户先使它进入扫描范围。
- 只复制主 JSONL，文件上限 64 MiB；拒绝空文件、符号链接/目录重定向、硬链接、
  路径逃逸及替换。没有复制 Claude 的附件、subagent 目录、MCP、skills、配置或凭据。
  因而不承诺复杂会话的完整可续接性，也不能据此开启 Claude 收编。
- 在当前 profile 的 `sessions/adoption-preparations/<随机 UUID>/` 保存：
  `backup.jsonl`、独立 `native-home` 工作副本和 `manifest.json`。
  目录模式 0700、文件模式 0600（POSIX）；Windows 仍依赖 profile 的系统 ACL，
  不把 POSIX mode 当作 Windows ACL 已验收。
- 原始字节流式复制，固定 256 KiB 缓冲；备份和工作副本不是硬链接。
  写入后 fsync、回读 SHA-256；源文件起止复核设备/inode/大小/mtime/ctime，
  再次读源算哈希，并在落盘审计后再次确认。备份绝不被原生 CLI 用作写入目标。
- 每块及关键异步边界复核授权代次与可见会话；IF-2 在开始和完成时复核。
  撤权后即使重新授予相同目录，旧准备仍失败。源会话持续追加会使准备失败，请用户稍后重试；
  不冻结、锁写、关闭原会话，也不承诺阻止用户进程在返回后继续修改它。
- 所有新文件排他创建；失败清理只处理本次创建且文件身份仍匹配的对象，
  不递归删除意外目录，不影响此前成功备份。清理失败或进程崩溃可留下不完整目录；
  没有成功返回就不能视作可收编记录，后续消费必须重新校验完整清单/哈希/权限。
- 错误只抛固定原因码，不把文件路径、正文、命令或底层 OS 错误传给调用者。
  审计清单保存版本、prepared、准备 ID、客户端、观察 ID、哈希、字节数和时间，
  不额外保存明文路径、原生 ID、标题或正文。备份本身包含原历史，属于本机私密数据。

成功准备会保留到 profile 中，不自动删除旧备份。保留期限、用户删除入口和存储配额
需在接入产品前明确；当前无自动扫描或用户入口，不产生后台备份堆积。

## Codex 真实 CLI 探针

官方依据：[CLI reference](https://developers.openai.com/codex/cli/reference/) 与
[App-server](https://developers.openai.com/codex/app-server/) 的 `thread/fork`：复制已存历史，
返回不同的新 thread ID。真实参数另由 **0.156.1** 生成的 schema 和以下探针验证，
不把当前文档的所有新参数当作旧版本可用。

运行（先 `npm run build:electron`）：

```powershell
node scripts/probe-codex-session-copy.mjs '绝对路径/codex.exe'
```

`scripts/probe-codex-session-copy.mjs` 只生成合成会话，调用准备模块，然后在独立
CODEX_HOME、独立 OS home、空测试项目中启动指定的原生 app-server。
不继承用户配置/凭据/自定义环境，模型 provider 为无认证的 loopback 端口 9；
仅发送 `initialize`、`thread/fork`、`thread/read`，**不发送 turn/start 或模型请求**。
任何服务端审批请求均拒绝。fork 强制只读、无网络，并验证返回权限、不同会话 ID、
forkedFromId、原生落盘路径、历史消息保留、再次读取成功和原始三份文件哈希不变。
探针结束关闭子进程，清理自己创建的临时目录，只输出无路径/无会话 ID 的布尔证据。

本机 Windows 真实 **Codex 0.156.1** 已通过：新 ID、历史复制、持久化 thread/read、
source/backup/input hash 均不变，模型回合数 0、认证请求 0。
PATH 中的旧版本没有被升级，真实用户 CODEX_HOME 和会话没有被使用。
Claude 本轮只验证原文件与备份，不声称已验证其真实 fork/续接。

`tests/observe-session-copy-native.test.mjs` 优先使用显式
`AHASTATION_S5_CODEX_BINARY`，否则只找依赖中捆绑的同平台原生二进制。
缺少原生包时明确跳过，不回退到用户 PATH，也不下载或升级依赖。
运行时仍须满足项目当前 Codex 兼容区间；合成历史探针不能代表全部真实版本/历史格式。

## 后续接线与验收

1. 确认项目级收编/执行授权；扫描授权不能启动 Agent。
2. 按 #85/#86 的原生执行与 IF-2 launch/bind 接口接终端，先登记保守的准备状态，
   原生新 ID 被核实后才标 user-adopted；失败不留下普通 user 的内部会话。
3. Codex 原生 fork 可行，但本轮只在合成隔离 home 中使用。将工作副本导入正式 CLI home、
   文件位置/SQLite 索引、hooks 信任和模型/权限设置仍需原生执行端核验，不能直接搬文件开启。
4. Claude 的真实 fork、新会话 ID、复杂历史/附件及只读/项目授权上限专项验证。
5. 新会话实际就绪后才提示结束原会话；安全关闭需确认、新鲜进程身份/控制权限、退出核验。
   现有按 PID/TTY 结束逻辑未接入本模块，原会话始终不被自动结束。
6. Mac/N5095 真实用户流程、产品视觉和手动验收，随后才可关闭 #112。

本次没有修改 Hub、IF-7、执行/分享授权、原会话文件、旧 resume 流程或全局 CLI 配置。
