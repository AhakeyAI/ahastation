// Local tabs borrow a persistent TerminalSession; only explicit tab close
// ends it. Legacy drawer shells use usePtyTerminal and end on unmount.
// Distinct from RealTerminal (worker PTY, attach mode).

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { usePtyTerminal } from '../hooks/usePtyTerminal';
import { stageWindowStore } from '../lib/stage-window-store';
import { terminalSessionStore } from '../lib/terminal-session-store';
import { toast } from '../lib/toast';
import type { ContinueSessionRequest } from '../types';

interface ShellTerminalProps {
  cwd?: string;
  cliId?: string;
  shellId?: string;
  /** A tab owns its process until explicitly closed, including across mounts. */
  terminalId?: string;
  continueSession?: ContinueSessionRequest;
  initialPrompt?: string;
}

export function ShellTerminal({ cwd, cliId, shellId, terminalId, continueSession, initialPrompt }: ShellTerminalProps) {
  if (terminalId) {
    return <PersistentShellTerminal cwd={cwd} cliId={cliId} shellId={shellId} terminalId={terminalId}
      continueSession={continueSession} initialPrompt={initialPrompt} />;
  }
  return <LegacyShellTerminal cwd={cwd} cliId={cliId} />;
}

function PersistentShellTerminal({
  cwd, cliId, shellId, terminalId, continueSession, initialPrompt,
}: ShellTerminalProps & { terminalId: string }) {
  const container = useRef<HTMLDivElement>(null);
  useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getSnapshot);
  const state = terminalSessionStore.getState(terminalId);
  useEffect(() => {
    const host = container.current!;
    const api = window.vibeMeet.shellPty;
    const session = terminalSessionStore.acquire(terminalId, {
      expectedPtyId: `local-${terminalId}`,
      attach: async (size) => {
        const result = await api.create({ cwd, cliId, shellId, terminalId, ...size,
          ...(continueSession ? { continueSession } : {}), ...(initialPrompt ? { initialPrompt } : {}) });
        if (result.ok && result.notice) toast.info(result.notice);
        return result.ok ? result : { ok: false, error: result.error ?? '无法启动终端' };
      },
      input: async (id, data) => { const result = await api.input(id, data); if (!result.ok) throw new Error(result.error ?? '输入失败'); },
      resize: (id, rows, cols) => { void api.resize(id, rows, cols); },
      onData: api.onData, onExit: api.onExit,
      dispose: async (id) => { const result = await api.kill(id); if (!result.ok) throw new Error(result.error ?? '关闭失败'); },
    });
    session.mount(host);
    return () => session.unmount(host);
  }, [terminalId, cwd, cliId, shellId]);
  return <div className="shell-terminal" style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
    {state.error && <div className="shell-terminal-error" role="alert">{state.error}</div>}
    {state.phase === 'exited' && <div role="status">进程已退出（{state.exitCode ?? '未知'}）</div>}
    <div ref={container} style={{ flex: 1, minHeight: 0 }} />
  </div>;
}

function LegacyShellTerminal({ cwd, cliId, terminalId }: ShellTerminalProps) {
  const attach = useCallback(async () => {
    const r = await window.vibeMeet.shellPty.create({ cwd, cliId, terminalId, cols: 100, rows: 30 });
    if (r.ok) return r;
    return { ok: false as const, error: r.error ?? '无法启动终端' };
  }, [cwd, cliId, terminalId]);
  const input = useCallback((ptyId: string, data: string) => {
    void window.vibeMeet.shellPty.input(ptyId, data);
  }, []);
  const resize = useCallback((ptyId: string, rows: number, cols: number) => {
    void window.vibeMeet.shellPty.resize(ptyId, rows, cols);
  }, []);
  const onData = useCallback(
    (cb: (e: { ptyId: string; data: string }) => void) =>
      window.vibeMeet.shellPty.onData(cb),
    [],
  );
  const onExit = useCallback(
    (cb: (e: { ptyId: string; exitCode: number | null }) => void) =>
      window.vibeMeet.shellPty.onExit(cb),
    [],
  );
  const dispose = useCallback((ptyId: string) => {
    if (!terminalId || !stageWindowStore.getSnapshot().windows.some((win) => win.id === terminalId)) {
      void window.vibeMeet.shellPty.kill(ptyId);
    }
  }, [terminalId]);

  const { containerRef, exited, error } = usePtyTerminal({
    attach,
    input,
    resize,
    onData,
    onExit,
    dispose,
  });

  return (
    <div
      className="shell-terminal"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      {error && <div className="shell-terminal-error">{error}</div>}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 120, opacity: exited ? 0.7 : 1 }}
      />
    </div>
  );
}
