import type { UnifiedModel } from '../lib/unified-meeting-store';
import { sharedPhase } from '../lib/unified-meeting-store';
import { dependencyWait, pendingBaseRevisions } from '../../electron/collaboration/plan-revision';

export interface SharedCollaborationPanelProps {
  /** The parent must explicitly allow this panel. This does not open the main-process gate. */
  enabled: boolean;
  model: UnifiedModel;
  error?: string;
  onOpenTask?: (taskId: string) => void;
  onInvite?: () => void;
  onReviewPlan?: () => void;
  /** Only requests that the parent hide the panel; never stops or leaves the meeting. */
  onClose?: () => void;
}

/** Render-only IF-6 boundary. IPC, mutations and layout stay with the caller. */
export function SharedCollaborationPanel({
  enabled,
  model,
  error,
  onOpenTask,
  onInvite,
  onReviewPlan,
  onClose,
}: SharedCollaborationPanelProps) {
  if (enabled !== true || model.view.enabled === false) {
    return <section aria-label="设备协作面板"><p role="status">跨设备协作暂未开放。</p></section>;
  }
  const failure = error || model.view.error;
  return <section className="shared-collaboration-panel" aria-label="设备协作面板">
    <header>
      <h2>{String(model.meeting.title)} · 设备协作</h2>
      {onClose && <button onClick={onClose}>关闭协作面板</button>}
    </header>
    <p role="status">{model.view.connected ? '实时在线' : '连接中断，保留最后确认状态'}</p>
    {failure && <p role="alert">{failure}</p>}
    {onReviewPlan && <button disabled={!model.view.connected} onClick={onReviewPlan}>审阅当前计划</button>}
    <SharedParticipants model={model} onOpenTask={onOpenTask} onInvite={onInvite} inviteDisabled={!model.view.connected}/>
    <SharedUserTasksPanel model={model} onOpenTask={onOpenTask}/>
  </section>;
}

/** Also used by the existing meeting layout; callbacks navigate without dispatching work. */
export function SharedParticipants({
  model,
  onOpenTask,
  onInvite,
  inviteDisabled = false,
}: {
  model: UnifiedModel;
  onOpenTask?: (id: string) => void;
  onInvite?: () => void;
  inviteDisabled?: boolean;
}) {
  const hostDevice = model.view.snapshot.entities.device?.find(d => d.id === model.meeting.coordinatorDeviceId);
  return <aside className="tiles-gallery unified-participants">
    <div className="tiles-gallery-scroll">
      <article className="unified-member">
        <strong>You · {model.view.config.name}（本机）</strong>
        <p>查看与主持不自动授予本机执行资格</p>
      </article>
      <article className="unified-member">
        <strong>Host · {String(hostDevice?.name ?? '原协调设备')} · {String(model.meeting.hostAgentId ?? 'codex')}</strong>
        <p>{hostDevice?.online ? '会议唯一统筹' : '离线，新安排等待恢复'}</p>
      </article>
      {model.members.map(member => <article className="unified-member" key={member.id}>
        <strong>{member.label}{member.deviceId === model.view.deviceId ? ' · 本机' : ''}</strong>
        <p>
          {member.online ? '在线' : '离线，保留最后确认状态'}
          {member.nativeSessionId ? ' · 原生对话串行接续' : member.executionCandidate === false ? ' · 可讨论，不接新任务' : ' · 独立会议讨论'}
        </p>
        {member.tasks.map(task => <button key={task.id} disabled={!onOpenTask} onClick={() => onOpenTask?.(task.id)}>
          {String(task.title)} · {sharedPhase(task)}
        </button>)}
      </article>)}
    </div>
    {onInvite && <button className="tiles-gallery-add" disabled={inviteDisabled} onClick={onInvite}>＋ 邀请设备／对话</button>}
  </aside>;
}

/** Keep the original task/plan projection and its dependency checks in one place. */
export function SharedUserTasksPanel({ model, onOpenTask }: {
  model: UnifiedModel;
  onOpenTask?: (id: string) => void;
}) {
  const proposed = (model.meeting.plan ?? []) as Array<Record<string, unknown>>;
  const revisions = pendingBaseRevisions(model.view.snapshot, model.meeting);
  const waiting = (task: Record<string, unknown>) => revisions.some(
    revision => revision.planTaskId === String(task.planTaskId ?? 'planned-' + proposed.indexOf(task)),
  ) ? '等待基线修订批准' : dependencyWait(model.view.snapshot, model.meeting.id, task) ?? '获准目标，等待设备／项目就绪';
  const proposals = proposed.filter(plan => !model.tasks.some(task => plan.planTaskId
    ? task.planTaskId === plan.planTaskId
    : task.title === plan.title && task.objective === plan.objective));
  return <section className="user-tasks-panel unified-task-list">
    <h2>{String(model.meeting.title)}</h2>
    <p>
      主项目：{String(model.view.snapshot.entities.project?.find(project => project.id === model.meeting.mainProjectId)?.name ?? '纯文字，可在首次文件工作前绑定')}
      {' · '}{model.meeting.planApproved ? '当前计划已批准' : '计划待审阅'}
    </p>
    <table>
      <thead><tr><th>完整交付</th><th>设备 · Agent</th><th>真实阶段</th></tr></thead>
      <tbody>
        {model.tasks.map(task => <tr key={task.id}>
          <td><button disabled={!onOpenTask} onClick={() => onOpenTask?.(task.id)}>{String(task.title)}</button></td>
          <td>{String(model.view.snapshot.entities.device?.find(device => device.id === task.targetDeviceId)?.name)} · {String(task.agentId)}</td>
          <td>{sharedPhase(task)}</td>
        </tr>)}
        {proposals.map((plan, index) => <tr key={'proposed-' + index}>
          <td>{String(plan.title)}</td>
          <td>{String(model.view.snapshot.entities.device?.find(device => device.id === plan.targetDeviceId)?.name)} · {String(plan.agentId)}</td>
          <td>{model.meeting.planApproved ? waiting(plan) : 'Host 提案，尚未批准'}</td>
        </tr>)}
      </tbody>
    </table>
  </section>;
}
