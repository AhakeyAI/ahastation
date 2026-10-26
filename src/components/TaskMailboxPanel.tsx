import {SharedScopeRevision} from './SharedScopeRevision';
import { useMemo, useState } from 'react';
import { CornerDownRight, Octagon, Route } from 'lucide-react';
import type { RendererTaskSnapshot, TaskMessage } from '../types';

const MESSAGE_STATUS: Record<TaskMessage['status'], string> = {
  queued: '排队中',
  delivered: '已送达',
  acknowledged: '已确认',
  failed: '待重试',
};

function visiblePayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const value = payload as Record<string, unknown>;
    if (typeof value.text === 'string') return value.text;
    if (typeof value.question === 'string') return value.question;
    if (typeof value.answer === 'string') return value.answer;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return '结构化消息';
  }
}

export function TaskMailboxPanel({
  sessionId,
  taskId,
  snapshot,
}: {
  sessionId: string;
  taskId: string;
  snapshot: RendererTaskSnapshot;
}) {
  const [followUp, setFollowUp] = useState('');
  const [steering, setSteering] = useState('');
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const messages = useMemo(
    () => [...snapshot.mailbox].sort((left, right) => left.seq - right.seq),
    [snapshot.mailbox],
  );

  const runAction = async (
    kind: 'follow-up' | 'steer' | 'interrupt',
    action: () => Promise<{ ok: boolean; error?: string }>,
  ) => {
    setPendingAction(kind);
    setFeedback('');
    try {
      const result = await action();
      setFeedback(result.ok
        ? kind === 'follow-up'
          ? 'Follow-up 已进入 FIFO 队列。'
          : kind === 'steer'
            ? 'Steering 已排队，将在安全边界送达。'
            : 'Interrupt 已请求；工作区与恢复点会保留。'
        : result.error ?? '操作失败');
      return result.ok;
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="task-mailbox-panel">
      <section className="task-control-stack" aria-label="Task message controls">
        <label>
          <span><CornerDownRight size={14} /> Follow-up</span>
          <textarea
            value={followUp}
            onChange={(event) => setFollowUp(event.target.value)}
            placeholder="在当前执行完成后继续处理…"
            maxLength={100_000}
          />
          <button
            type="button"
            disabled={pendingAction !== null || !followUp.trim()}
            onClick={() => {
              const text = followUp.trim();
              if (!text) return;
              void runAction('follow-up', () => (
                window.vibeMeet.tasks.followUp(sessionId, taskId, text)
              )).then((ok) => {
                if (ok) setFollowUp('');
              });
            }}
          >
            加入后续队列
          </button>
        </label>

        <label>
          <span><Route size={14} /> Steering</span>
          <textarea
            value={steering}
            onChange={(event) => setSteering(event.target.value)}
            placeholder="调整方向；当前不可中断步骤不会被篡改…"
            maxLength={100_000}
          />
          <button
            type="button"
            disabled={pendingAction !== null || !steering.trim()}
            onClick={() => {
              const text = steering.trim();
              if (!text) return;
              void runAction('steer', () => (
                window.vibeMeet.tasks.steer(sessionId, taskId, text)
              )).then((ok) => {
                if (ok) setSteering('');
              });
            }}
          >
            在安全边界转向
          </button>
        </label>

        <button
          type="button"
          className="task-interrupt-button"
          disabled={pendingAction !== null}
          onClick={() => {
            void runAction('interrupt', () => (
              window.vibeMeet.tasks.interrupt(sessionId, taskId, 'User interrupted from Task Inspector')
            ));
          }}
        >
          <Octagon size={14} /> Interrupt Task
        </button>
        {feedback && <p className="task-control-feedback" role="status">{feedback}</p>}
      </section>

      <section className="task-message-list" aria-label="Task mailbox">
        <header>
          <strong>Mailbox</strong>
          <span>{messages.length}{snapshot.mailboxTruncated ? '+' : ''} 条</span>
        </header>
        {messages.length === 0 ? (
          <p className="task-empty-state">尚无 Coordinator、Worker 或用户消息。</p>
        ) : (
          <ol>
            {messages.map((message) => (
              <li key={message.id}>
                <div>
                  <strong>{message.sender}</strong>
                  <span>{message.kind}</span>
                  <time>{new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                </div>
                <p>{visiblePayload(message.payload).slice(0, 4_000)}</p>
                <small className={`is-${message.status}`}>
                  {MESSAGE_STATUS[message.status]} · seq {message.seq}
                </small>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
import type {SharedEntity} from '../../electron/collaboration/production-types';
import {sharedCommand} from '../lib/unified-meeting-store';
import {perform} from './UnifiedMeetingParts';

export function SharedTaskMailbox({task}:{task:SharedEntity}){
  const [text,setText]=useState('');
  const canContinue=task.status==='stopped'||(task.stopRequested===true||Number(task.scopeVersion??0)>Number((task.delivery as {scopeVersion?:number}|undefined)?.scopeVersion??0))&&task.exitConfirmed===true&&['executed','delivery-pending','delivered'].includes(String(task.status));
  const pending=(task.pendingFollowups??[]) as Array<{id:string;text:string;delivered:boolean;ignored?:boolean}>;
  const [decisions,setDecisions]=useState<Record<string,'include'|'ignore'>>({});
  const [edits,setEdits]=useState<Record<string,string>>({});
  return <section><h3>此任务的补充与继续</h3><SharedScopeRevision task={task}/><p>当前范围版本 {String(task.scopeVersion??0)}；历史范围 {Array.isArray(task.scopeHistory)?task.scopeHistory.length:0} 版。</p><p>先保存，到交付边界再投递；停止后需核对并明确继续。</p>{pending.map(f=><p key={f.id}>{!f.delivered&&!f.ignored&&canContinue?<textarea value={edits[f.id]??f.text} onChange={e=>setEdits({...edits,[f.id]:e.target.value})}/>:f.text} · {f.delivered?'已投递':f.ignored?'已忽略':'已保存，尚未执行'}{!f.delivered&&!f.ignored&&<select value={decisions[f.id]??'include'} onChange={e=>setDecisions({...decisions,[f.id]:e.target.value as 'include'|'ignore'})}><option value="include">纳入继续</option><option value="ignore">忽略</option></select>}</p>)}<textarea value={text} onChange={e=>setText(e.target.value)} placeholder="只补充此项完整任务"/><button disabled={!text.trim()||task.status==='accepted'} onClick={()=>{perform(sharedCommand('task.control',{taskId:task.id,attemptId:task.attemptId,operation:'supplement',text}));setText('');}}>保存此任务补充</button>{canContinue&&<button onClick={()=>perform(sharedCommand('task.control',{taskId:task.id,attemptId:task.attemptId,operation:'continue',expectedScopeVersion:Number(task.scopeVersion??0),text:String(task.objective),followups:pending.filter(f=>!f.delivered&&!f.ignored).map(f=>({id:f.id,action:decisions[f.id]??'include',text:edits[f.id]??f.text}))}))}>核对后继续原任务</button>}</section>;
}
