# IF-7 设备会话清单 v0.2（修订提案，待使用方确认）

对应 #95，供 #106 Hub、#116 Station、#115 生成与投影接入。依据
`docs/c0/design/native-cli-worker.md` §8.2/§9.4、ADR 0017 和 #94 的 IF-3 v0.1。
本文件尚未成为生产协议；需要 eternal904 在 #95 确认，IF-3 仍待 He-1102 确认。

## 1. 本次修订与签名边界

v0.1 将多个项目放在设备级流里，同时要求 Hub 按接收方过滤。这有两个问题：
删掉无权项目会改变已签名正文；隐藏整条消息又会让设备级连续 seq 出现假缺口。
v0.2 建议改为**发送设备为每个接收设备及其当前可见范围单独生成、签名和编号**。
这比按项目拆流更接近现有“全量设备清单”的投影，代价是多个接收方需要分别生成消息。
如果改用项目级签名子消息，必须另行约定签名清单及空全量/删除，不能混用两套规则。

消息类型仍建议 `device.sessions`。外层沿用 ADR 0017 的设备签名信封：Ed25519、
规范 CBOR 签名输入、正文 hash、msgId、issuedAt、expiresAt、keyId、发送设备及版本。
下文新增 receiverDeviceId、scopeRevision 与全部正文都在签名覆盖内；Hub 不改正文、
不重编号、不代替发送设备重签。签名尚未接好、授权来源不明或入口关闭时不发送。

发送方只能向本机可信列表里的接收设备生成清单，且必须已经获得当前账号、接收方
可见项目及其 scopeRevision 的可信上下文。该上下文的分发由 eternal904 明确；没有上下文
时不能猜所有同账号设备都有全部项目权限。它不授予执行权或终端查看权。

Hub 核对账号、发布连接、发送设备、目标接收设备、当前范围版本，以及正文内所有
项目的接收权限；任一项目不合法就拒绝整条，不能删掉它再转发。重连快照也只转发
针对该接收设备、仍有效且已签名的原消息。接收方在投影前核验签名、可信设备、有效期、
重放、目标 receiverDeviceId 与范围版本；不能拿另一接收方的签名清单填充本机投影。

## 2. 正文、全量与项目级增量

```ts
type InventoryBody = {
  schemaVersion: 1;            // 草案修订；未发布过生产 schema，不表示已有 v1 可兼容
  deviceId: string;            // 发送/执行设备
  receiverDeviceId: string;    // 本条签名正文唯一目标接收设备（新增，待确认）
  scopeRevision: number;       // 接收可见范围的正安全整数版本；不是执行 grant revision
  streamId: string;
  seq: number;                 // 当前目标/范围流内正安全整数、严格递增
  generatedAt: string;         // UTC ISO-8601；显示用，不用于排序
  full: boolean;
  projects: InventoryProject[];
  removedProjectIds: string[];
};
type InventoryProject = {
  projectId: string;           // IF-3 权威 registry 的 prj_<UUIDv7>
  label: string;               // 获准分享的目录 basename；非会话标题
  shared: true;
  sessions: Array<{
    agent: 'claude' | 'codex';
    sessionId: string;         // 设备、agent 范围内稳定的不透明标识
    origin: 'station' | 'worker' | 'user' | 'user-adopted';
    worktree?: string;        // IF-3 的不透明 mountId，不是路径或相对路径
    branch?: string;          // 获准分享的 Git 分支标签；无分支可省略
    status: 'running' | 'waiting' | 'idle' | 'stopping' | 'disconnected' | 'ended' | 'unknown';
    inferred: boolean;
    taskId?: string;
    attemptId?: string;
    terminalId?: string;      // 仅 station / worker 可带；仍须 U7 独立验权
    lastActiveAt: string;
  }>;
};
```

- 全量：full=true，projects 完整替换 `(deviceId, receiverDeviceId)` 在当前范围版本下
  的可见清单，removedProjectIds 必须为空。projects=[] 是有效清空，不是网络故障；
  接收方把多个发送设备的投影组合展示，不用某一设备全量清空其他设备。
- 增量：full=false，projects 内每个项目都是该项目的**完整替换**，不是会话级 patch。
  删除会话体现在新 sessions 中；删除整个项目放入 removedProjectIds。空 sessions 有效。
  删除 ID 只能属于该流已知且仍允许传输的项目；接收权限撤销走范围失效和新全量，
  不向已失去权限的接收方额外透露项目 ID。
- 重复 projectId、同项目重复 `(agent, sessionId)`、projects 与删除列表交叉，均拒绝
  整条。空增量只推进本流水位。先完整校验再原子应用，不接受半份清单。
- 拒绝未知字段/版本、非法时间、非有限/非安全整数、超限数据；只接受显式白名单。
  taskId/attemptId 必须配对，terminalId 只允许 station/worker，且不能作为授权凭据。
- IF-3 未解析、离线候选、旧路径 SHA1 留在本机，不冒充正式 projectId。
  legacy alias 和正式 registry 的 Hub/Station 迁移仍归 eternal904。

## 3. 范围、seq、重连和补拉

建议 Hub 为已认证发布连接建立的每个 `(deviceId, receiverDeviceId, scopeRevision)`
分配 streamId，并绑定连接代次；发送方将这个绑定签入正文。接收方不能仅因正文出现
陌生 streamId 就切换，还需当前有效绑定及发送方签名的首份全量。范围版本或连接代次
变化都结束旧流；Hub 拒绝旧连接发布，接收方拒绝旧版本与旧流迟到消息。
新增绑定和范围上下文是待确认的协议要求，不是当前 Hub 已实现的 API。

1. 新流从 seq=1 的全量开始。只在完整构造并保留消息后递增；重发保持同一正文、
   seq、msgId 与签名信封。已过期的消息不能靠换 msgId 或重签冒充同 seq 重发，须新生成。
2. 接收方去重以外层规则为先：精确重发只确认、不二次投影。同流增量必须
   seq=lastSeq+1；旧序号不回滚，同 seq 不同正文 hash 是冲突，保持旧投影并要求重同步。
   正文 hash 的规范化沿用签名合同，不自行用 JSON 键顺序定义另一套相等规则。
3. 无基线、跳号、缓存被清空或冲突时不应用增量，标 needsFull。请求建议
   `device.sessions.resync {deviceId, receiverDeviceId, scopeRevision, streamId, afterSeq}`；
   由目标接收设备签名，Hub 验证请求身份与范围，合并同流请求并限频。
4. 当前流的合法全量可跨过缺口，但 seq 必须大于 lastSeq；原子替换后清除 needsFull。
   重同步使用新 seq，不能在旧 seq 上更换正文。新流仍须 seq=1 全量。
5. 发布者重连/重启、Hub 重启、订阅者重新加入或接收范围变化，都建立新流并取全量。
   Hub 可缓存并原样转发当前活动流里仍有效的同目标、同范围签名全量及后续消息；
   一旦发生上述流重置，就必须请求发送方重建，不能拿旧缓存替代新流首份全量。
   不能从一份全账号快照删字段后冒充同一签名快照。
6. 接收权限撤销时先移除相应本机可见投影、结束旧流，再获取剩余范围的签名全量；
   范围变化不是普通丢包。另一接收设备的变化不消耗本流 seq，也不触发本流补拉。
7. 不无限缓存乱序消息。缺口优先全量，不把缺失消息推测成删除或任务结束。

例如：设备 D 向 A 分享 P1，向 B 分享 P2；D→B 的 seq=2 不属于 D→A 的序列。
A 的下一条仍是自身流的 seq=2。若 A 被撤销 P1，立即清除旧范围；发送方为新的
scopeRevision 签发新流 seq=1、projects=[]。Hub 不能拿发给 B 的正文改收件人。

清单 seq 与既有 collaboration event 的 streamId/seq，以及 U7 terminal sequence
分别命名和存储，不复用事件游标。生成时间只用于展示；协调端另记 receivedAt。
离线/缺口标「可能已过期」，不能用本机时间将它恢复为在线；签名已过期的缓存不能
作为新的同步基线或通过重连重放续期。离线旧投影保留多久、过期后是否隐藏，需要产品和
eternal904 确认，生产接线前固定；它不能用于执行或证明当前仍有分享授权。

## 4. 分享授权与元数据边界

- 本机扫描授权只允许只读扫描，不允许跨设备分享。用户须另行选择项目、本机 mount
  和“共享会话元数据”。授权来源是本机可信记录：projectId、mountId、版本与撤权状态。
  Hub binding 或设备在线都不能替代。S4/S6 接好之前生成器保持关闭。
- user/user-adopted 只来自已分享项目和 mount；同项目另一个 clone、worktree 或设备不
  继承授权。station/worker 同样不能绕过项目范围、接收权限与签名入口。
- 来源不能只用 S2 的用户列表，因为它主动排除了 station/worker。S6 须另合并可信 IF-2
  登记与运行时元数据，保留来源，不能重扫内部会话内容。未绑定或归属不明的记录不对外发布。
- 授权变化使旧生成任务失效，发送前再次检查。撤回 mount 后生成该项目完整替换，
  撤回最后一份授权发送项目删除/空全量。发送失败不得确认远端已删除：Hub 的接收权限
  不会自动获知设备上的本地分享撤回；需要后续同步及双方确认的缓存失效策略。
  已传到另一设备的元数据无法追溯收回，不承诺立即擦除所有离线缓存。
- 禁止直接序列化 ObservedSession 或项目候选。不要发送 cwd、repoRoot、gitCommonDir、
  文件路径、命令、prompt、内容、evidence、原始 remote URL、凭据、PID/TTY 或本机授权记录。
- label 只用获准目录 basename，清洗控制字符/秘密；branch 只发显式获准标签，不以绝对
  路径、worktree 名或 prompt 兜底。worktree 填 mountId，不填目录。sessionId 为不透明标识，
  不能作为文件名、恢复命令或执行许可。user/user-adopted 不带 terminalId。
- status 需显式映射：可信 IF-1 优先；扫描证据不足用 unknown，断连用 disconnected。
  idle、task_complete、Stop 和文件变旧均不能推断进程退出或任务验收。两种内部 origin
  的 terminalId 仍须 U7 独立验权。

## 5. 大小、节流与验收

当前代码实际限制：`services/remote/device/public_hub.py::MESSAGE_LIMIT` 是 **128 KiB
整帧**；TS/Python 的 collaboration contract validator 是 **256 KiB JSON**。
v0.1 的 512 KiB 正文与这些限制不一致，不能直接采用，也不能为本提案静默扩大旧通道。

首版建议：IF-7 UTF-8 JSON 正文最多 **96 KiB（98,304 字节）**，最终编码的完整传输帧
（含签名信封及编码开销）最多 **128 KiB（131,072 字节）**。两项都在构造/签名和投影前
检查；96 KiB 不是保证任意信封都放得下的承诺。若复用其他传输，仍取实际通道与合同上限
的较小者，不能仅按解码后正文大小验收。具体编码、限额及错误回执待 eternal904 确认。

同时建议每消息最多 100 项目、每项目 200 会话、标识/标签最多 256 Unicode 字符；
这些是联合上限，满足数量上限仍可能超字节限制。校验器还要约定复杂度上限，不能直接
套用旧合同的 20,000 节点限制后声称支持 20,000 会话。

变化合并 1 秒，普通增量每流最多每秒一次；多接收方还须有每设备总量/背压上限，
由转发方确认。撤权优先。超限拒绝整条，不截断后冒充全量；保留同步失败提示，
在另行确认分页前不能宣称全部会话已同步。新消息类型不复用 U7 内容保存期限。

双方实现后至少验证：

- 首次空全量，项目/会话删除，重复重发，同 seq 冲突，跳号与补拉。
- A/B 可见范围不同，B 的更新不会造成 A 假跳号；改收件人或删除已签名项目会验签失败。
- 发布/接收重启、Hub 重启、旧连接迟到、范围变更及旧签名快照不能恢复被撤销项目。
- 撤权期间旧异步结果、同项目不同 mount 不串权、离线撤权不得虚报远端已删除。
- S2 用户来源与 IF-2 内部来源合并、用户会话无 terminalId、无路径/内容/凭据字段。
- 96 KiB 正文及 128 KiB 整帧边界、Unicode 编码开销、数量/复杂度限制、超限不产生半份投影。
- 生成时间与可能过期显示、无可靠证据保持 unknown、双机真实签名链及 Mac/N5095 实测。

## 待确认与交付边界

eternal904：目标接收方隔离方案、scopeRevision 可信来源、Hub stream 生命周期、
原样转发与重同步请求、权限撤销、缓存有效期、实际信封编码、字节/复杂度/总流量上限。
He-1102：IF-3 未解析消费、可能过期及超限显示、S4/S6 显式分享授权与离线缓存展示策略。

这次仅修订合同文档；没有修改 Hub/Station schema、路由、签名实现或生产开关。
新增字段与生命周期未经确认，不关闭 #94/#95/#100/#115，也不声称已经完成 S6。
