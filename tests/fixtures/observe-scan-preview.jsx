import React from 'react';
import { createRoot } from 'react-dom/client';
import { ScanControls } from '../../src/components/ScanControls.tsx';
import { ProjectRooms } from '../../src/components/ProjectRooms.tsx';
import '../../src/styles.css';
let update;
const enabledSnapshot = { sessions: [
    { id: 'user', clientKind: 'claude-code', projectName: 'demo', title: 'Read-only user session', state: 'idle', origin: 'user' },
    { id: 'adopted', clientKind: 'codex', projectName: 'demo', title: 'Adopted session', state: 'unknown', origin: 'user-adopted', ownership: 'owned' },
    { id: 'unresolved', clientKind: 'codex', title: 'Ownership unknown', state: 'unknown', origin: 'unknown', ownership: 'unresolved' }
  ], access: { enabled: true, roots: ['C:/Projects/demo'] }, localProjects: [
    { key: 'candidate', label: 'example/team', status: 'candidate', mounts: [
      { key: 'main', label: 'demo', path: 'C:/Projects/demo', branch: 'main', sessionIds: ['user'] },
      { key: 'worktree', label: 'demo-feature', path: 'C:/Projects/demo-feature', branch: 'feature/project-discovery', sessionIds: ['adopted'] },
    ] },
    { key: 'unknown', label: 'needs-review', status: 'unresolved', reason: 'ownership-unresolved', mounts: [
      { key: 'unknown-dir', label: 'needs-review', path: 'C:/Projects/demo/needs-review', branch: null, sessionIds: ['unresolved'] },
    ] },
  ], studioTasks: [
    { meetingId: 'm', taskId: 't', title: 'Recorded task', status: 'done' }
  ], pendingDirectories: [{ key: 'a'.repeat(64), path: 'C:/Projects/pending-private', label: 'pending-private', sessionCount: 2 }],
  hidden: { sessions: 0, directories: 0 }, scannedAt: 1 };
const state = window.__scanTest = { allowCalls: 0, reviewCalls: 0, completed: 0, result: 'ok' };
const result = async () => {
  if (state.result === 'deferred') await new Promise((resolve) => { state.release = resolve; });
  if (state.result === 'cancel') return { ok: true, canceled: true };
  if (state.result === 'error') return { ok: false, error: '授权暂不可用' };
  return { ok: true };
};
window.vibeMeet = { observe: {
  allowDirectory: async () => {
    state.allowCalls++; const r = await result();
    if (r.ok && !r.canceled) update(enabledSnapshot);
    return r;
  },
  reviewDirectory: async () => {
    state.reviewCalls++; const r = await result();
    if (r.ok && !r.canceled) update((s) => ({ ...s, pendingDirectories: [], access: { ...s.access, roots: [...s.access.roots, 'C:/Projects/pending-private'] } }));
    return r;
  },
  ignoreDirectory: async () => { update((s) => ({ ...s, pendingDirectories: [], hidden: { ...s.hidden, directories: 1 } })); return { ok: true }; },
  ignoreSession: async (id) => { update((s) => ({ ...s, sessions: s.sessions.filter((row) => row.id !== id),
    hidden: { ...s.hidden, sessions: s.hidden.sessions + 1 } })); return { ok: true }; },
  restoreHidden: async () => { update((s) => ({ ...enabledSnapshot, access: s.access })); return { ok: true }; },
  disable: async () => { update((s) => ({ ...s, sessions: [], localProjects: [], pendingDirectories: [], studioTasks: [], access: { enabled: false, roots: [] } })); return { ok: true }; }
} };
function Preview() {
  const [firstLaunch, setFirstLaunch] = React.useState(true);
  const [snapshot, setSnapshot] = React.useState({ sessions: [], access: { enabled: false, roots: [] } });
  update = setSnapshot;
  return React.createElement('main', { className: 'tasks-view', style: { height: '100vh' } },
    React.createElement('header', { className: 'tasks-toolbar' }, '任务 · 会话扫描验证'),
    new URLSearchParams(location.search).has('rooms') && React.createElement(ProjectRooms, {
      rooms: [], hiddenRooms: [], observed: snapshot, firstLaunch, opening: false,
      onScanned: () => { state.completed++; setFirstLaunch(false); },
    }),
    React.createElement(ScanControls, { snapshot }),
    React.createElement('div', { className: 'tasks-board' },
      ...['待批准', '进行中', '待检查', '已完成'].map((name) => React.createElement('section', { className: 'tasks-column', key: name },
        React.createElement('header', { className: 'tasks-column-head' }, name)))))
}
createRoot(document.getElementById('root')).render(React.createElement(Preview));
