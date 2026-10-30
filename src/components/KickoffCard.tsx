import { useMemo, useState } from 'react';
import { Lightbulb, Hammer } from 'lucide-react';
import type { BackendInfo } from '../types';

export type KickoffMode = 'brainstorm' | 'develop';

/** AME-D14 职能＋名字; one expert per mode for the first kickoff. */
export const KICKOFF_EXPERTS: Record<KickoffMode, { title: string; name: string }> = {
  brainstorm: { title: '产品专家', name: '小禾' },
  develop: { title: '研发专家', name: '小石' },
};

const HOST_OF_TERMINAL: Record<string, string> = {
  'claude-code-terminal': 'claude-code',
  'codex-terminal': 'codex',
  'kimi-code-terminal': 'kimi',
  'qoder-terminal': 'qoder',
};

/** Experts are talker hosts, so terminal-only and remote backends can't be one. */
export function expertBackendOptions(backends: BackendInfo[]): BackendInfo[] {
  return backends.filter((b) => !b.id.endsWith('-terminal') && b.id !== 'pocket-vibe' && (b.loggedIn || b.hasApiKey));
}

/** Default expert = the host-side twin of the default Worker backend. */
export function defaultExpertBackend(backends: BackendInfo[]): string | null {
  const options = expertBackendOptions(backends);
  const worker = backends.find((b) => b.id === 'claude-code')?.effectiveDefaultWorkerBackendId ?? null;
  const preferred = worker ? HOST_OF_TERMINAL[worker] ?? worker : null;
  return options.find((b) => b.id === preferred)?.id ?? options[0]?.id ?? null;
}

interface KickoffCardProps {
  backends: BackendInfo[];
  busy: boolean;
  error: string | null;
  onStart: (mode: KickoffMode, expertBackendId: string) => void;
  onSkip: () => void;
}

/**
 * 空项目开场卡片：先问「讨论脑暴」还是「开始开发」。点「开始」即为本阶段
 * 计划确认（AME-D23）：请专家入会、专家派出一个子 Agent 在共享区第三个标签
 * 工作、助理在工作区整理纪要。
 */
export function KickoffCard({ backends, busy, error, onStart, onSkip }: KickoffCardProps) {
  const [mode, setMode] = useState<KickoffMode>('brainstorm');
  const options = useMemo(() => expertBackendOptions(backends), [backends]);
  const [backendId, setBackendId] = useState<string | null>(null);
  const chosen = backendId ?? defaultExpertBackend(backends);
  const expert = KICKOFF_EXPERTS[mode];

  return (
    <section className="kickoff" role="dialog" aria-label="这个项目还是空的，先做什么？">
      <h2>这个项目还是空的，先做什么？</h2>
      <div className="kickoff-modes" role="radiogroup" aria-label="开场方式">
        <button type="button" role="radio" aria-checked={mode === 'brainstorm'}
          className={`kickoff-mode${mode === 'brainstorm' ? ' is-active' : ''}`} onClick={() => setMode('brainstorm')}>
          <Lightbulb size={18} aria-hidden="true" />
          <span><strong>讨论脑暴</strong><small>理清目标、用户和方案，不改代码</small></span>
        </button>
        <button type="button" role="radio" aria-checked={mode === 'develop'}
          className={`kickoff-mode${mode === 'develop' ? ' is-active' : ''}`} onClick={() => setMode('develop')}>
          <Hammer size={18} aria-hidden="true" />
          <span><strong>开始开发</strong><small>先搭最小骨架，子 Agent 在工作树里写代码</small></span>
        </button>
      </div>

      <ol className="kickoff-steps">
        <li>
          请「{expert.title} {expert.name}」入会，用
          <select value={chosen ?? ''} onChange={(e) => setBackendId(e.target.value)} disabled={busy || !options.length} aria-label="专家用哪个 AI">
            {options.map((b) => <option key={b.id} value={b.id}>{b.displayName}</option>)}
          </select>
        </li>
        <li>{expert.name}派一个子 Agent，在共享区第三个标签用原生 CLI {mode === 'brainstorm' ? '只读调研' : '搭骨架'}，你可以看，需要时接管</li>
        <li>助理在「工作区」实时整理结论、决策和待办，你确认后再写进看板</li>
      </ol>

      {!options.length && <p className="kickoff-error">还没有已登录的 AI 后端，先在设置里登录一个。</p>}
      {error && <p className="kickoff-error" role="alert">{error}</p>}

      <div className="kickoff-actions">
        <button type="button" className="kickoff-start" disabled={busy || !chosen} onClick={() => chosen && onStart(mode, chosen)}>
          {busy ? '正在请专家…' : '开始'}
        </button>
        <button type="button" className="kickoff-skip" onClick={onSkip} disabled={busy}>先不用，我自己说</button>
      </div>
    </section>
  );
}
