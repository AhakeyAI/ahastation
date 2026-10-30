import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Clock3,
  Eye,
  GitMerge,
  LoaderCircle,
  RotateCcw,
  ShieldAlert,
  SquareTerminal,
  Plus,
  X,
  ListTodo,
} from 'lucide-react';
import type { AggregatedTask, CrossProjectTasks } from '../lib/meeting-store';
import { dependencyGateShortLabel } from '../lib/dependency-gate';
import {
  DEFAULT_LANES,
  SUB_STATUS_META,
  SUB_STATUSES,
  subStatusForObserved,
  TASK_COLUMNS,
  UNSORTED_LANE_ID,
  laneFor,
  laneHint,
  parseLanes,
  type BoardLane,
  type BoardSubStatus,
  type TaskColumnId,
} from '../lib/task-columns';
import { useBacklog } from '../lib/backlog-store';
import { projectKeyOf, useRepoRoots } from '../lib/repo-roots';
import { splitPath } from '../lib/project-rooms';
import type { BacklogItem } from '../lib/project-rooms';
import { useObservedTasks } from '../hooks/useObservedTasks';
import { ScanControls } from './ScanControls';
import type {
  ObservedClientKind,
  ObservedSession,
  ObservedState,
} from '../lib/observed-store';
import type { WorkerStatus } from '../types';
import type {UnifiedModel} from '../lib/unified-meeting-store';
import {sharedPhase} from '../lib/unified-meeting-store';

interface TasksViewProps {
  shared?:UnifiedModel;
  data: CrossProjectTasks;
  /** Focus the owning project and drop the user into its meeting view. */
  onOpenTask: (sessionId: string, taskId: string) => void;
  /** Focus the owning project so its plan-approval modal comes up. */
  onOpenPlan: (sessionId: string) => void;
  /** 查看: the worker's native terminal in its project room's stage. */
  onOpenTaskTerminal?: (task: AggregatedTask) => void;
  /** 开始: a local CLI in the project room's stage, seeded with the card. */
  onStartBacklog?: (item: BacklogItem) => void;
  /** 继续: an observed session, forked when it is still running elsewhere. */
  onContinueObserved?: (session: ObservedSession) => void;
  /** The meeting's project folder: the board opens filtered to it (its
   *  repository, worktrees included). Unset = all projects. */
  project?: string | null;
}

const ALL = '__all__';

function StatusIcon({ status, blocked }: { status: WorkerStatus; blocked: boolean }) {
  if (blocked) return <ShieldAlert size={13} />;
  if (status === 'accepted' || status === 'done') return <CheckCircle2 size={13} />;
  if (status === 'failed' || status === 'integration-conflict') return <AlertTriangle size={13} />;
  if (status === 'reworking') return <RotateCcw size={13} />;
  if (status === 'budget-paused' || status === 'interrupted') return <Clock3 size={13} />;
  if (
    status === 'reviewing'
    || status === 'coordinator-reviewing'
    || status === 'awaiting-acceptance'
    || status === 'integration-queued'
  ) return <GitMerge size={13} />;
  if (status === 'running' || status === 'verifying' || status === 'integrating') {
    return <LoaderCircle size={13} />;
  }
  return <CircleDashed size={13} />;
}

/** A task has a worker terminal to look at once it left the queue. */
function taskHasTerminal(task: AggregatedTask): boolean {
  return task.column !== 'todo' || task.attempt > 1;
}

function CardAction({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <span className="tasks-card-actions">
      <button type="button" className="tasks-card-action" title={title}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        onKeyDown={(e) => e.stopPropagation()}>
        <SquareTerminal size={12} aria-hidden="true" />{label}
      </button>
    </span>
  );
}

function TaskCard({ task, onOpen, onTerminal }: { task: AggregatedTask; onOpen: () => void; onTerminal?: () => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`tasks-card is-${task.status}${task.blockedReason ? ' is-blocked' : ''}`}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      title={task.blockedReason ?? task.cwd}
    >
      <span className="tasks-card-project">{task.projectName}</span>
      <strong className="tasks-card-title">{task.title}</strong>
      <span className="tasks-card-meta">
        <StatusIcon status={task.status} blocked={Boolean(task.blockedReason)} />
        <em className={`tasks-sub-chip is-${task.sub}`}>{SUB_STATUS_META[task.sub].label}</em>
        {task.blockedReason ?? (task.statusLabel !== SUB_STATUS_META[task.sub].label ? task.statusLabel : '')}
      </span>
      <span className="tasks-card-foot">
        <em>{task.backendId ?? 'Backend 待定'}</em>
        <em className={`tasks-card-gate is-${task.dependencyGate}`}>
          {dependencyGateShortLabel(task.dependencyGate)}
        </em>
        {task.attempt > 1 && <em>Attempt {task.attempt}</em>}
        {task.deps.length > 0 && <em>依赖 {task.deps.length}</em>}
      </span>
      {onTerminal && (taskHasTerminal(task)
        ? <CardAction label="查看" title="在项目室的共享屏幕区打开这个 worker 的终端" onClick={onTerminal} />
        : <span className="tasks-card-actions"><em className="tasks-card-waiting">等待调度，开始后可查看终端</em></span>)}
    </div>
  );
}

// ---- Observed sessions (S0 observation layer) -------------------------------

export const OBSERVED_STATE_LABEL: Record<ObservedState, string> = {
  active: '进行中',
  waiting: '等待输入',
  idle: '空闲',
  done: '会话已结束',
  unknown: '状态未知',
};

export const OBSERVED_CLIENT_LABEL: Record<ObservedClientKind, string> = {
  'claude-code': 'Claude',
  codex: 'Codex',
  kimi: 'Kimi',
};

export { subStatusForObserved };

export function columnForObserved(session: ObservedSession, now: number): TaskColumnId | null {
  const sub = subStatusForObserved(session, now);
  return sub ? SUB_STATUS_META[sub].parent : null;
}

export function formatObservedAge(ts: number): string {
  const min = Math.floor((Date.now() - ts) / 60_000);
  if (min < 1) return '刚刚活跃';
  if (min < 60) return `${min} 分钟前活跃`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前活跃`;
  return `${Math.floor(hr / 24)} 天前活跃`;
}

/** Card for an externally-launched CLI session. Deliberately NOT an
 *  AggregatedTask: observed sessions have no attempt/deps/delivery semantics.
 *  继续 reopens it in the project room — forked while it still runs elsewhere. */
function ObservedTaskCard({ session, onContinue }: { session: ObservedSession; onContinue?: () => void }) {
  const live = session.pid !== undefined;
  return (
    <div
      className={`tasks-card tasks-card-observed is-observed-${session.state}`}
      title={session.cwd}
    >
      <span className="tasks-card-project">{session.projectName}</span>
      <strong className="tasks-card-title">{session.title}</strong>
      <span className="tasks-card-meta">
        <Eye size={13} />
        {OBSERVED_STATE_LABEL[session.state]}
        <em className="tasks-card-inferred">{session.inferred ? '推断' : '本机上报'}</em>
        · {formatObservedAge(session.lastActiveAt)}
      </span>
      <span className="tasks-card-foot">
        <em className={`tasks-client-chip is-${session.clientKind}`}>
          {OBSERVED_CLIENT_LABEL[session.clientKind]}
        </em>
        {session.model && <em>{session.model}</em>}
        <em className="tasks-observed-badge">观察中</em>
      </span>
      {onContinue && session.nativeSessionId && (
        <CardAction
          label={live ? '查看' : '继续'}
          title={live ? '正在其他窗口运行：在项目室复制一个分支会话继续' : '在项目室的共享屏幕区接着打开这个会话'}
          onClick={onContinue}
        />
      )}
    </div>
  );
}

/** Cross-project task board. Reads the aggregated projection rather than any
 *  single session, so the user sees one meeting's worth of work even though
 *  each project still runs its own Orchestrator underneath. Observed sessions
 *  (external CLI windows) mix into the same columns after orchestrated cards. */
export function TasksView(props:TasksViewProps){return props.shared?<SharedTaskBoard model={props.shared} onOpen={id=>props.onOpenTask(props.shared!.meeting.id,id)} onPlan={()=>props.onOpenPlan(props.shared!.meeting.id)}/>:<LocalTasksView {...props}/>;}
function SharedTaskBoard({model,onOpen,onPlan}:{model:UnifiedModel;onOpen:(id:string)=>void;onPlan:()=>void}){return <main className="tasks-view"><header className="tasks-header"><h2>{String(model.meeting.title)} · 任务</h2>{!model.meeting.planApproved&&<button onClick={onPlan}>审阅当前计划</button>}</header><div className="tasks-board">{[['attention','待批准／待确认'],['active','执行／等待'],['settled','成果／已完成']].map(([column,label])=><section className={'tasks-column tasks-column-'+column} key={column}><header className="tasks-column-head">{label}</header><div className="tasks-column-body">{model.tasks.filter(t=>{const state=t.status==='accepted'||t.status==='delivered'?'settled':t.stopRequested||['stopped','approval','reconcile'].includes(String(t.status))?'attention':'active';return state===column;}).map(t=><button className="tasks-card" key={t.id} onClick={()=>onOpen(t.id)}><strong>{String(t.title)}</strong><span>{String(model.view.snapshot.entities.device?.find(d=>d.id===t.targetDeviceId)?.name)} · {String(t.agentId)}</span><span>{sharedPhase(t)}</span></button>)}</div></section>)}</div></main>;}
function BacklogCard({ item, onStart }: { item: BacklogItem; onStart?: () => void }) {
  return (
    <div className="tasks-card tasks-card-backlog" title={item.source ?? item.cwd}>
      <span className="tasks-card-project">{item.projectName}</span>
      <strong className="tasks-card-title">{item.title}</strong>
      <span className="tasks-card-meta">
        <ListTodo size={13} />
        <em className="tasks-sub-chip is-backlog">{item.kind === 'todo' ? 'TODO' : '待派工'}</em>
        {item.source && <span className="tasks-card-source">{item.source}</span>}
      </span>
      <span className="tasks-card-foot">
        {item.issueUrl
          ? <a href={item.issueUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>GitHub Issue ↗</a>
          : item.issueError ? <em className="tasks-card-issue-error" title={item.issueError}>Issue 未创建</em> : <em>仅看板</em>}
        <button type="button" className="tasks-card-remove" aria-label="移除这张卡片" title="移除"
          onClick={() => void window.vibeMeet.projects?.backlogRemove?.(item.id)}>
          <X size={11} />
        </button>
      </span>
      {onStart && <CardAction label="开始" title="在项目室的共享屏幕区打开本机 CLI 开始这项任务" onClick={onStart} />}
    </div>
  );
}

const LANES_KEY = 'aha.board.lanes';

function readLanes(): BoardLane[] {
  try { return parseLanes(window.localStorage.getItem(LANES_KEY)); } catch { return DEFAULT_LANES; }
}

/** 「＋ 泳道」: split any sub-status (or a parent status) into its own lane. */
function LaneMenu({ lanes, onAdd, onReset }: { lanes: BoardLane[]; onAdd: (lane: BoardLane) => void; onReset: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const has = (m: BoardLane['match']) => lanes.some((l) => JSON.stringify(l.match) === JSON.stringify(m));
  const isDefault = JSON.stringify(lanes) === JSON.stringify(DEFAULT_LANES);
  return (
    <div className="tasks-lane-menu" ref={ref}>
      <button type="button" className="tasks-lane-add" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Plus size={13} aria-hidden="true" /> 泳道
      </button>
      {open && (
        <div className="tasks-lane-pop" role="menu" aria-label="新建泳道">
          <p className="tasks-lane-pop-hint">把某个状态单独拆成一列。默认 4 列。</p>
          {TASK_COLUMNS.map((parent) => (
            <div className="tasks-lane-group" key={parent.id}>
              <button type="button" role="menuitem" className="tasks-lane-parent"
                disabled={has({ kind: 'parent', parent: parent.id })}
                onClick={() => { onAdd({ id: `p-${parent.id}`, title: parent.title, match: { kind: 'parent', parent: parent.id } }); setOpen(false); }}>
                {parent.title}
              </button>
              {SUB_STATUSES.filter((sub) => SUB_STATUS_META[sub].parent === parent.id).map((sub) => (
                <button type="button" role="menuitem" key={sub} className="tasks-lane-sub"
                  disabled={has({ kind: 'sub', sub })}
                  onClick={() => { onAdd({ id: `s-${sub}`, title: SUB_STATUS_META[sub].label, match: { kind: 'sub', sub } }); setOpen(false); }}>
                  {SUB_STATUS_META[sub].label}
                </button>
              ))}
            </div>
          ))}
          {!isDefault && (
            <button type="button" className="tasks-lane-reset" onClick={() => { onReset(); setOpen(false); }}>恢复默认 4 列</button>
          )}
        </div>
      )}
    </div>
  );
}

type LaneCard =
  | { kind: 'task'; task: AggregatedTask }
  | { kind: 'plan'; plan: CrossProjectTasks['pendingPlans'][number] }
  | { kind: 'backlog'; item: BacklogItem }
  | { kind: 'observed'; session: ObservedSession; noise: boolean };

function LocalTasksView({
  data, onOpenTask, onOpenPlan, onOpenTaskTerminal, onStartBacklog, onContinueObserved, project,
}: TasksViewProps) {
  const [projectFilter, setProjectFilter] = useState<string>(ALL);
  const [backendFilter, setBackendFilter] = useState<string>(ALL);
  const [noiseOpen, setNoiseOpen] = useState<Record<string, boolean>>({});
  const [lanes, setLanesState] = useState<BoardLane[]>(readLanes);
  const observed = useObservedTasks();
  const backlog = useBacklog();

  const setLanes = (next: BoardLane[]) => {
    setLanesState(next);
    try { window.localStorage.setItem(LANES_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
  };

  const boardableObserved = useMemo(() => {
    const now = Date.now();
    const rows: Array<{ session: ObservedSession; sub: BoardSubStatus }> = [];
    for (const session of observed.sessions) {
      const sub = subStatusForObserved(session, now);
      if (sub) rows.push({ session, sub });
    }
    rows.sort((a, b) => b.session.lastActiveAt - a.session.lastActiveAt);
    return rows;
  }, [observed]);

  // Projects are repositories: a repo's worktrees and sub-folders filter together.
  const folders = useMemo(() => [
    ...(project ? [project] : []),
    ...data.tasks.map((t) => t.cwd),
    ...data.pendingPlans.map((p) => p.cwd),
    ...backlog.map((b) => b.cwd),
    ...boardableObserved.map(({ session }) => session.cwd),
  ], [project, data, backlog, boardableObserved]);
  const repoVersion = useRepoRoots(folders);
  const currentProject = project ? projectKeyOf(project) : null;

  // Each meeting's board opens on its own project; switching meetings re-applies it.
  useEffect(() => { setProjectFilter(currentProject ?? ALL); }, [currentProject]);

  const projects = useMemo(() => {
    const seen = new Map<string, string>();
    for (const cwd of folders) {
      const key = projectKeyOf(cwd);
      if (!seen.has(key)) seen.set(key, splitPath(key).name);
    }
    return [...seen.entries()].map(([cwd, name]) => ({ cwd, name }));
    // repoVersion: re-key when repository answers arrive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, repoVersion]);

  const backends = useMemo(() => {
    const seen = new Set<string>();
    for (const t of data.tasks) if (t.backendId) seen.add(t.backendId);
    for (const { session } of boardableObserved) seen.add(session.clientKind);
    return [...seen].sort();
  }, [data.tasks, boardableObserved]);

  const inProject = (cwd: string) => projectFilter === ALL || projectKeyOf(cwd) === projectFilter;

  const byLane = useMemo(() => {
    const map = new Map<string, LaneCard[]>();
    const push = (sub: BoardSubStatus, card: LaneCard) => {
      const id = laneFor(sub, lanes);
      map.set(id, [...(map.get(id) ?? []), card]);
    };
    for (const plan of data.pendingPlans) if (inProject(plan.cwd)) push('plan-approval', { kind: 'plan', plan });
    if (backendFilter === ALL) {
      for (const item of backlog) if (inProject(item.cwd)) push('backlog', { kind: 'backlog', item });
    }
    for (const task of data.tasks) {
      if (inProject(task.cwd) && (backendFilter === ALL || task.backendId === backendFilter)) push(task.sub, { kind: 'task', task });
    }
    for (const { session, sub } of boardableObserved) {
      if (inProject(session.cwd) && (backendFilter === ALL || session.clientKind === backendFilter)) {
        push(sub, { kind: 'observed', session, noise: session.isNoise || sub === 'observed-idle' });
      }
    }
    return map;
    // inProject closes over projectFilter; repoVersion re-keys folders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, backlog, boardableObserved, lanes, projectFilter, backendFilter, repoVersion]);

  const shownLanes = byLane.has(UNSORTED_LANE_ID)
    ? [...lanes, { id: UNSORTED_LANE_ID, title: '未归类', match: { kind: 'parent', parent: 'todo' } } as BoardLane]
    : lanes;
  const total = [...byLane.values()].reduce((n, cards) => n + cards.filter((c) => !(c.kind === 'observed' && c.noise)).length, 0);

  return (
    <main className="tasks-view">
      <header className="tasks-toolbar">
        <div className="tasks-toolbar-lead">
          <strong>任务</strong>
          <span>{total} 项，{projects.length} 个项目</span>
        </div>
        <div className="tasks-filters">
          <label className="tasks-filter">
            <span>项目</span>
            <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
              {currentProject && <option value={currentProject}>本项目室（{splitPath(currentProject).name}）</option>}
              <option value={ALL}>全部项目</option>
              {projects.filter((p) => p.cwd !== currentProject).map((p) => (
                <option key={p.cwd} value={p.cwd}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="tasks-filter">
            <span>客户端</span>
            <select value={backendFilter} onChange={(e) => setBackendFilter(e.target.value)}>
              <option value={ALL}>全部客户端</option>
              {backends.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </label>
          <LaneMenu lanes={lanes} onAdd={(lane) => setLanes([...lanes, lane])} onReset={() => setLanes(DEFAULT_LANES)} />
        </div>
      </header>

      <ScanControls snapshot={observed} />
      <div className="tasks-board" style={{ gridTemplateColumns: `repeat(${shownLanes.length}, minmax(220px, 1fr))` }}>
        {shownLanes.map((lane) => {
          const cards = byLane.get(lane.id) ?? [];
          const normal = cards.filter((c) => !(c.kind === 'observed' && c.noise));
          const noise = cards.filter((c): c is Extract<LaneCard, { kind: 'observed' }> => c.kind === 'observed' && c.noise);
          const isNoiseOpen = Boolean(noiseOpen[lane.id]);
          const parent = lane.match.kind === 'parent' ? lane.match.parent : SUB_STATUS_META[lane.match.sub].parent;
          const removable = lane.id !== UNSORTED_LANE_ID && lanes.length > 1;
          return (
            <section className={`tasks-column tasks-column-${parent}${lane.match.kind === 'sub' ? ' is-sub-lane' : ''}`} key={lane.id}>
              <header className="tasks-column-head">
                <div>
                  <strong>{lane.title}</strong>
                  <small>{lane.id === UNSORTED_LANE_ID ? '它们的泳道被移除了' : laneHint(lane)}</small>
                </div>
                <span className="tasks-column-count">{normal.length}</span>
                {removable && (
                  <button type="button" className="tasks-lane-remove" aria-label={`移除泳道 ${lane.title}`} title="移除这一列"
                    onClick={() => setLanes(lanes.filter((l) => l.id !== lane.id))}>
                    <X size={11} />
                  </button>
                )}
              </header>
              <div className="tasks-column-scroll">
                {normal.map((card) => {
                  if (card.kind === 'plan') {
                    return (
                      <button type="button" key={`plan:${card.plan.sessionId}`} className="tasks-card is-plan"
                        onClick={() => onOpenPlan(card.plan.sessionId)} title={card.plan.cwd}>
                        <span className="tasks-card-project">{card.plan.projectName}</span>
                        <strong className="tasks-card-title">计划待批准</strong>
                        <span className="tasks-card-meta">
                          <ShieldAlert size={13} />
                          <em className="tasks-sub-chip is-plan-approval">计划待批准</em>
                          {card.plan.taskCount} 个任务
                        </span>
                      </button>
                    );
                  }
                  if (card.kind === 'backlog') {
                    return <BacklogCard key={`bl:${card.item.id}`} item={card.item}
                      onStart={onStartBacklog && (() => onStartBacklog(card.item))} />;
                  }
                  if (card.kind === 'task') {
                    return <TaskCard key={card.task.key} task={card.task}
                      onOpen={() => onOpenTask(card.task.sessionId, card.task.taskId)}
                      onTerminal={onOpenTaskTerminal && (() => onOpenTaskTerminal(card.task))} />;
                  }
                  return <ObservedTaskCard key={`obs:${card.session.id}`} session={card.session}
                    onContinue={onContinueObserved && (() => onContinueObserved(card.session))} />;
                })}
                {noise.length > 0 && (
                  <div className="tasks-noise-group">
                    <button type="button" className="tasks-noise-toggle"
                      onClick={() => setNoiseOpen((prev) => ({ ...prev, [lane.id]: !prev[lane.id] }))}>
                      {isNoiseOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      {noise.every((c) => !c.session.isNoise) ? '空闲会话' : '空闲和噪声'} {noise.length}
                    </button>
                    {isNoiseOpen && noise.map((card) => (
                      <ObservedTaskCard key={`obs:${card.session.id}`} session={card.session}
                        onContinue={onContinueObserved && (() => onContinueObserved(card.session))} />
                    ))}
                  </div>
                )}
                {normal.length === 0 && noise.length === 0 && (
                  <p className="tasks-column-empty">暂无</p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}
