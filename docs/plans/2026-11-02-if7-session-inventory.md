# IF-7 设备会话清单 v0.1（待使用方确认）

对应 #95，供 #106 Hub、#116 Station、#115 生成与投影接入。依据
`docs/c0/design/native-cli-worker.md` §8.2/§9.4、ADR 0017 和 #94 的 IF-3 v0.1。
这是合同提案，不表示 Hub 已支持新消息、共享授权已实现或 #95 已完成。
完成仍需 eternal904 在 #95 确认；IF-3 仍待 He-1102 确认。

## 1. 信封与范围

消息类型建议 `device.sessions`，正文为下文的 schemaVersion 1。外层沿用
ADR 0017 的设备签名信封（Ed25519、规范 CBOR、正文 hash、msgId、issuedAt、
expiresAt、keyId、发送设备及版本），不自造 JSON 签名或未签名降级入口。
签名、可信设备、有效期、去重和版本检查在应用投影前完成。
入口关闭或没有可用签名能力时不发送；不以此提案开启跨设备入口。

Hub 必须核对设备所属账号、连接身份与正文 deviceId；订阅方也必须具有该项目的
查看权限。只在执行设备过滤不够，Hub 的转发与重连快照也必须做接收方范围过滤。
清单不是任务派发、目录授权、执行准入或终端查看许可。

## 2. 全量与项目级增量

```ts
type InventoryBody = {
  schemaVersion: 1;
  deviceId: string;
  streamId: string;
  seq: number;                 // 正安全整数；同一 stream 严格递增
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

- 全量：`full: true`，projects 完整替换该设备当前可见投影，removedProjectIds 必须为空。
  `projects: []` 是有效的清空，不表示网络故障。
- 增量：`full: false`，projects 中每个项目都是该项目的**完整替换**，不是会话级 patch。
  被删的会话自然消失；删除整个项目放入 removedProjectIds。项目不能在两处同时出现，
  重复 projectId 或同项目重复 `(agent, sessionId)` 拒绝整条消息。
- 空 sessions 是有效项目；空增量不改变清单。任何消息都先完整校验，再原子替换投影，
  不先应用有效的前半条。拒绝未知版本、非有限数字、非安全整数、非法时间及超限数据。
- IF-3 未解析、离线候选、旧路径 SHA1 不能写进 projectId；留在本机。Hub/Station 的
  legacy alias 迁移由 eternal904 负责，不在扫描侧新建第二个权威 registry。

## 3. seq、重连和补拉

建议 streamId 由 Hub 在**已认证的设备发布连接建立时**分配并绑定该连接代次。
同设备新代次替代旧代次，Hub 拒绝旧连接继续发布。接收方只接受 Hub 当前绑定的代次，
不因正文中任意新 streamId 就切换。该字段及连接生命周期需要 eternal904 确认。

1. 新 stream 从 seq=1 的全量开始。序号只在发布者完整构造并保留消息后递增；
   重发同一条消息保持 streamId、seq 和正文不变。
2. 同 stream 下，只有 `seq = lastSeq + 1` 的增量可应用。旧序号不得回滚；
   同序号同正文为幂等重复，同序号不同正文为协议冲突，保持旧投影并要求重同步。
3. 收到跳号增量、无基线增量或缓存被清空：不应用增量，标记 `needsFull`，
   请求当前设备重新生成全量。请求建议 `device.sessions.resync {deviceId, streamId, afterSeq}`，
   沿用已认证/已验签控制通道；按设备合并并限制请求频率。
4. 当前 stream 的合法全量可跨越 seq 缺口（必须大于 lastSeq）；全量原子替换、
   清除 needsFull，然后按新 seq 接收增量。重同步生成**新的** seq，不能在旧 seq 上改正文。
5. 重连一律换 stream 并请求全量；旧清单只可显示为可能过期，不能与新 stream 增量拼接。
   Hub 重启、订阅者重启、接收权限变化也强制重新取已过滤的全量。
6. 乱序时不无限缓存或猜测缺失消息；全量优先，接收侧不必维护历史消息窗口。

清单 seq 与 U7 守护进程的 terminal sequence 完全分开。
生成时间可能有时钟偏差；协调端同时记录 receivedAt，离线、过期签名或同步缺口不能由
本机时钟把状态“恢复”为在线。设备撤销或接收权限撤销时立即移除无权查看的投影。

## 4. 分享授权与元数据边界

- 本机扫描授权只允许只读扫描，**不允许跨设备分享**。用户须另行明确选择项目、
  本机 mount 和“共享会话元数据”；设备侧按当前授权版本校验，默认不分享。
- `user`、`user-adopted` 只来自获准分享的项目和 mount。同 projectId 的另一个 clone、
  worktree 或设备不继承授权。Station/Worker 也须落在已获准转发的项目范围，不能借
  内部 origin 绕过项目、接收方权限或签名入口。
- 分享授权来源应是设备本机可信持久化记录，包含 projectId、mountId、授权版本和撤权状态；
  Hub project binding 或“设备在线”单独不能充当该记录。S4/S6 接线前生成器保持关闭。
- 授权变更使旧生成任务失效，发送前再次检查。撤回一个 mount 后重新生成项目替换；
  撤回项目最后一份授权发送删除或空全量。无法发送时，Hub 的当前权限过滤与重连全量仍需
  移除接收方可见记录。已经传给另一设备的元数据无法追溯收回，不作此承诺。
- 不发送 cwd、repoRoot、gitCommonDir、原生文件路径、命令行、提示词、会话内容、
  扫描 evidence、原始 remote URL、凭据、PID、TTY 或本机授权记录。禁止直接序列化 ObservedSession。
- label 仅从已授权目录 basename 获取，做控制字符/秘密模式清洗；branch 也是显式获准元数据，
  不能拿绝对路径、worktree 名或会话提示词兜底。worktree 使用 mountId；不能把完整目录填进去。
- 不透明 sessionId 不兼作本机文件名、恢复命令或执行权限。用户及已收编用户会话不带 terminalId；
  两种内部 origin 带 terminalId 也不自动获得 U7 查看权。
- 无可靠进程证据、hook 断连、归属不明或登记未绑定时保持 unknown/disconnected，
  不把 task_complete、文件变旧、Stop 意图或 idle 推断成进程树退出或任务验收。

## 5. 大小、节流与验收

建议首版：单条 UTF-8 JSON 正文上限 512 KiB，最多 100 项目、每项目 200 会话，
字符串标识/标签最多 256 Unicode 字符。按编码后的字节数校验；具体上限待使用方确认。
变化合并窗口 1 秒，普通增量最多每秒一次；撤权优先，不等待普通窗口。
超限不截断后冒充完整清单：保留旧投影并明确同步失败，完整重发仍超限则保持失败，
需要另行约定分页协议。清单仅保存当前已授权投影，不复用 U7 终端保存期限。

双方实现后至少验证：首次空全量、项目/会话删除、重复重发、同 seq 冲突、乱序/跳号、
发送/接收重启与旧连接迟到、Hub 重启、时钟偏差、撤权期间旧异步结果、同项目不同 mount
权限不串、用户会话无 terminalId、无绝对路径/内容/凭据、超限不产生半份投影、离线过期提示。
双机实测和签名验收不能用 fixture 或 CI 代替。

## 待确认项

eternal904：消息名及签名信封接线、Hub 绑定 streamId 的生命周期、重同步请求、
项目级替换/删除、转发接收权限过滤、512 KiB/数量限制。
He-1102：IF-3 未解析状态、清单时间/可能过期显示、S4/S6 显式分享授权入口。
本提案未修改 Hub/Station 生产协议，不关闭 #94/#95/#100/#115。
