// Deterministic checks for the B04 grant broker. node docs/c0/b04-runtime/harness/broker.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { brokerDecide } from './common.mjs';

const ws = String.raw`C:\tmp\aha\repo`;
const at = (p) => `${ws}\\${p.replaceAll('/', '\\')}`;
const cases = [
  ['claude edit src', { toolName: 'Edit', input: { file_path: at('src/sum.js') } }, true],
  ['claude edit test', { toolName: 'Edit', input: { file_path: at('test/sum.test.js') } }, false],
  ['claude write outside', { toolName: 'Write', input: { file_path: String.raw`C:\tmp\aha\outside.txt` } }, false],
  ['codex write src via tool detail', { toolName: 'Write', input: { reason: null, grantRoot: null }, toolDetail: at('src/sum.js') }, true],
  ['codex write test via tool detail', { toolName: 'Write', input: { reason: null, grantRoot: null }, toolDetail: at('test/sum.test.js') }, false],
  ['codex write without any path', { toolName: 'Write', input: { reason: null, grantRoot: null }, toolDetail: '' }, false],
  ['edit test after an npm test tool event', { toolName: 'Edit', input: { file_path: at('test/sum.test.js') }, toolDetail: 'npm test' }, false],
  ['bash npm test with 2>&1', { toolName: 'Bash', input: { command: 'cd "x" && npm test 2>&1 | tail -30' } }, true],
  ['bash get-content', { toolName: 'Bash', input: { command: "powershell -Command 'Get-Content src/sum.js'" } }, true],
  ['bash redirect outside', { toolName: 'Bash', input: { command: 'echo hi > ../outside.txt' } }, false],
  ['bash redirect inside', { toolName: 'Bash', input: { command: 'echo hi > notes.txt' } }, false],
  ['bash set-content test', { toolName: 'Bash', input: { command: "Set-Content test/sum.test.js 'x'" } }, false],
  ['paseo codex file change via timeline path', { toolName: 'CodexFileChange', input: {}, toolDetail: 'src/sum.js' }, true],
  ['paseo codex file change to test', { toolName: 'CodexFileChange', input: {}, toolDetail: 'test/sum.test.js' }, false],
  ['paseo codex file change without path', { toolName: 'CodexFileChange', input: {}, toolDetail: '' }, false],
  ['read src', { toolName: 'Read', input: { file_path: at('src/sum.js') } }, true],
  ['read outside', { toolName: 'Read', input: { file_path: String.raw`C:\Windows\win.ini` } }, false],
];

for (const [name, req, want] of cases) {
  test(`broker: ${name}`, () => {
    const verdict = brokerDecide(ws, req);
    assert.equal(verdict.allow, want, verdict.why);
  });
}
