import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../../../package.json', import.meta.url));
const nodePty = require('@lydell/node-pty');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(process.env.USERPROFILE || '', '.local', 'bin', 'claude.exe');

function sendSse(res, eventType, payload) {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

async function waitForHookCount(eventsFile, eventName, minCount, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = readJsonl(eventsFile).filter((e) => e.hookEventName === eventName);
    if (matches.length >= minCount) return matches[matches.length - 1];
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function main() {
  const workDir = path.join(__dirname, `probe-claude-tui-${Date.now()}`);
  const projectDir = path.join(workDir, 'project');
  const claudeConfigDir = path.join(workDir, 'claude-config');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(claudeConfigDir, { recursive: true });

  let turnCount = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url?.startsWith('/v1/messages')) {
      turnCount++;
      const reply = `CLAUDE_TUI_TURN_${turnCount} [terminal-task-complete]`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sendSse(res, 'message_start', {
        type: 'message_start',
        message: { id: `m_${turnCount}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
      });
      sendSse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      sendSse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } });
      sendSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sendSse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      sendSse(res, 'message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const apiKey = 'sk-ant-mock-p0a-interactive-key-123456';
  fs.writeFileSync(
    path.join(claudeConfigDir, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      bypassPermissionsModeAccepted: true,
      customApiKeyResponses: {
        approved: [apiKey.slice(-20)],
        rejected: [],
      },
      projects: {
        [projectDir]: { allowedTools: [], hasTrustDialogAccepted: true },
        [projectDir.replace(/\\/g, '/')]: { allowedTools: [], hasTrustDialogAccepted: true },
      },
    }, null, 2),
    'utf8',
  );

  const eventsFile = path.join(workDir, 'claude-tui-hooks.jsonl');
  const hookScriptPath = path.join(workDir, 'record.cjs');
  fs.writeFileSync(
    hookScriptPath,
    `
const fs = require('fs');
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
const parsed = JSON.parse(raw || '{}');
fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({
  at: Date.now(),
  hookEventName: parsed.hook_event_name,
  sessionId: parsed.session_id,
  promptId: parsed.prompt_id || null,
  prompt: parsed.prompt || null,
  lastAssistantMessage: parsed.last_assistant_message || null,
}) + '\\n');
`,
    'utf8',
  );

  const hookCmd = `"${process.execPath}" "${hookScriptPath}"`;
  const settingsPath = path.join(workDir, 'settings.json');
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      skipDangerousModePermissionPrompt: true,
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: hookCmd, timeout: 15 }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd, timeout: 15 }] }],
        Stop: [{ hooks: [{ type: 'command', command: hookCmd, timeout: 15 }] }],
      },
    }, null, 2),
    'utf8',
  );

  const pty = nodePty.spawn(
    CLAUDE_BIN,
    ['--settings', settingsPath, '--dangerously-skip-permissions', 'Interactive Turn 1'],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 35,
      cwd: projectDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        ANTHROPIC_API_KEY: apiKey,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_AUTOUPDATER: '1',
        NO_PROXY: '127.0.0.1,localhost',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
      },
    },
  );

  const stop1 = await waitForHookCount(eventsFile, 'Stop', 1, 15000);
  let submit2 = null;
  let stop2 = null;
  if (stop1) {
    await new Promise((r) => setTimeout(r, 800));
    pty.write('\x1b[200~Interactive Turn 2 via idle-wake\x1b[201~');
    await new Promise((r) => setTimeout(r, 400));
    pty.write('\r');
    submit2 = await waitForHookCount(eventsFile, 'UserPromptSubmit', 2, 5000);
    stop2 = await waitForHookCount(eventsFile, 'Stop', 2, 12000);
  }
  try { pty.kill(); } catch {}
  server.close();

  console.log(JSON.stringify({
    stop1,
    submit2,
    stop2,
    allEvents: readJsonl(eventsFile),
  }, null, 2));
  process.exit(0);
}

main();
