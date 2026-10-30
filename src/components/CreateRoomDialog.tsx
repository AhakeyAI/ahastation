import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, FolderOpen, FolderPlus, X } from 'lucide-react';
import { usePickCwd } from './DirPickerModal';

export type RoomEntryMode = 'meeting' | 'cli';
type Step = 'choose' | 'clone' | 'create';

interface CreateRoomDialogProps {
  open: boolean;
  /** Recently opened folders: the clone / create location defaults next to them. */
  recent: string[];
  onClose: () => void;
  /** A folder is ready (picked, cloned or created); open it the chosen way. */
  onReady: (path: string, mode: RoomEntryMode, fresh: boolean) => void;
}

/**
 * 新建项目室：三种来源（本机文件夹、Git / GitHub 克隆、新建空项目）加进入方式
 * （开会议 / 只开 CLI 工作区）。取代启动台的「打开项目文件夹」和「打开本地
 * CLI 工作区」两个按钮。流程对标 Orca 的 Add Project 对话框。
 */
export function CreateRoomDialog({ open, recent, onClose, onReady }: CreateRoomDialogProps) {
  const { pickCwd, pickerModal } = usePickCwd();
  const [step, setStep] = useState<Step>('choose');
  const [mode, setMode] = useState<RoomEntryMode>('meeting');
  const [parent, setParent] = useState('');
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [useGit, setUseGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep('choose');
    setError(null);
    setProgress('');
    setUrl('');
    setName('');
    void window.vibeMeet.projects?.defaultParent(recent).then((res) => { if (res.ok) setParent(res.path); });
    // `recent` only seeds the default location when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { if (step !== 'choose') firstField.current?.focus(); }, [step]);

  useEffect(() => {
    if (!busy || step !== 'clone') return;
    return window.vibeMeet.projects?.onCloneProgress(({ line }) => setProgress(line));
  }, [busy, step]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const pickLocal = async () => {
    const dir = await pickCwd();
    if (dir) onReady(dir, mode, false);
  };

  const pickParent = async () => {
    const dir = await pickCwd(parent || undefined);
    if (dir) setParent(dir);
  };

  const submit = async () => {
    const api = window.vibeMeet.projects;
    if (!api) { setError('当前版本不支持新建项目，请升级 AhaStudio。'); return; }
    setBusy(true);
    setError(null);
    setProgress('');
    try {
      const res = step === 'clone' ? await api.clone(url, parent) : await api.create(parent, name, useGit);
      if (res.ok) onReady(res.path, mode, true);
      else setError(res.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = !busy && !!parent && (step === 'clone' ? !!url.trim() : !!name.trim());
  const cloneTarget = url.trim() ? url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop()?.replace(/\.git$/, '') : '';
  const target = step === 'clone' ? cloneTarget : name.trim();

  return (
    <div className="ui-modal-backdrop create-room-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <section className="create-room" role="dialog" aria-modal="true" aria-label="新建项目室">
        <header className="create-room-head">
          {step !== 'choose' && (
            <button type="button" className="create-room-back" onClick={() => { setStep('choose'); setError(null); }} disabled={busy} aria-label="返回">
              <ArrowLeft size={16} />
            </button>
          )}
          <h2>{step === 'clone' ? '从 Git 克隆' : step === 'create' ? '新建空项目' : '新建项目室'}</h2>
          <button type="button" className="create-room-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={16} /></button>
        </header>

        {step === 'choose' && (
          <div className="create-room-sources">
            <button type="button" className="create-room-source" onClick={() => void pickLocal()}>
              <FolderOpen size={20} aria-hidden="true" />
              <span><strong>打开本机文件夹</strong><small>选一个已有的项目目录</small></span>
            </button>
            <button type="button" className="create-room-source" onClick={() => setStep('clone')}>
              <Download size={20} aria-hidden="true" />
              <span><strong>从 Git 或 GitHub 克隆</strong><small>粘贴仓库地址，或写成 owner/repo</small></span>
            </button>
            <button type="button" className="create-room-source" onClick={() => setStep('create')}>
              <FolderPlus size={20} aria-hidden="true" />
              <span><strong>新建空项目</strong><small>起个名字，自动建好 git 仓库</small></span>
            </button>
          </div>
        )}

        {step !== 'choose' && (
          <div className="create-room-form">
            {step === 'clone' ? (
              <label>
                <span>仓库地址</span>
                <input ref={firstField} value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy}
                  placeholder="https://github.com/owner/repo 或 owner/repo" spellCheck={false}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void submit(); }} />
              </label>
            ) : (
              <label>
                <span>项目名称</span>
                <input ref={firstField} value={name} onChange={(e) => setName(e.target.value)} disabled={busy}
                  placeholder="my-project" spellCheck={false}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) void submit(); }} />
              </label>
            )}
            <label>
              <span>放在</span>
              <span className="create-room-path">
                <input value={parent} onChange={(e) => setParent(e.target.value)} disabled={busy} spellCheck={false} />
                <button type="button" onClick={() => void pickParent()} disabled={busy}>选择…</button>
              </span>
            </label>
            {target && parent && <p className="create-room-target">将创建 {parent.replace(/\/+$/, '')}/{target}</p>}
            {step === 'create' && (
              <label className="create-room-check">
                <input type="checkbox" checked={useGit} onChange={(e) => setUseGit(e.target.checked)} disabled={busy} />
                <span>建成 git 仓库（推荐，Worker 需要用它开工作树）</span>
              </label>
            )}
            {busy && step === 'clone' && <p className="create-room-progress" role="status">{progress || '正在连接仓库…'}</p>}
            {error && <p className="create-room-error" role="alert">{error}</p>}
          </div>
        )}

        <footer className="create-room-foot">
          <div className="create-room-mode" role="radiogroup" aria-label="进入方式">
            <span>进入方式</span>
            {(['meeting', 'cli'] as const).map((m) => (
              <button type="button" role="radio" aria-checked={mode === m} key={m}
                className={mode === m ? 'is-active' : ''} onClick={() => setMode(m)} disabled={busy}>
                {m === 'meeting' ? '开会议' : '只开 CLI 工作区'}
              </button>
            ))}
          </div>
          {step !== 'choose' && (
            busy && step === 'clone' ? (
              <button type="button" className="create-room-secondary" onClick={() => void window.vibeMeet.projects?.abortClone()}>取消克隆</button>
            ) : (
              <button type="button" className="create-room-primary" onClick={() => void submit()} disabled={!canSubmit}>
                {busy ? '正在创建…' : step === 'clone' ? '克隆并进入' : '创建并进入'}
              </button>
            )
          )}
        </footer>
      </section>
      {pickerModal}
    </div>
  );
}
