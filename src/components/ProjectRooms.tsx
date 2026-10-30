import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, EyeOff, RefreshCw, Radar, Trash2, X } from 'lucide-react';
import { TerminalProfileIcon } from './TerminalProfileIcon';
import { ROOMS_PREVIEW, roomStatus, visibleSeats, type ProjectRoom } from '../lib/project-rooms';
import type { ObservedClientKind, ObservedSnapshot } from '../lib/observed-store';

const CLIENT_LABEL: Record<ObservedClientKind, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  kimi: 'Kimi',
};
/** TerminalProfileIcon ids for each observed client. */
const CLIENT_ICON: Record<ObservedClientKind, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  kimi: 'kimi',
};

/** A scan reads as a beat, not a flash; give up waiting for a fresh snapshot after this. */
const SCAN_MIN_MS = 1600;
const SCAN_MAX_MS = 6000;
const LINE_STAGGER_MS = 280;
const MAX_SCAN_LINES = 5;

function relative(ts: number): string {
  if (!ts) return '';
  const min = Math.floor((Date.now() - ts) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const days = Math.floor(hr / 24);
  return days < 7 ? `${days} 天前` : new Date(ts).toLocaleDateString();
}

function placeSummary(room: ProjectRoom): string {
  if (room.other) return room.parent;
  return room.places.length ? `主目录 + ${room.places.length} 个工作树或子目录` : room.parent;
}

function RoomTile({ room, disabled, onOpen }: { room: ProjectRoom; disabled: boolean; onOpen: () => void }) {
  const { shown, overflow } = visibleSeats(room.seats);
  const status = roomStatus(room.seats);
  const live = room.seats.some((s) => s.state === 'active' || s.state === 'waiting');
  const perPlace = new Map<string, number>();
  for (const seat of room.seats) perPlace.set(seat.place ?? '主目录', (perPlace.get(seat.place ?? '主目录') ?? 0) + 1);
  const seatSummary = room.seats.length
    ? [`${room.seats.length} 个 AI 会话`, ...[...perPlace].map(([place, n]) => `${place}：${n} 个`)].join('\n')
    : '还没有 AI 会话';
  const body = (
    <>
      <span className="room-head">
        <span className="room-name">{room.name}</span>
        {room.recoverableMeetingId && <span className="room-badge">可恢复</span>}
      </span>
      <span className="room-path">{placeSummary(room)}</span>
      <span className="room-foot">
        <span className="room-meta">
          {status && <span className="room-status">{status}</span>}
          <span className="room-time">{relative(room.lastActiveAt)}</span>
        </span>
        {room.seats.length > 0 && (
          <span className="room-seats" aria-label={seatSummary}>
            {shown.map((seat) => (
              <span key={seat.id} className={`room-seat is-${seat.state}`}
                title={`${CLIENT_LABEL[seat.client]}${seat.place ? `（${seat.place}）` : ''}：${seat.title}`}>
                <TerminalProfileIcon id={CLIENT_ICON[seat.client]} size={14} />
              </span>
            ))}
            {overflow > 0 && (
              <span className="room-seat room-seat-more" title={`还有 ${overflow} 个会话`}>+</span>
            )}
          </span>
        )}
      </span>
    </>
  );
  // 其他会话 has no folder to meet in; it only lists what was found.
  if (room.other) {
    return <div className="room-tile is-other" role="group" aria-label="其他会话" title={seatSummary}>{body}</div>;
  }
  return (
    <button
      type="button"
      className={`room-tile${live ? ' is-live' : ''}`}
      onClick={onOpen}
      disabled={disabled}
      title={`${room.cwd}\n${seatSummary}`}
    >
      {body}
    </button>
  );
}

/** Tile plus its close menu: hide the room only, or end its sessions and
 *  delete worktree branches (real folders only). */
function RoomCell({ room, disabled, onOpen, onHide, onCleanup }: {
  room: ProjectRoom;
  disabled: boolean;
  onOpen: () => void;
  onHide: () => void;
  onCleanup: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const cellRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (cellRef.current && e.target instanceof Node && !cellRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);
  return (
    <div className={`room-cell${menuOpen ? ' is-menu-open' : ''}`} ref={cellRef}>
      <RoomTile room={room} disabled={disabled} onOpen={onOpen} />
      <button
        type="button"
        className="room-close"
        aria-label={`关闭项目室 ${room.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="关闭项目室"
        onClick={() => setMenuOpen((v) => !v)}
      >
        <X size={13} />
      </button>
      {menuOpen && (
        <div className="room-menu" role="menu" aria-label={`关闭 ${room.name}`}>
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onHide(); }}>
            <EyeOff size={14} aria-hidden="true" />
            <span><strong>只从项目室隐藏</strong><small>会话、文件和分支都不动</small></span>
          </button>
          {!room.other && (
            <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenuOpen(false); onCleanup(); }}>
              <Trash2 size={14} aria-hidden="true" />
              <span><strong>结束会话并删除分支…</strong><small>先列出来，由你勾选再执行</small></span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface ProjectRoomsProps {
  rooms: ProjectRoom[];
  observed: ObservedSnapshot;
  /** Never scanned on this machine: lead with the scan guide. */
  firstLaunch: boolean;
  opening: boolean;
  onOpen: (room: ProjectRoom) => void;
  /** Rooms the user hid; listed under 「已隐藏」 so they can come back. */
  hiddenRooms: ProjectRoom[];
  onHide: (room: ProjectRoom) => void;
  onRestore: (room: ProjectRoom) => void;
  onCleanup: (room: ProjectRoom) => void;
  /** A user-started scan finished (marks onboarding done). */
  onScanned: () => void;
}

/**
 * 启动台「项目室」：每个项目一个房间，右下角坐着正在这里工作的 AI。取代
 * 原来的扫描弹窗和「最近打开」「中断的会议」列表。
 *
 * - 首次启动：区块本身就是扫描引导，扫完全部展开。
 * - 之后启动：观察层自动扫描，不弹窗；有结果时出一条提醒，点「查看」才展开。
 * - 平时只显示最近活动的 3 个，其余收起；每次扫描完成后全部展开。
 */
export function ProjectRooms({ rooms, observed, firstLaunch, opening, onOpen, hiddenRooms, onHide, onRestore, onCleanup, onScanned }: ProjectRoomsProps) {
  const [scanning, setScanning] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [reminderDismissed, setReminderDismissed] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const scanFrom = useRef(0);

  // Scan = wait for a snapshot newer than the one on screen when it started
  // (the observation layer rescans every few seconds).
  useEffect(() => {
    if (!scanning) return;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Date.now() - started), 100);
    return () => window.clearInterval(timer);
  }, [scanning]);

  const fresh = observed.scannedAt > scanFrom.current;
  useEffect(() => {
    if (!scanning) return;
    if ((fresh && elapsed >= SCAN_MIN_MS) || elapsed >= SCAN_MAX_MS) {
      setScanning(false);
      setShowAll(true);
      setReminderDismissed(true);
      onScanned();
    }
  }, [scanning, fresh, elapsed, onScanned]);

  const startScan = () => {
    scanFrom.current = observed.scannedAt;
    setScanning(true);
  };

  const discovered = useMemo(() => {
    const seen = new Set<string>();
    const out: { key: string; label: string; client: ObservedClientKind }[] = [];
    for (const s of observed.sessions) {
      if (s.isNoise) continue;
      const key = `${s.clientKind}|${s.projectName}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label: `${CLIENT_LABEL[s.clientKind]} 在 ${s.projectName}`, client: s.clientKind });
    }
    return out;
  }, [observed]);
  const revealed = Math.min(discovered.length, MAX_SCAN_LINES, Math.max(0, Math.floor((elapsed - 300) / LINE_STAGGER_MS) + 1));

  const scannedRooms = rooms.filter((r) => r.seats.length > 0 && !r.other);
  const sessionCount = scannedRooms.reduce((n, r) => n + r.seats.length, 0);
  const showReminder = !firstLaunch && !scanning && !showAll && !reminderDismissed && observed.scannedAt > 0 && scannedRooms.length > 0;

  if (firstLaunch && !scanning) {
    return (
      <section className="rooms rooms-guide" aria-label="扫描本机 AI 会话">
        <div className="rooms-guide-icon" aria-hidden="true"><Radar size={22} /></div>
        <div className="rooms-guide-text">
          <h2>先看看你的 AI 都在哪些项目里工作</h2>
          <p>只读扫描本机的 Claude Code、Codex、Kimi 会话，按项目排成项目室。不需要授权，也不会改动任何文件。</p>
        </div>
        <button type="button" className="rooms-guide-cta" onClick={startScan}>扫描本机 AI 会话</button>
      </section>
    );
  }

  const visible = showAll ? rooms : rooms.slice(0, ROOMS_PREVIEW);
  const hidden = rooms.length - visible.length;

  return (
    <section className="rooms" aria-label="项目室">
      <header className="rooms-head">
        <h2>项目室</h2>
        <span className="rooms-sub">
          {scanning ? '正在扫描本机 AI 会话…' : observed.scannedAt ? `${scannedRooms.length} 个项目里有 ${sessionCount} 个 AI 会话` : '最近的项目'}
        </span>
        <button type="button" className="rooms-rescan" onClick={startScan} disabled={scanning}>
          <RefreshCw size={12} aria-hidden="true" className={scanning ? 'is-spinning' : ''} />
          {scanning ? '扫描中' : '重新扫描'}
        </button>
      </header>

      {scanning && (
        <div className="rooms-scan" role="status" aria-live="polite">
          <span className="rooms-scan-ring" aria-hidden="true" />
          <ul className="rooms-scan-lines">
            {discovered.slice(0, revealed).map((line) => (
              <li key={line.key}><TerminalProfileIcon id={CLIENT_ICON[line.client]} size={12} />发现 {line.label}</li>
            ))}
            {elapsed >= SCAN_MAX_MS - 500 && !discovered.length && <li>没有发现本机 AI 会话</li>}
          </ul>
        </div>
      )}

      {showReminder && (
        <div className="rooms-reminder">
          <span>自动扫描发现 {scannedRooms.length} 个项目室有 AI 在工作，要看看吗？</span>
          <button type="button" className="rooms-reminder-view" onClick={() => { setShowAll(true); setReminderDismissed(true); }}>查看</button>
          <button type="button" className="rooms-reminder-close" aria-label="不看了" onClick={() => setReminderDismissed(true)}><X size={12} /></button>
        </div>
      )}

      {!scanning && (rooms.length ? (
        <>
          <div className="rooms-grid">
            {visible.map((room) => (
              <RoomCell key={room.cwd || '__other__'} room={room} disabled={opening} onOpen={() => onOpen(room)}
                onHide={() => onHide(room)} onCleanup={() => onCleanup(room)} />
            ))}
          </div>
          {(hidden > 0 || (showAll && rooms.length > ROOMS_PREVIEW)) && (
            <button type="button" className="rooms-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              <ChevronDown size={14} aria-hidden="true" className={showAll ? 'is-open' : ''} />
              {showAll ? '只看最近 3 个' : `展开其他 ${hidden} 个项目室`}
            </button>
          )}
        </>
      ) : hiddenRooms.length ? (
        <p className="rooms-empty">项目室都隐藏了。需要时从下面恢复，或者新建一个项目室。</p>
      ) : (
        <p className="rooms-empty">还没有项目室。打开一个项目文件夹，或者在终端里用 Claude Code、Codex 干点活，再回来扫描。</p>
      ))}

      {!scanning && hiddenRooms.length > 0 && (
        <div className="rooms-hidden">
          <button type="button" className="rooms-hidden-toggle" aria-expanded={hiddenOpen} onClick={() => setHiddenOpen((v) => !v)}>
            <ChevronDown size={12} aria-hidden="true" className={hiddenOpen ? 'is-open' : ''} />
            已隐藏 {hiddenRooms.length} 个项目室
          </button>
          {hiddenOpen && (
            <ul className="rooms-hidden-list">
              {hiddenRooms.map((room) => (
                <li key={room.cwd || '__other__'}>
                  <span className="rooms-hidden-name" title={room.cwd || room.parent}>{room.name}</span>
                  <span className="rooms-hidden-path">{room.other ? room.parent : room.cwd}</span>
                  <button type="button" onClick={() => onRestore(room)}>恢复显示</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
