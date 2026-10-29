# 协作面板接口（IF-6，本地候选）

本接口对应 Issue #98，供 he-1102 将协作数据放入产品布局。本地候选尚未获得 he-1102 的 Issue 确认；组件测试不替代产品布局、视觉或双机验收。IF-6 无 U7、S6、X1 前置依赖。

## 组件与 props

入口：`src/components/SharedCollaborationPanel.tsx` 的 `SharedCollaborationPanel`，props 类型为同文件导出的 `SharedCollaborationPanelProps`。

| 字段 | 类型 | 约定 |
| --- | --- | --- |
| `enabled` | `boolean`，必填 | 只有显式 `true` 才展示活动内容；`model.view.enabled === false` 时仍关闭。此值不能开启主进程安全门。 |
| `model` | `UnifiedModel`，必填 | 父层用既有 `projectShared(view, meetingId)` 获得；缺少会议时不挂载面板。 |
| `error` | `string?` | 父层读取状态失败的原因；未提供时显示 `model.view.error`。 |
| `onOpenTask` | `(taskId: string) => void`，可选 | 打开当前会议任务详情。参数是稳定任务 ID，详情再读取当前 attempt。没有回调时任务导航禁用。 |
| `onInvite` | `() => void`，可选 | 打开既有邀请入口，不能在此回调中隐式启动模型。断线时禁用。 |
| `onReviewPlan` | `() => void`，可选 | 打开既有计划审阅入口，不代表批准。断线时禁用。 |
| `onClose` | `() => void`，可选 | 请求父层隐藏面板。没有回调时不显示关闭按钮。 |

组件不订阅 IPC、不读取存储、不请求 Hub、不启动模型，也不内嵌批准、派发、停止或撤销命令。所有回调均为导航意图；业务动作由父层现有入口处理，继续保留主持设备权限、计划版本及任务/attempt 校验。组件没有自己的打开状态，父层控制挂载和卸载。

## 复用的数据投影

唯一数据来源仍为 `src/lib/unified-meeting-store.ts`，不增加第二套 Hub 契约或任务状态。

| 投影字段 | 用途与边界 |
| --- | --- |
| `model.view.enabled / connected / deviceId / config.name` | 关闭门、连接状态和本机身份；连接状态不等于 Agent 或项目授权就绪。 |
| `model.meeting` | 当前会议 ID、标题、协调设备、Host、计划和批准状态；计划提案不能当作已派发任务。 |
| `model.tasks` | `projectShared` 已按 meetingId 筛选的任务，保留 taskId、当前 attemptId、真实状态、退出/停止证据和交付记录。 |
| `model.members` | 稳定成员 ID、deviceId、agentId、名称、在线状态、执行候选资格及其任务；设备离线时不删除身份和任务。 |
| `model.view.snapshot.entities.device / project` | 展示设备和项目名称。设备同名时沿用既有投影的 ID 后缀区分。 |

任务阶段继续使用 `sharedPhase`，交付可信状态继续使用其已有的 `verifiedDelivery` 检查；计划依赖和基线修订沿用 `dependencyWait / pendingBaseRevisions`。没有 turnOutcome 的旧交付、停止未确认、部分成果均不能因展示而被批准或发布。

现有会议布局复用同一份纯展示 `SharedParticipants / SharedUserTasksPanel`，原导出路径保留。IF-6 不交付新的整页会议布局或覆盖层；容器位置、宽高、收起方式和视觉由产品决定。

## 关闭、断线与生命周期

- `enabled` 不是显式 `true`，或主进程返回 `enabled: false`：仅显示“跨设备协作暂未开放”，不展示导航按钮和会议内容。
- 断线：保留最后确认的成员、任务及状态，禁用邀请/计划导航；仍可打开只读任务详情或关闭面板。不得自动切换设备、重派任务或升级为已停止。
- 关闭/卸载：只影响展示，不发送 stop、leave、revoke，不修改会议和本地恢复记录。父层不可把面板关闭绑定为停止任务。
- 父层使用 `useUnifiedMeeting` 时，同一 renderer 的消费者共用一个变更监听；最后一个消费者卸载后退订，旧监听和旧异步回应不得刷新新挂载的消费者。单独关闭面板时若父层仍有消费者，现有订阅继续保留。

## 父层接入示例

```tsx
const state = useUnifiedMeeting();
const model = state.view && selectedMeetingId
  ? projectShared(state.view, selectedMeetingId)
  : undefined;

return panelOpen && model ? <SharedCollaborationPanel
  enabled={collaborationPreviewAllowed}
  model={model}
  error={state.error}
  onOpenTask={openCurrentTaskDetails}
  onInvite={openInvitation}
  onReviewPlan={openPlanReview}
  onClose={() => setPanelOpen(false)}
/> : null;
```

正式入口默认关闭，只有已有的隔离预览配置可运行本机夹具。该示例不修改入口门，也不替代布局接入确认。

## 验证与待确认项

正式回归 `tests/shared-collaboration-panel.test.mjs` 直接加载源码和实际 React，覆盖显式开启、关闭门、会议隔离、成员/attempt 身份、纯回调、断线、旧交付、最后消费者退订和迟到回应隔离，不依赖旧 dist。

待 he-1102 在 Issue #98 确认 props、投影字段和关闭行为，并决定产品容器及导航映射。终端只读流、接管、扫描清单、签名和真实双机仍分别验收，面板不伪造这些能力的就绪状态。
