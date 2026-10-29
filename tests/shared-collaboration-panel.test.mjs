/** IF-6 exercises source modules and actual React; no compiled Electron output or live backend. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import viteReact from '@vitejs/plugin-react';
import { createReactBrowserFixture } from './fixtures/react-browser.mjs';

let fixture;
before(async () => { fixture = await createReactBrowserFixture(); });
after(async () => { await fixture?.close(); });

async function page() {
  const browserPage = await fixture.browser.newPage();
  const harness = fixture.origin + '/if6-harness';
  await browserPage.route(harness, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body><div id="root"></div><script type="module">'
      + viteReact.preambleCode.replace('__BASE__', '/') + '</script></body></html>',
  }));
  await browserPage.goto(harness);
  await browserPage.evaluate(async () => {
    const { default: React } = await import('/@id/react');
    const { default: ReactDOMClient } = await import('/@id/react-dom/client');
    const { default: ReactDOM } = await import('/@id/react-dom');
    const { createRoot } = ReactDOMClient;
    const { flushSync } = ReactDOM;
    window.__calls = [];
    window.__navigation = [];
    window.vibeMeet = { collaboration: {
      request: async (...args) => { window.__calls.push(args); throw new Error('Unexpected IPC from the panel'); },
      onChanged: () => { throw new Error('Unexpected subscription from the panel'); },
    } };
    const store = await import('/src/lib/unified-meeting-store.ts');
    const { SharedCollaborationPanel } = await import('/src/components/SharedCollaborationPanel.tsx');
    const view = {
      enabled: true, connected: true, deviceId: 'device-0001', config: { name: '同名电脑' },
      allowedAgents: [], bindings: [], directories: [], probes: [], credentialReady: false,
      snapshot: { protocol: 2, cursor: 7, entities: {
        device: [
          { id: 'device-0001', revision: 1, name: '同名电脑', online: true },
          { id: 'device-0002', revision: 1, name: '同名电脑', online: false },
        ],
        meeting: [{ id: 'meeting-current', revision: 2, title: '当前会议', coordinatorDeviceId: 'device-0001', hostAgentId: 'codex', members: ['device-0002'], participants: [{ deviceId: 'device-0002', agentId: 'codex' }], plan: [], planApproved: false }],
        task: [
          { id: 'task-current', revision: 3, meetingId: 'meeting-current', title: '当前准确任务', objective: '保留原成果', targetDeviceId: 'device-0002', agentId: 'codex', attemptId: 'attempt-current', resource: 'text', status: 'reconcile', stopRequested: true, exitConfirmed: false, pendingFollowups: [], dependencies: [] },
          { id: 'task-other', revision: 1, meetingId: 'meeting-other', title: '其他会议秘密任务', targetDeviceId: 'device-0002', agentId: 'codex', attemptId: 'attempt-other', status: 'running' },
        ],
      } },
    };
    window.__view = view;
    window.__model = store.projectShared(view, 'meeting-current');
    window.__store = store;
    window.__React = React;
    window.__flush = flushSync;
    window.__root = createRoot(document.getElementById('root'));
    window.__mountPanel = props => flushSync(() => window.__root.render(React.createElement(SharedCollaborationPanel, {
      enabled: true, model: window.__model,
      onOpenTask: id => window.__navigation.push(['task', id]),
      onInvite: () => window.__navigation.push(['invite']),
      onReviewPlan: () => window.__navigation.push(['plan']),
      onClose: () => window.__navigation.push(['close']),
      ...props,
    })));
  });
  return browserPage;
}

test('IF-6 source projection scopes tasks and preserves exact offline member and attempt identity', async () => {
  const p = await page();
  try {
    const result = await p.evaluate(() => ({
      tasks: window.__model.tasks.map(task => [task.id, task.attemptId]),
      members: window.__model.members.map(member => ({ id: member.id, label: member.label, online: member.online, tasks: member.tasks.map(task => task.id) })),
      missing: window.__store.projectShared(window.__view, 'missing'),
    }));
    assert.deepEqual(result.tasks, [['task-current', 'attempt-current']]);
    assert.deepEqual(result.members, [{ id: 'member-device-0002-codex', label: '同名电脑（0002） · codex', online: false, tasks: ['task-current'] }]);
    assert.equal(result.missing, undefined);
  } finally { await p.close(); }
});

test('IF-6 requires explicit true and respects the main-process closed status without any callbacks or IPC', async () => {
  const p = await page();
  try {
    for (const enabled of [undefined, false, '1']) {
      await p.evaluate(value => window.__mountPanel({ enabled: value }), enabled);
      await p.getByText('跨设备协作暂未开放。', { exact: true }).waitFor();
      assert.equal(await p.getByRole('button').count(), 0);
      assert.equal(await p.getByText('当前准确任务', { exact: true }).count(), 0);
    }
    await p.evaluate(() => { window.__model.view.enabled = false; window.__mountPanel({ enabled: true }); });
    assert.equal(await p.getByRole('button').count(), 0);
    assert.deepEqual(await p.evaluate(() => [window.__calls, window.__navigation]), [[], []]);
  } finally { await p.close(); }
});

test('IF-6 mounting, navigating and closing only invoke supplied callbacks and never mutate the model', async () => {
  const p = await page();
  try {
    const before = await p.evaluate(() => JSON.stringify(window.__model));
    await p.evaluate(() => window.__mountPanel());
    await p.getByRole('button', { name: '当前准确任务', exact: true }).click();
    await p.getByRole('button', { name: '＋ 邀请设备／对话', exact: true }).click();
    await p.getByRole('button', { name: '审阅当前计划', exact: true }).click();
    await p.getByRole('button', { name: '关闭协作面板', exact: true }).click();
    assert.deepEqual(await p.evaluate(() => window.__navigation), [['task', 'task-current'], ['invite'], ['plan'], ['close']]);
    assert.equal(await p.evaluate(() => JSON.stringify(window.__model)), before);
    assert.equal(await p.getByRole('region', { name: '设备协作面板' }).count(), 1, 'parent owns the open state');
    assert.equal(await p.getByText('其他会议秘密任务', { exact: true }).count(), 0);
    assert.match(await p.locator('body').innerText(), /停止尚未确认/);
    await p.evaluate(() => window.__flush(() => window.__root.unmount()));
    assert.deepEqual(await p.evaluate(() => window.__calls), []);
  } finally { await p.close(); }
});

test('IF-6 disconnected display retains task details but disables invitation and plan navigation', async () => {
  const p = await page();
  try {
    await p.evaluate(() => { window.__model.view.connected = false; window.__mountPanel({ error: '本次连接待核对' }); });
    await p.getByText('连接中断，保留最后确认状态', { exact: true }).waitFor();
    assert.equal(await p.getByRole('button', { name: '＋ 邀请设备／对话', exact: true }).isDisabled(), true);
    assert.equal(await p.getByRole('button', { name: '审阅当前计划', exact: true }).isDisabled(), true);
    await p.getByRole('button', { name: '当前准确任务', exact: true }).click();
    assert.equal(await p.getByRole('alert').innerText(), '本次连接待核对');
    assert.deepEqual(await p.evaluate(() => window.__navigation), [['task', 'task-current']]);
    assert.deepEqual(await p.evaluate(() => window.__calls), []);
    await p.evaluate(() => window.__mountPanel({ onOpenTask: undefined, onInvite: undefined, onReviewPlan: undefined, onClose: undefined }));
    assert.equal(await p.getByRole('button', { name: '当前准确任务', exact: true }).isDisabled(), true);
    assert.equal(await p.getByRole('button', { name: '＋ 邀请设备／对话', exact: true }).count(), 0);
  } finally { await p.close(); }
});

test('IF-6 phase display never upgrades an unverified legacy delivery or interrupted turn to accepted work', async () => {
  const p = await page();
  try {
    await p.evaluate(() => {
      Object.assign(window.__model.tasks[0], { status: 'delivered', stopRequested: false, exitConfirmed: true, turnOutcome: undefined, delivery: { summary: '历史预览' } });
      window.__mountPanel();
    });
    assert.match(await p.locator('body').innerText(), /成果可获取，待检查/);
    assert.doesNotMatch(await p.locator('body').innerText(), /检查通过|最终已验收/);
    await p.evaluate(() => { window.__model.tasks[0].turnOutcome = 'interrupted'; window.__mountPanel(); });
    assert.match(await p.locator('body').innerText(), /本轮中断，部分成果仅保留本机/);
    assert.deepEqual(await p.evaluate(() => window.__calls), []);
  } finally { await p.close(); }
});

test('IF-6 store shares one IPC listener, releases it on last unmount and fences late callbacks and replies', async () => {
  const p = await page();
  try {
    await p.evaluate(() => {
      const React = window.__React;
      window.__pending = [];
      window.__listeners = new Set();
      window.__oldListeners = [];
      window.__unsubscribed = 0;
      window.vibeMeet.collaboration = {
        request: (...args) => { window.__calls.push(args); return new Promise((resolve, reject) => window.__pending.push({ resolve, reject })); },
        onChanged: listener => { window.__listeners.add(listener); window.__oldListeners.push(listener); return () => { window.__listeners.delete(listener); window.__unsubscribed++; }; },
      };
      function Consumer({ id }) {
        const state = window.__store.useUnifiedMeeting();
        return React.createElement('p', { 'data-consumer': id }, (state.view?.deviceId ?? 'no-view') + ':' + (state.error ?? 'no-error'));
      }
      window.__mountConsumers = ids => window.__flush(() => window.__root.render(
        React.createElement(React.Fragment, null, ...ids.map(id => React.createElement(Consumer, { key: id, id }))),
      ));
      window.__mountConsumers(['one', 'two']);
    });
    await p.waitForFunction(() => window.__calls.length === 1);
    assert.equal(await p.evaluate(() => window.__listeners.size), 1);
    await p.evaluate(() => window.__mountConsumers(['two']));
    assert.equal(await p.evaluate(() => window.__unsubscribed), 0);
    await p.evaluate(() => window.__mountConsumers([]));
    assert.deepEqual(await p.evaluate(() => [window.__listeners.size, window.__unsubscribed]), [0, 1]);
    await p.evaluate(async () => { window.__pending[0].resolve({ ok: true, value: { ...window.__view, deviceId: 'obsolete' } }); await Promise.resolve(); });
    await p.evaluate(() => { window.__mountConsumers(['new']); window.__oldListeners[0](); });
    await p.waitForFunction(() => window.__calls.length === 2);
    assert.equal(await p.locator('[data-consumer="new"]').innerText(), 'no-view:no-error');
    await p.evaluate(() => window.__pending[1].resolve({ ok: true, value: { ...window.__view, deviceId: 'current' } }));
    await p.getByText('current:no-error', { exact: true }).waitFor();
    await p.evaluate(() => { for (const listener of window.__listeners) listener(); });
    await p.waitForFunction(() => window.__calls.length === 3);
    await p.evaluate(async () => { window.__mountConsumers([]); window.__pending[2].reject(new Error('late obsolete failure')); await Promise.resolve(); });
    await p.evaluate(() => window.__mountConsumers(['final']));
    await p.waitForFunction(() => window.__calls.length === 4);
    assert.equal(await p.locator('[data-consumer="final"]').innerText(), 'current:no-error');
    await p.evaluate(() => window.__pending[3].resolve({ ok: true, value: { ...window.__view, deviceId: 'final' } }));
    await p.getByText('final:no-error', { exact: true }).waitFor();
    await p.evaluate(() => window.__mountConsumers([]));
    assert.deepEqual(await p.evaluate(() => [window.__listeners.size, window.__unsubscribed]), [0, 3]);
  } finally { await p.close(); }
});
