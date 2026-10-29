import { memo, useEffect, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { TerminalProfileIcon } from './TerminalProfileIcon';
import {
  PROVIDER_LABEL,
  displayedPercent,
  emptyStatusLabel,
  formatPercent,
  formatPlan,
  formatResetIn,
  formatUpdatedAgo,
  sortWorstFirst,
  tightestSection,
  usageSections,
  usageStore,
  usageTone,
  useCountdownClock,
  usePersistedChoice,
  useUsageState,
  type ProviderUsage,
  type UsageDensity,
  type UsageDisplay,
  type UsageSection,
} from '../lib/rate-limits';

const DISPLAYS = ['remaining', 'used'] as const;
const DENSITIES = ['verbose', 'compact'] as const;

function Bar({ section, display, wide = false }: { section: UsageSection; display: UsageDisplay; wide?: boolean }) {
  const used = section.window.usedPercent;
  return (
    <span className={`usage-bar${wide ? ' is-wide' : ''}`} data-tone={usageTone(used)} aria-hidden="true">
      <span style={{ width: `${displayedPercent(used, display)}%` }} />
    </span>
  );
}

/** One provider in the strip: tightest window only (compact) or every window (detailed). */
function UsageChip({ p, display, density, now, onOpen }: {
  p: ProviderUsage;
  display: UsageDisplay;
  density: UsageDensity;
  now: number;
  onOpen: () => void;
}) {
  const sections = usageSections(p);
  const tightest = tightestSection(p);
  const shown = density === 'compact' ? (tightest ? [tightest] : []) : sections;
  const stale = p.status === 'error' && sections.length > 0;
  const title = sections.length
    ? sections.map((s) => `${s.label}：${formatPercent(s.window.usedPercent, display)}${formatResetIn(s.window.resetsAt, now) ? `，${formatResetIn(s.window.resetsAt, now)}` : ''}`).join('\n')
      + (stale ? `\n刷新失败，显示缓存：${p.error ?? ''}` : '')
    : emptyStatusLabel(p);
  return (
    <button type="button" className={`usage-chip${sections.length ? '' : ' is-empty'}`} onClick={onOpen} title={title}
      data-tone={tightest ? usageTone(tightest.window.usedPercent) : 'normal'}>
      <TerminalProfileIcon id={p.provider} size={13} />
      <span className="usage-chip-name">{PROVIDER_LABEL[p.provider]}</span>
      {shown.length ? shown.map((s) => (
        <span className="usage-chip-window" key={s.key}>
          <Bar section={s} display={display} />
          <span className="usage-chip-pct">{displayedPercent(s.window.usedPercent, display)}%</span>
          <span className="usage-chip-label">{s.label}</span>
        </span>
      )) : (
        <span className="usage-chip-status">{p.status === 'idle' || p.status === 'fetching' ? '…' : '--'}</span>
      )}
      {stale && <AlertTriangle size={11} className="usage-chip-stale" aria-label="刷新失败，显示缓存" />}
    </button>
  );
}

function RosterRow({ p, display, density, now }: { p: ProviderUsage; display: UsageDisplay; density: UsageDensity; now: number }) {
  const sections = usageSections(p);
  const plan = formatPlan(p.planType);
  const tightest = tightestSection(p);
  return (
    <div className="usage-row">
      <div className="usage-row-head">
        <span className="usage-row-icon"><TerminalProfileIcon id={p.provider} size={13} /></span>
        <span className="usage-row-name">
          {PROVIDER_LABEL[p.provider]}
          {plan && <span className="usage-row-plan"> · {plan}</span>}
        </span>
        {!sections.length ? (
          <span className="usage-row-status">{emptyStatusLabel(p)}</span>
        ) : density === 'compact' && tightest ? (
          <span className="usage-row-metric" data-tone={usageTone(tightest.window.usedPercent)}>
            {tightest.label} {formatPercent(tightest.window.usedPercent, display)}
          </span>
        ) : null}
      </div>
      {sections.length > 0 && density === 'verbose' && (
        <div className="usage-row-windows">
          {sections.map((s) => (
            <div className="usage-row-window" key={s.key}>
              <span className="usage-row-window-label">{s.label}</span>
              <Bar section={s} display={display} wide />
              <span className="usage-row-metric" data-tone={usageTone(s.window.usedPercent)}>
                {formatPercent(s.window.usedPercent, display)}
              </span>
              <span className="usage-row-reset">{formatResetIn(s.window.resetsAt, now) ?? ''}</span>
            </div>
          ))}
        </div>
      )}
      {p.status === 'error' && sections.length > 0 && (
        <div className="usage-row-warn"><AlertTriangle size={11} /> 刷新失败，显示的是缓存：{p.error}</div>
      )}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="usage-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={o.value} role="radio" aria-checked={value === o.value}
          className={value === o.value ? 'is-active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 额度条：各 AI 的订阅剩余额度（Claude / Codex / Kimi），取代原「观察中」
 * 会话缩略条。点击打开额度面板：最紧张的排最上，可刷新、切换详细/紧凑、
 * 显示剩余/已用。数据由主进程每 15 分钟拉取，窗口聚焦时（≥5 分钟）补拉。
 */
export const UsageStrip = memo(function UsageStrip() {
  const { providers, refreshing } = useUsageState();
  const [open, setOpen] = useState(false);
  const [display, setDisplay] = usePersistedChoice<UsageDisplay>('aha.usage.display', DISPLAYS, 'remaining');
  const [density, setDensity] = usePersistedChoice<UsageDensity>('aha.usage.density', DENSITIES, 'verbose');
  const ref = useRef<HTMLDivElement>(null);
  const now = useCountdownClock(providers.flatMap((p) => usageSections(p).map((s) => s.window.resetsAt)));

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (!providers.length) return null;
  const lastUpdated = Math.max(0, ...providers.map((p) => p.updatedAt));

  return (
    <div className="usage-strip" ref={ref}>
      <span className="usage-strip-label">额度</span>
      <div className="usage-strip-chips">
        {providers.map((p) => (
          <UsageChip key={p.provider} p={p} display={display} density={density} now={now} onOpen={() => setOpen((v) => !v)} />
        ))}
      </div>
      <span className="usage-strip-spacer" />
      <span className="usage-strip-updated">{refreshing ? '刷新中…' : formatUpdatedAgo(lastUpdated, Date.now())}</span>
      <button type="button" className="usage-strip-refresh" onClick={usageStore.refresh} disabled={refreshing}
        aria-label="刷新额度" title="刷新额度">
        <RefreshCw size={12} className={refreshing ? 'is-spinning' : ''} />
      </button>

      {open && (
        <div className="usage-panel" role="dialog" aria-label="各 AI 额度">
          <div className="usage-panel-head">
            <strong>额度</strong>
            <span>全部 AI · 最紧张的在上</span>
          </div>
          <div className="usage-panel-controls">
            <Segmented label="显示方式" value={display} onChange={setDisplay}
              options={[{ value: 'remaining', label: '显示剩余' }, { value: 'used', label: '显示已用' }]} />
            <Segmented label="额度条详细程度" value={density} onChange={setDensity}
              options={[{ value: 'verbose', label: '详细' }, { value: 'compact', label: '紧凑' }]} />
          </div>
          <div className="usage-panel-rows">
            {sortWorstFirst(providers).map((p) => (
              <RosterRow key={p.provider} p={p} display={display} density={density} now={now} />
            ))}
          </div>
          <div className="usage-panel-foot">
            每 15 分钟自动刷新。读取各 CLI 的本机登录，不另存凭据。
          </div>
        </div>
      )}
    </div>
  );
});
