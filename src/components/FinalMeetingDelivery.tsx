import type { FinalMeetingDecision, MeetingDelivery } from '../types';

interface FinalMeetingDeliveryProps {
  delivery: MeetingDelivery;
  decision: FinalMeetingDecision | null;
}

export function FinalMeetingDelivery({
  delivery,
  decision,
}: FinalMeetingDeliveryProps) {
  return (
    <section className="final-meeting-delivery" aria-labelledby="final-meeting-delivery-title">
      <header>
        <div>
          <p className="final-meeting-delivery-kicker">最终 Meeting 交付</p>
          <h2 id="final-meeting-delivery-title">
            计划 v{delivery.planVersion} 已全部进入 Meeting 集成分支
          </h2>
        </div>
        <span className={`final-meeting-delivery-state is-${delivery.publicationState}`}>
          {delivery.publicationState === 'published' ? '已发布到主工作区' : '仅在 Meeting 集成分支（未发布）'}
        </span>
      </header>

      <dl className="final-meeting-delivery-facts">
        <div><dt>集成 HEAD</dt><dd><code>{delivery.integrationHead.slice(0, 12)}</code></dd></div>
        <div><dt>任务</dt><dd>{delivery.tasks.length} 个已进 Meeting 分支</dd></div>
        <div><dt>文件</dt><dd>{delivery.changedFiles.length} 个变更</dd></div>
        <div><dt>高风险确认</dt><dd>{delivery.approvals.length} 项</dd></div>
      </dl>

      <div className="final-meeting-delivery-grid">
        <section>
          <h3>任务验证与审查</h3>
          {delivery.tasks.map((task) => (
            <article key={task.taskId} className="final-meeting-task-evidence">
              <strong>{task.title}</strong>
              <small>{task.taskId} · Attempt {task.attempt} · {task.integratedCommit.slice(0, 10)}</small>
              <p>✓ 验证 {task.verification.checks.length} 项 · ✓ Diff 审查完成</p>
              {task.limitations.map((item) => <p key={item} className="is-limitation">限制：{item}</p>)}
            </article>
          ))}
        </section>
        <section>
          <h3>集成文件</h3>
          <ul className="final-meeting-file-list">
            {delivery.changedFiles.map((file) => (
              <li key={`${file.taskId}:${file.path}`}>
                <code>{file.path}</code>
                <span>{file.status} · +{file.additions ?? '?'} / -{file.deletions ?? '?'}</span>
              </li>
            ))}
          </ul>
          {delivery.unresolvedWork.length > 0 && (
            <>
              <h3>未解决工作</h3>
              <ul>{delivery.unresolvedWork.map((item) => <li key={item.taskId}>{item.title}: {item.reason}</li>)}</ul>
            </>
          )}
        </section>
      </div>

      {decision?.kind === 'accept' && <p role="status">最终交付已发布到主工作区。</p>}
    </section>
  );
}
