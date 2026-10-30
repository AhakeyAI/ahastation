import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { ClaudeCodeBackend } from '../dist-electron/backends/claude-code-adapter.js';
import { buildTalkerMcp } from '../dist-electron/meeting-mcp.js';
import { createSdkMcpServer } from '../dist-electron/claude-cli/inproc-mcp.js';
import { CoordinatorReviewDriver } from '../dist-electron/coordinator-review-driver.js';
import { Orchestrator } from '../dist-electron/orchestrator.js';
import candidate from './fixtures/coordinator-review-candidate.json' with { type: 'json' };

async function reviewFixture({ withheld = false } = {}) {
  const journal = [], completed = [];
  const driver = new CoordinatorReviewDriver({
    id: () => 'owned-review',
    append: async (type, payload) => { journal.push({ type, payload }); },
    flush: async () => {}, notifyCoordinator: () => {},
    onCompleted: session => { completed.push(session); },
  });
  const frozen = structuredClone(candidate);
  frozen.attempt = 2;
  frozen.manifest.chunks[0].hash = '3'.repeat(64);
  frozen.manifest.chunks[0].requiresUserConfirmation = withheld;
  frozen.manifest.chunks.push({ ...frozen.manifest.chunks[0],
    id: 'fixture-chunk-2', index: 1, hash: '2'.repeat(64) });
  await driver.request({ candidate: frozen, verification: { passed: true, checks: [] } });
  // Use the actual Orchestrator review methods, including withheld-evidence filtering.
  const owner = { coordinatorReviewDriver: driver };
  const bridge = { activeReviewGate: () => null };
  for (const name of ['inspectDeliveryReview', 'getDeliveryReviewChunk',
    'submitDeliveryChunkReview', 'completeDeliveryReview', 'requestDeliveryRework']) {
    bridge[name] = Orchestrator.prototype[name].bind(owner);
  }
  return { driver, bridge, journal, completed };
}

async function host(mcpServers) {
  let options, finish;
  const events = [];
  const query = {
    initializationResult: async () => ({ session_id: 'controlled-host-session' }),
    [Symbol.asyncIterator]() { return this; },
    next() { return new Promise(resolve => { finish = resolve; }); },
    async interrupt() { finish?.({ done: true }); },
    async setPermissionMode() {},
  };
  const backend = new ClaudeCodeBackend({ queryFactory: input => {
    options = input.options;
    return query;
  } });
  const session = backend.createSession({
    cwd: process.cwd(), executionRole: 'host', autoApproveScope: 'off',
    mcpServers, extra: { settingSources: [], tools: [] }, env: {},
  }, event => events.push(event));
  await session.start();
  return { session, events, options };
}

async function internalCall(h, server, name, input) {
  const before = h.events.filter(event => event.kind === 'permission-request').length;
  const permission = h.options.canUseTool('mcp__meeting__' + name, input, { toolUseID: name });
  await tick();
  assert.equal(h.events.filter(event => event.kind === 'permission-request').length, before,
    'registered internal review must reach its own guards without a user approval');
  assert.equal((await permission).behavior, 'allow');
  const response = await server.instance.dispatch({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input },
  });
  return response.result;
}

async function mustAsk(h, name) {
  const pending = h.options.canUseTool(name, { command: 'fixture-only' }, { toolUseID: name });
  await tick();
  const event = h.events.filter(item => item.kind === 'permission-request').at(-1);
  assert.equal(event?.toolName, name);
  h.session.resolvePermission(event.id, 'deny', 'controlled test denial');
  assert.equal((await pending).behavior, 'deny');
}

test('Claude Host internal review reads and submits every chunk with auto-approve off and no human prompts', async () => {
  const review = await reviewFixture();
  const server = buildTalkerMcp(review.bridge);
  const h = await host({ meeting: server });
  try {
    for (const chunkId of ['fixture-chunk-1', 'fixture-chunk-2']) {
      const result = await internalCall(h, server, 'get_delivery_review_chunk', { reviewId: 'owned-review', chunkId });
      assert.notEqual(result.isError, true);
      const chunk = JSON.parse(result.content[0].text);
      const submitted = await internalCall(h, server, 'submit_delivery_chunk_review', {
        reviewId: 'owned-review', chunkId, chunkHash: chunk.hash, verdict: 'passed', findings: [],
      });
      assert.notEqual(submitted.isError, true);
    }
    const result = await internalCall(h, server, 'complete_delivery_review', { reviewId: 'owned-review' });
    assert.notEqual(result.isError, true);
    assert.equal(review.driver.inspect('owned-review').status, 'completed');
    assert.equal(review.completed.length, 1);
    assert.equal(review.journal.filter(item => item.type === 'coordinator-review-chunk-submitted').length, 2);
    assert.equal(h.events.some(event => event.kind === 'permission-request'), false);
  } finally { h.session.end(); }
});

test('internal approval routing preserves real role, meeting review and exact frozen chunk guards', async () => {
  const review = await reviewFixture();
  let coordinator = true;
  const server = buildTalkerMcp(review.bridge, () => coordinator);
  const h = await host({ meeting: server });
  try {
    const before = review.driver.inspect('owned-review');
    const wrongMeeting = await internalCall(h, server, 'get_delivery_review_chunk', { reviewId: 'other-meeting-review' });
    assert.equal(wrongMeeting.isError, true);
    assert.match(wrongMeeting.content[0].text, /not found/);
    // A real previous-attempt candidate hash cannot review the current frozen chunk.
    assert.equal(before.attempt, 2);
    const wrongHash = await internalCall(h, server, 'submit_delivery_chunk_review', {
      reviewId: 'owned-review', chunkId: 'fixture-chunk-1', chunkHash: candidate.manifest.chunks[0].hash,
      verdict: 'passed', findings: [],
    });
    assert.equal(wrongHash.isError, true);
    assert.match(wrongHash.content[0].text, /hash/);
    coordinator = false;
    const expert = await internalCall(h, server, 'submit_delivery_chunk_review', {
      reviewId: 'owned-review', chunkId: 'fixture-chunk-1', chunkHash: before.candidate.manifest.chunks[0].hash,
      verdict: 'passed', findings: [],
    });
    assert.match(expert.content[0].text, /only the active coordinator/);
    assert.deepEqual(review.driver.inspect('owned-review'), before);
  } finally { h.session.end(); }
});

test('internal review cannot read or approve evidence reserved for explicit user confirmation', async () => {
  const review = await reviewFixture({ withheld: true });
  const server = buildTalkerMcp(review.bridge);
  const h = await host({ meeting: server });
  try {
    const before = review.driver.inspect('owned-review');
    const read = await internalCall(h, server, 'get_delivery_review_chunk', {
      reviewId: 'owned-review', chunkId: 'fixture-chunk-1',
    });
    const chunk = JSON.parse(read.content[0].text);
    assert.equal(chunk.requiresUserConfirmation, true);
    assert.equal(chunk.content, undefined);
    const submitted = await internalCall(h, server, 'submit_delivery_chunk_review', {
      reviewId: 'owned-review', chunkId: chunk.id, chunkHash: chunk.hash, verdict: 'passed', findings: [],
    });
    assert.equal(submitted.isError, true);
    assert.match(submitted.content[0].text, /explicit user confirmation/);
    assert.deepEqual(review.driver.inspect('owned-review'), before);
  } finally { h.session.end(); }
});

test('ordinary tools, other MCP namespaces and observed-session writes still ask the user', async () => {
  const review = await reviewFixture();
  const h = await host({ meeting: buildTalkerMcp(review.bridge) });
  try {
    for (const name of ['Bash', 'Read', 'mcp__external__get_delivery_review_chunk',
      'mcp__meeting__observed_session_focus', 'mcp__meeting__observed_session_send_text',
      'mcp__meeting__get_delivery_review_chunk_extra', 'mcp__meeting__unregistered_tool']) {
      await mustAsk(h, name);
    }
  } finally { h.session.end(); }
});

test('a review tool name without its actual current in-process registration never bypasses approval', async () => {
  const review = await reviewFixture();
  const registered = await host({ meeting: buildTalkerMcp(review.bridge) });
  registered.session.end();
  for (const servers of [
    {},
    { meeting: { type: 'stdio', command: 'external-tool-server' } },
    { meeting: { type: 'sdk', name: 'meeting', instance: {
      name: 'meeting', dispatch() {}, hasTool: () => true,
    } } },
    { meeting: createSdkMcpServer({ name: 'meeting', tools: [] }) },
    { external: buildTalkerMcp(review.bridge) },
    { meeting: { ...buildTalkerMcp(review.bridge), name: 'external' } },
  ]) {
    const h = await host(servers);
    try { await mustAsk(h, 'mcp__meeting__get_delivery_review_chunk'); }
    finally { h.session.end(); }
  }
});

test('a closed Claude Host cannot allow an otherwise registered internal review', async () => {
  const review = await reviewFixture();
  const h = await host({ meeting: buildTalkerMcp(review.bridge) });
  h.session.end();
  const result = await h.options.canUseTool('mcp__meeting__get_delivery_review_chunk',
    { reviewId: 'owned-review' }, { toolUseID: 'late' });
  assert.equal(result.behavior, 'deny');
  assert.equal(result.interrupt, true);
  assert.equal(h.events.some(event => event.kind === 'permission-request'), false);
});

test('review approval exceptions follow the actual startup registration, not later mutable configuration', async () => {
  const review = await reviewFixture();
  const server = buildTalkerMcp(review.bridge);
  const missing = {};
  const unregistered = await host(missing);
  try {
    missing.meeting = server;
    await mustAsk(unregistered, 'mcp__meeting__get_delivery_review_chunk');
  } finally { unregistered.session.end(); }

  const configured = { meeting: server };
  const registered = await host(configured);
  try {
    configured.meeting = { type: 'stdio', command: 'replacement-external-server' };
    const result = await internalCall(registered, server, 'get_delivery_review_chunk', { reviewId: 'owned-review' });
    assert.notEqual(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).id, 'fixture-chunk-1');
  } finally { registered.session.end(); }
});
