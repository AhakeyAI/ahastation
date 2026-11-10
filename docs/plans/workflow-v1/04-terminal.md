# 04 原生终端与输入

## 所有权

RuntimeService 持有真实 CLI 和 PTY 生命周期。TerminalService 持有镜像、日志与订阅。Renderer 通过 RealTerminal 查看指定 executionId，视图卸载只 detach。

现有 electron/pty-host.ts、electron/ipc/worker-pty.ts、src/components/RealTerminal.tsx 与 WorkerWorkbench.tsx 是改造入口。V1 使用 @xterm/headless 与 @xterm/addon-serialize，版本须和现有 xterm 兼容并锁定。原生终端协议兼容性实测后启用。[xterm API](https://xtermjs.org/docs/api/terminal/classes/terminal/)、[序列化插件](https://raw.githubusercontent.com/xtermjs/xterm.js/master/addons/addon-serialize/README.md)

## 输出与事件协议

```ts
type TerminalRecord =
  | { recordSeq: string; kind: 'data'; from: string; to: string; bytesBase64: string }
  | { recordSeq: string; kind: 'resize'; at: string; cols: number; rows: number }
  | { recordSeq: string; kind: 'gap'; from: string; to: string; reason: string };

interface TerminalSnapshot {
  executionId: string;
  terminalEpoch: string;
  throughRecordSeq: string;
  throughOffset: string;
  cols: number;
  rows: number;
  serializedState: string;
  durableThroughRecordSeq: string;
}
```

recordSeq 为同一 Execution 内严格递增序号，包含数据与 resize 的顺序。字节偏移只统计 data。resize 可与数据具有相同偏移，因此重连还需要 recordSeq。

权威字节流定义为 PTY API 输出转换为 UTF-8 后的规范流。若 node-pty 提供字符串，不能声称这是原始操作系统字节；编码和分块规则在服务端固定，日志、镜像和 UI 接收相同内容。所有 UTF-8 分片使用流式解码，协议偏移不使用 JS 字符数。

## 挂载流程

1. 校验窗口可读权限及 executionId，分配 subscriptionId，建立后续记录的待发队列。
2. 选择可以准确恢复的 frontier，包含已解析的完整字符和终端控制序列；同时固定该位置的 recordSeq、尺寸和终端模式。
3. 暂停向镜像投递 frontier 后的记录，等待 xterm write 回调完成，再序列化镜像。继续到达的 PTY 数据写日志并排队。暂停只覆盖一次序列化的时长；镜像是 replyOwner 时，暂停期间到达的终端查询在恢复后按 recordSeq 顺序应答。P0-D 测量序列化耗时和两种 CLI 对查询应答延迟的容忍度，不达标时改为在独立的第二个镜像实例上序列化，主镜像不暂停。
4. 发送 snapshot，渲染器加载同版配置、按快照尺寸恢复并回执 snapshotApplied。
5. 从 throughRecordSeq + 1 顺序发送队列，再接实时流。每条记录至多应用一次。
6. 确认 active 后由尺寸所有者发送 resize。恢复旧画面时不能提前用新尺寸解析旧流。

输入解析边界跟踪覆盖 UTF-8、ESC、CSI、OSC、DCS、备用屏幕和取消序列。输出停在未完控制串时，不无限等待挂载；使用上一安全检查点及原始尾部重放，让接收端保留相同解析器未完成状态。无法证明当前快照完整时选择安全重放路径。

序列化插件不应被假定能保存所有解析器和模式状态。发布验收要覆盖应用光标、键盘模式、bracketed paste、备用屏幕、颜色和宽字符。未支持的模式需要增加显式状态恢复或退回从安全检查点重放，不能宣称完全一致。

## 磁盘日志与背压

日志以带长度、recordSeq 和校验和的记录追加，同步保存 resize。维护 received / durable / parsed 三个 frontier。快照注明可持久恢复的 frontier；程序崩溃后的恢复只使用落盘记录，尾部截断显式记录 gap。

刷盘按批次进行：累计达到 RuntimePolicy 中的时间间隔或字节数时刷一次，durable frontier 只在刷盘完成后前移。resize、快照检查点、进程退出和应用受控退出前强制刷盘。具体间隔与字节数在 P0-D 按吞吐和延迟实测后确定。

内存队列有界。慢订阅者积压时切换为磁盘追赶，追赶完成再接 live。不能因 UI 慢而丢弃主输出或把 CLI 标记为失败。磁盘写入失败时显示历史留存故障，暂停新的自动启动；停止现有进程的控制路径仍可用。完整保留无法实现时显示具体缺口。

磁盘日志仅保存输出及必要元数据，避免记录原始键盘输入中的密码。留存上限按工作流配置，删除前核对证据引用；超限先报告，不能静默删除用户要求保留的证据。

## 输入控制

接口为 attach、detach、claimInput、releaseInput、writeInput、resize、readRecords。每个写请求带 subscriptionId、executionId、inputEpoch 和递增 inputSeq。同一存活输入代理内按 inputSeq 去重，并返回最后连续接收序号。

原始按键写入 PTY 和数据库记录不能原子提交。代理崩溃、连接丢失或写入回执不明时，禁止自动重放未确认按键或 Enter；UI 显示输入结果待核对，让用户从原生终端确认。代理重建后签发新 inputEpoch，旧 epoch 全部拒绝。需要可靠自动重试的 Host 指令使用持久 messageId 和原生接收证据，不能套用普通按键重发。

同一 Execution 只有一个人工输入所有者和一个尺寸所有者。用户取得控制时阻止自动注入，Host 新消息入队。用户释放控制后仍要核对原生轮次边界和待输入状态。粘贴与提交作为适配器明确支持的一次操作调度，不能靠固定 sleep 判断 CLI 已接收。

输入所有权在以下任一情况自动释放：用户切走该终端视图或关闭窗口；用户发起的轮次结束且之后没有新输入；超过 RuntimePolicy 配置的无输入时长。界面在终端上方持续显示“你正持有输入”和释放按钮。被 deferred 的 Host 消息在页面上可见，用户可以立即释放让其投递。

TerminalService 按 inputSeq 记录用户输入，并据此判断是否可能存在草稿。用户提交第一条提示后可能立即开始输入下一条，而第一轮的开始证据可能迟到，所以不能在收到轮次开始证据时直接清零：

- 含回车的按键或粘贴记为候选提交点，保存其 inputSeq。回车不一定是提交（多行输入、菜单选择），所以候选提交点需要与轮次开始证据关联后才算确认。
- 轮次开始证据到达时，关联到一个具体的候选提交点：提交 hook 携带提示文本时，按内容哈希与该提交点之前的输入匹配；不能匹配时，关联到最早一个尚未关联的候选提交点。这样即使关联有误，也只会把更多输入当作草稿，偏向保守。
- confirmedSubmitSeq 是已关联提交点中最大的 inputSeq。draftPossible 定义为“存在 inputSeq 大于 confirmedSubmitSeq 的用户输入”。轮次开始证据只把 confirmedSubmitSeq 推进到与之关联的提交点，不推进到当前最新输入。
- 自动注入触发的轮次关联到对应的 messageId，不改变用户的 confirmedSubmitSeq。

draftPossible 为 true 时禁止空闲注入，避免把指令拼接到用户草稿后面。

冻结、归档、执行失联或权限撤销时撤销相应输入令牌。只读窗口的键盘输入和 resize 不得影响执行。Host 的结构化控制同样遵守人工接管，用户停止则直接走 RuntimeService。

用户关闭窗口、断开或 renderer 崩溃时撤销该窗口的输入及尺寸租约。自动控制恢复还需核对原生轮次和未确认输入；窗口消失不等于 CLI 已空闲。已完成目标下的人工新执行遵守 02 的待归属规则，避免把新修改回报给旧目标。

镜像和可见终端可能都会对终端查询产生响应，需要单独指定唯一 replyOwner。历史恢复阶段禁止把模拟器响应写回 CLI，实时查询只由当时的 replyOwner 回答。无人查看时 headless 接管响应，切换时按 recordSeq 串行交接，防止重复设备响应或误当成人工接管。这是 xterm 集成必须验证的专项。

## 恢复语义

页面重挂载从服务的存活镜像恢复。应用重启先核对 PTY 是否仍由可连接的所有者持有；若原进程已退出，只展示历史并通过原生会话恢复创建新 Execution。历史屏幕回放不能冒充仍在执行。

同一 nativeSession 的替代 Execution 使用新 terminalEpoch，避免旧渲染订阅控制新进程。V1 不新增常驻终端 daemon，仅定义当前 PtyHost 可证明的生命周期。

## 验收

TM-01 备用屏幕切换；TM-02 连续 resize；TM-03 UTF-8/ANSI 边界分片；TM-04 原始输出不含结束符；TM-05 快照期间高输出量；TM-06 慢 UI 追赶；TM-07 两窗口争抢输入；TM-08 磁盘满和截断尾部；TM-09 查询响应仅一次；TM-10 旧 Execution 订阅失效；TM-11 CLI 原生快捷键、菜单、粘贴和 subagent 视图对照；TM-12 输入所有权按切走视图、轮次结束和超时自动释放；TM-13 快照期间到达的终端查询在 CLI 容忍时间内得到唯一应答；TM-14 用户有草稿时 draftPossible 阻止注入；TM-15 第一轮开始证据迟到、用户已输入下一条草稿时，draftPossible 保持为 true，Host 不注入。

优先采用录制字节 fixture 离线验证镜像一致性，再用两种真实 CLI 检查原生体验。

