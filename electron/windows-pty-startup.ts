import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { PtyProcess, PtyExitEvent } from './pty-host.js';

const require_ = createRequire(import.meta.url);

// @lydell/node-pty 1.2.0-beta.12 throws from deferred connect rather than
// reporting a per-terminal error. Keep its private compatibility surface here.
interface WindowsPty extends PtyProcess {
  _agent: {
    readonly innerPid: number;
    _completePtyConnection: () => void;
    kill: () => void;
    inSocket: Socket;
    outSocket: Socket;
    _conoutSocketWorker: { dispose: () => void };
    _getConsoleProcessList: () => Promise<number[]>;
  };
}

function listConsoleProcesses(pid: number): Promise<number[]> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve([]);
  return new Promise((resolve) => {
    const fallback = [pid];
    try {
      const fromNodePty = createRequire(require_.resolve('@lydell/node-pty'));
      const platformEntry = fromNodePty.resolve(`@lydell/node-pty-win32-${process.arch}`);
      // electron-builder unpacks the platform package, including this JS
      // helper and its native addon. Reuse its console enumeration in Node mode.
      const helper = join(dirname(platformEntry), 'conpty_console_list_agent.js')
        .replace(/([\\/])app\.asar([\\/])/i, '$1app.asar.unpacked$2');
      const child = spawn(process.execPath, [helper, String(pid)], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        windowsHide: true,
      });
      const finish = (pids: number[]) => {
        clearTimeout(timeout);
        resolve(pids);
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(fallback);
      }, 5_000);
      child.once('message', (message: { consoleProcessList?: unknown }) => {
        const pids = message?.consoleProcessList;
        finish(Array.isArray(pids) && pids.every((value) => Number.isInteger(value) && value > 0)
          ? pids.filter((value) => value !== child.pid)
          : fallback);
      });
      child.once('error', () => finish(fallback));
      child.once('close', () => finish(fallback));
    } catch {
      resolve(fallback);
    }
  });
}

export function guardWindowsPtyStartup(pty: PtyProcess): PtyProcess {
  const agent = (pty as WindowsPty)._agent;
  if (process.platform === 'win32' && typeof agent.innerPid === 'number') {
    // Upstream uses fork() without hiding the console during a normal close.
    agent._getConsoleProcessList = () => listConsoleProcesses(agent.innerPid);
  }
  const connect = agent._completePtyConnection.bind(agent);
  const exits = new Set<(event: PtyExitEvent) => void>();
  let startupError: Error | undefined;
  let ended = false;
  const publishExit = (event: PtyExitEvent) => {
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
