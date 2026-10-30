import React from 'react';
import { createRoot } from 'react-dom/client';
import { ScanControls } from '../../src/components/ScanControls.tsx';
import '../../src/styles.css';
let update;
window.vibeMeet = { observe: {
  allowDirectory: async () => { update({ sessions: [
    { id: 'user', clientKind: 'claude-code', projectName: 'demo', title: 'Read-only user session', state: 'idle', origin: 'user' },
    { id: 'adopted', clientKind: 'codex', projectName: 'demo', title: 'Adopted session', state: 'unknown', origin: 'user-adopted', ownership: 'owned' }
  ], access: { enabled: true, roots: ['C:/Projects/demo'] }, studioTasks: [
    { meetingId: 'm', taskId: 't', title: 'Recorded task', status: 'done' }
  ] }); return { ok: true }; },
  disable: async () => { update({ sessions: [], access: { enabled: false, roots: [] } }); return { ok: true }; }
} };
function Preview() {
  const [snapshot, setSnapshot] = React.useState({ sessions: [], access: { enabled: false, roots: [] } });
  update = setSnapshot;
  return React.createElement('main', { className: 'tasks-view', style: { height: '100vh' } },
    React.createElement('header', { className: 'tasks-toolbar' }, '任务 · 会话扫描验证'),
    React.createElement(ScanControls, { snapshot }),
    React.createElement('div', { className: 'tasks-board' },
      ...['待批准', '进行中', '待检查', '已完成'].map((name) => React.createElement('section', { className: 'tasks-column', key: name },
        React.createElement('header', { className: 'tasks-column-head' }, name)))))
}
createRoot(document.getElementById('root')).render(React.createElement(Preview));
