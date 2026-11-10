# 06 工作流界面与 IPC

## 页面结构

左侧主区域在 Host 对话和选中 Worker 的真实终端之间切换，成员列表持续可见。工作流顶部显示名称、根目录、当前整体目标及运行摘要。

Worker 卡片展示名称、职责、当前目标、状态、等待原因、后端、仓库和最近活动。成员详情展示原生终端、Host 来往消息、排队工作、候选与验证、交付进度和历史。工作入口放在成员历史和 Host 对话的成果链接里，定位参数为 workId 和可选 resultVersion。Delegation、Execution、Turn 的内部标识仅出现在诊断详情。

优先复用 App.tsx、ParticipantPanel.tsx、WorkerWorkbench.tsx、RealTerminal.tsx、meeting-store.ts 和现有 IPC validators。新工作流 projection 与 legacy meeting projection 分开映射，旧 UI 不得误驱动新成员生命周期。

## 用户流程

| 操作 | 产品行为 |
|---|---|
| 打开工作流根目录 | 服务返回已有 Workflow，恢复 Host 或显示恢复状态 |
| 向 Host 发送聊天消息 | 服务保存原文并显示讨论、待澄清或已授权开工。开工许可回执显示绑定目标与范围，Host 在授权内直接派发 |
| 澄清开工对象 | 在原聊天里询问具体指代。用户答清后关联原指令和选定版本，显示开工回执 |
| 点击 Worker | 附着该成员当前 Execution 的终端 |
| 输入终端 | 明确取得人工输入控制权，Host 自动输入等待 |
| 停止 | 默认停止当前轮次；更多操作可结束进程 |
| 提交用户决定 | 展示具体问题和适用目标；问题源自 Worker 时同时展示来源 Worker、Worker 原文和 Host 改写后的措辞；原文投递并显示处理状态 |
| 审阅交付申请 | 展示准确候选、候选差异、验证、目标分支及申请动作。提交、推送和创建 PR 分别确认。首推显示“创建远端分支”，使用已有 PR 时显示编号、base 及预期 head SHA |
| 查看 PR 成果 | 展示实际 PR 编号、链接、状态、base/head 分支与 SHA、快照时间和逐文件差异。候选差异在独立区域呈现 |
| 恢复受阻的 PR 交付 | 在原工作内展示实际推送回执、PR 阻断原因和旧操作状态。提供“重新核对”和“更换交付分支”，更换前展示新目标并要求对应推送授权 |
| 验收成果版本 | 展示“待用户验收”以及具体成果和证据，提供“接受”和“退回补充”。退回要求填写原因；版本已更新时提示切到新版 |
| 取消指定工作 | 按 workId 取消排队项，或展示运行中工作的停止与交付核对进度 |
| 查看归档成员 | 查询历史和终端留存，输入不可用 |
| 关闭成员视图 | detach，原生执行由服务继续管理 |
| 关闭最后一个窗口 | 无运行中的 Host 或 Worker 时直接退出；有则询问“后台继续”或“停止并退出”，默认后台继续 |
| 从托盘或 Dock 打开 | 重新打开主窗口并按 workflow:snapshot 恢复界面 |
| 显式退出应用 | 展示停止进度，未确认时提供继续等待与用户明确强退入口 |
| 放弃无法核对的执行 | 仅在执行处于 unknown 且核对失败时出现，展示已尝试的停止动作与剩余风险，用户确认后执行 |

用户直接在 Worker 原生终端输入时，服务记录人工接管事件并通知 Host。输入正文可能包含密码，默认不记录全部原始按键；通过原生可读会话和公开回复核对工作变化。超出当前委派范围的操作仍受工作流实际支持的权限策略约束。

## 应用生命周期

关闭单个窗口只解除该窗口的订阅和输入、尺寸租约。关闭最后一个窗口时：

- 没有运行中的 Host 轮次、Worker 执行或进行中的交付操作，按平台习惯退出（macOS 保留应用）。
- 有运行中的工作时弹出确认，选项为“后台继续”（默认）和“停止并退出”。用户可以勾选“记住选择”，记录在应用设置中。
- 后台继续时，Windows 与 Linux 显示托盘图标，macOS 保留 Dock 图标。托盘菜单提供打开主窗口、各工作流的运行摘要、停止全部并退出。
- 停止并退出走与显式退出相同的受控停止流程。

现有 electron/main.ts 的 window-all-closed 处理会调用 shutdownAllSlots，并在非 macOS 平台调用 app.quit()。V1 需要把它改为上述流程，before-quit 仍作为显式退出的最后保障。托盘在 Linux 各桌面环境上的可用性需要在发布验收中逐一确认，不可用时退回为“关闭即询问是否停止”。

## 主要 IPC

统一以 workflow:command 调用普通命令，主进程 schema 验证并根据 sender 授权。独立通道提供只读订阅和二进制终端流。

| 通道 | 输入/返回 |
|---|---|
| workflow:open | rootPath → workflowId、projection、cursor |
| workflow:command | CommandEnvelope → CommandResult |
| workflow:operation | workflowId、operationId → 当前步骤、状态、结果及可见错误 |
| workflow:snapshot | workflowId → projection、throughSeq |
| workflow:subscribe | workflowId、afterSeq → subscriptionId、有序事件 |
| workflow:ack | subscriptionId、throughSeq → 已确认（仅保存在主进程内存，窗口关闭即丢弃） |
| workflow:unsubscribe | subscriptionId → detached |
| terminal:attach | workerId、executionId → snapshot 和 subscriptionId |
| terminal:records | executionId、afterRecordSeq、limit → 分页记录 |
| terminal:claim-input | executionId、subscriptionId → inputEpoch |
| terminal:release-input | executionId、subscriptionId、inputEpoch → 已释放或待核对 |
| terminal:input | executionId、inputEpoch、inputSeq、bytes → 已接收 |
| terminal:resize | ownerToken、cols、rows → 已应用序号 |
| terminal:detach | subscriptionId → detached |
| artifact:read | artifactId、version → 经授权的正文或下载句柄 |
| work:read | workflowId、workId、可选 resultVersion → 工作、委派索引、成果版本、用户决定和可用动作 |
| pull-request:diff | workflowId、workId、snapshotId、可选游标或文件 ID → 固定快照的分页文件索引或单文件 patch |

返回值按视图包含 workflowId、workerId、executionId、workId、resultVersion 或 snapshotId，以便 renderer 丢弃已切换视图的迟到结果。请求中 supplied actor/Grant 身份不可信，服务从窗口与用户动作推导。所有主进程路径访问均验证实际目录边界。

主窗口、只读成员窗、人工终端窗分别声明能力。仅查看窗口不能验收成果、批准交付、创建成员或写终端。跨成员会话读请求检查 Grant，界面隐藏入口不能替代服务校验。

`PostUserMessage` 走 `workflow:command`，携带原始文本和可选的回复或引用 ID。服务校验 sender 的聊天与开工权限，回执包括 messageId、路由结果及适用的目标引用。渲染器重复发送时沿用原 requestId。界面分别显示开工许可、派发队列和实际运行状态。缺少对象或范围时，沿用同一聊天显示澄清问题和候选引用，服务按 03 处理答复。

`AcceptWorkResult` 和 `ReturnWorkResult` 走 `workflow:command`，参数为 `workId`、`resultVersion` 和 `expectedWorkRevision`，退回另带原因。对 PR 成果，接受时展示“核对 PR 版本中”，通过操作回执获取最终状态。`RefreshPullRequest` 携带 workId、deliveryId 和 expectedWorkRevision，可在首次 PR 绑定前核对创建意图，也可重读已知 PR 和 Diff。刷新只读取外部事实，每次封存的新成果使用新的 resultVersion。“更换交付分支”通过 Host 发起替换申请，携带原 deliveryId 和 Work revision，用户确认新推送授权后更新当前交付。`CancelWork` 携带 workId、expectedWorkRevision 和原因。

## 投影与状态展示

renderer 只消费 WorkflowProjection 和事件。快照返回 throughSeq，订阅从其后一条补读；乱序先缓冲，小范围缺口补读，大范围缺口重新获取快照。状态突变必须有对应事件和对象 revision。

展示优先级为停止待核对 / 执行异常 / 待用户决定 / 人工接管 / 验证或交付 / 运行 / 等待依赖或资源 / 空闲 / 归档。详情保留所有并行事实，例如 CLI 驻留同时委派等待提交确认。

pending 修订展示“新要求待接收”，收到原生确认后更新当前目标。送达和已处理分别展示。Unknown 显示证据及可进行的核对/结束操作，不能渲染为完成。

独立新目标展示为排队工作。Worker 交回成果后，原工作显示“待用户验收”，Worker 卡片可开始显示下一项。用户通过旧链接打开原成果时，按 workId 和版本查询，即使已改派或 Worker 归档也保留相同归属。`changes_requested` 显示“待补充”和退回意见，只有 `completed` 显示“已完成”。

PR 差异读取使用固定 snapshotId，并显示上次核对时间。新版、已过期和无法核对分别显示，旧快照保留在成果历史中。二进制、仅模式变化和 GitHub 截断明确标记。版本变化或差异缺失时禁用该 PR 成果的接受操作，服务同步核对权限、成果版本和 PR 观测。用户可以打开服务验证过的 PR 链接或提交退回意见。首次封存前的 PR 阻断在当前交付上显示恢复入口，旧交付的迟到回执只更新历史。

同一成员可以同时有多个等待项，界面列出所有未解决条件。用户解决其中一项后，其他条件继续显示。原始终端输入回执不明时展示“输入结果待核对”，不自动补发字符。用户持有输入时，终端上方持续显示“你正持有输入”、释放按钮及被暂缓的 Host 消息数。已完成成员继续人工执行时显示“人工执行待归属”，由用户或 Host 明确后续完整目标。

用户答复、Grant 和模型建议使用不同消息来源标记。Worker 来源的文本始终带来源标记显示，不与用户或服务生成的内容混排；授权确认界面只展示服务生成的结构化字段（候选、差异、目标分支、动作），模型生成的说明放在单独区域并标明来源。Host 总结可链接具体 Candidate、Artifact 和 Verification，用户能够打开原始证据。

## 原生终端要求

沿用 04 的一致性协议。终端区域直接呈现 CLI，工具摘要可以在侧栏辅助展示。切换 Worker 时确保旧订阅销毁、旧输入 epoch 无效，新视图绑定新 executionId。

字体、宽字符规则、终端类型和颜色配置与镜像一致。工作流限制导致某原生能力不可用时，在侧栏显示原因，不能让用户误认为 CLI 自身故障。

## 验收

UI-01 重复打开同目录定位原工作流；UI-02 切换成员不混流；UI-03 慢响应不覆盖当前视图；UI-04 只读窗口无法写终端/审批；UI-05 停止按钮立即请求中断并显示待确认；UI-06 pending 修订和当前目标分开；UI-07 断线重订阅无消息缺口；UI-08 阅览原始证据；UI-09 退出待核对；UI-10 原生终端与旁路状态一致；UI-11 关闭最后一个窗口时有运行中工作则询问，后台继续后执行不中断且可从托盘或 Dock 重新打开；UI-12 输入持有提示与自动释放；UI-13 放弃执行入口只在核对失败时出现并要求确认。

UI-14 Worker 切到新工作后旧成果链接和接受/退回仍对应原工作；UI-15 旧成果窗口无法接受新版，未授权 sender 无法写决定；UI-16 真 PR 差异按快照分页，PR 更新后旧页不能覆盖新成果，缺失或过期时显示可核对原因。

UI-17 首次 PR 受阻时，可在原工作中看到已完成的 Git 推送和恢复入口。用户确认换分支后，当前目标与旧交付记录分别显示。

UI-18 同一聊天可以讨论下一目标并查看已授权工作的执行状态。明确指令直接显示开工许可，歧义回复绑定原问题，重发只显示原消息和开工回执。

