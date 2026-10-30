import type { Socket } from 'node:net';
import type { PtyProcess } from './pty-host.js';

// @lydell/node-pty 1.2.0-beta.12 throws from deferred connect rather than
// reporting a per-terminal error. Keep its private compatibility surface here.
interface WindowsPty extends PtyProcess {
  _agent: {
    _completePtyConnection: () => void;
    kill: () => void;
    inSocket: Socket;
    outSocket: Socket;
    _conoutSocketWorker: { dispose: () => void };
    _getConsoleProcessList: () => Promise<number[]>;
  };
}

export function guardWindowsPtyStartup(pty: PtyProcess): PtyProcess {
  const agent = (pty as WindowsPty)._agent;
  const connect = agent._completePtyConnection.bind(agent);
  const exits = new Set<(event: { exitCode: number }) => void>();
  let startupError: Error | undefined;
  let ended = false;
  const publishExit = (event: { exitCode: number }) => {
    if (ended) return;
    ended = true;
    for (const callback of exits) callback(event);
  };
  const nativeExit = pty.onExit(publishExit);
  agent._completePtyConnection = () => {
    try { connect(); }
    catch (error) {
      startupError = error instanceof Error ? error : new Error(String(error));
      // Public kill() queues until first output, which never arrives on failure.
      for (const release of [() => agent.kill(), () => agent._conoutSocketWorker.dispose(),
        () => agent.inSocket.destroy(), () => agent.outSocket.destroy()]) {
        try { release(); }
        catch (cleanupError) { startupError = new Error(`${startupError.message}; cleanup failed: ${String(cleanupError)}`); }
      }
      publishExit({ exitCode: 1 });
      nativeExit.dispose();
    }
  };
  return {
    get pid() { return pty.pid; },
    get startupError() { return startupError; },
    onData: callback => pty.onData(callback),
    onExit: callback => { exits.add(callback); return { dispose: () => {
      exits.delete(callback);
      if (!exits.size && ended) nativeExit.dispose();
    } }; },
    write: data => pty.write(data), resize: (cols, rows) => pty.resize(cols, rows),
    kill: signal => pty.kill(signal),
    releaseAfterTreeExit: () => {
      // Public kill queues until first output, which a silent Worker may
      // never produce. Confirmed tree teardown can release the agent directly.
      // taskkill /T has already confirmed the owned tree. Avoid the library's
      // redundant child_process.fork(process.execPath) console-list helper:
      // a packaged Electron executable would launch the application again.
      const list = agent._getConsoleProcessList;
      agent._getConsoleProcessList = async () => [];
      try { agent.kill(); }
      finally { agent._getConsoleProcessList = list; }
    },
  };
}
