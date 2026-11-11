import { spawnSync } from 'node:child_process';
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
const CODEX_BIN = process.env.CODEX_BIN || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');

function sendSse(res, eventType, payload) {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function stripAnsi(data) {
  return data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
}

function startMockLlmServer() {
  const anthropicRequests = [];
  const openAiRequests = [];
  let anthropicTurnCounter = 0;
  let openAiTurnCounter = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = JSON.parse(rawBody);
    } catch {}

    // Anthropic /v1/messages
    if (req.url?.startsWith('/v1/messages')) {
      anthropicTurnCounter++;
      const messages = Array.isArray(body.messages) ? body.messages : [];
      anthropicRequests.push({
        turnIndex: anthropicTurnCounter,
        url: req.url,
        model: body.model,
        messageCount: messages.length,
        messagesSummary: messages.map((m) => ({
          role: m.role,
          preview: typeof m.content === 'string'
            ? m.content.slice(0, 120)
            : JSON.stringify(m.content).slice(0, 120),
        })),
      });

      const replyText = `CLAUDE_REPLY_TURN_${anthropicTurnCounter} [terminal-task-complete]`;
      if (body.stream === false) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `msg_mock_${anthropicTurnCounter}`,
            type: 'message',
            role: 'assistant',
            model: body.model || 'claude-sonnet-4-6',
            content: [{ type: 'text', text: replyText }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 15, output_tokens: 10 },
          }),
        );
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      sendSse(res, 'message_start', {
        type: 'message_start',
        message: {
          id: `msg_mock_${anthropicTurnCounter}`,
          type: 'message',
          role: 'assistant',
          model: body.model || 'claude-sonnet-4-6',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 15, output_tokens: 1 },
        },
      });
      sendSse(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      sendSse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: replyText },
      });
      sendSse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      sendSse(res, 'message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 10 },
      });
      sendSse(res, 'message_stop', { type: 'message_stop' });
      res.end();
      return;
    }

    // OpenAI /v1/responses
    if (req.url?.includes('/responses')) {
      openAiTurnCounter++;
      const inputItems = Array.isArray(body.input) ? body.input : [];
      openAiRequests.push({
        turnIndex: openAiTurnCounter,
        url: req.url,
        model: body.model,
        inputCount: inputItems.length,
        inputSummary: inputItems.map((item) => ({
          type: item.type,
          role: item.role,
          preview: JSON.stringify(item.content ?? item).slice(0, 120),
        })),
      });

      const replyText = `CODEX_REPLY_TURN_${openAiTurnCounter} [terminal-task-complete]`;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const respId = `resp_codex_${openAiTurnCounter}`;
      const msgId = `msg_codex_${openAiTurnCounter}`;
      const events = [
        {
          type: 'response.created',
          sequence_number: 1,
          response: { id: respId, object: 'response', created_at: 1700000000, status: 'in_progress', model: body.model || 'gpt-5.4', output: [] },
        },
        {
          type: 'response.output_item.added',
          sequence_number: 2,
          output_index: 0,
          item: { id: msgId, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        },
        {
          type: 'response.content_part.added',
          sequence_number: 3,
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
        {
          type: 'response.output_text.delta',
          sequence_number: 4,
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          delta: replyText,
        },
        {
          type: 'response.output_text.done',
          sequence_number: 5,
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          text: replyText,
        },
        {
          type: 'response.content_part.done',
          sequence_number: 6,
          item_id: msgId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: replyText, annotations: [] },
        },
        {
          type: 'response.output_item.done',
          sequence_number: 7,
          output_index: 0,
          item: { id: msgId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: replyText, annotations: [] }] },
        },
        {
          type: 'response.completed',
          sequence_number: 8,
          response: {
            id: respId,
            object: 'response',
            created_at: 1700000001,
            status: 'completed',
            model: body.model || 'gpt-5.4',
            output: [{ id: msgId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: replyText, annotations: [] }] }],
            usage: { input_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 30 },
          },
        },
      ];
      for (const ev of events) {
        sendSse(res, ev.type, ev);
      }
      res.end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        anthropicRequests,
        openAiRequests,
      });
    });
  });
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
}

async function waitForHookCount(eventsFile, eventName, minCount, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = readJsonl(eventsFile).filter((e) => e.hookEventName === eventName);
    if (matches.length >= minCount) return matches[matches.length - 1];
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function main() {
  const workDir = path.join(__dirname, `p0-abh-data-${Date.now()}`);
  const projectDir = path.join(workDir, 'project');
  const codexHome = path.join(workDir, 'codex-home');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });

  const mock = await startMockLlmServer();

  // Create universal hook recorder script
  const hookScriptPath = path.join(workDir, 'record-hook.cjs');
  fs.writeFileSync(
    hookScriptPath,
    `
const fs = require('fs');
const targetFile = process.argv[2];
const sourceTag = process.argv[3] || 'unknown';
let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch {}
let parsed = {};
try { parsed = JSON.parse(raw || '{}'); } catch {}
const entry = {
  recordedAt: Date.now(),
  sourceTag,
  hookEventName: parsed.hook_event_name || parsed.event || null,
  sessionId: parsed.session_id || parsed.sessionId || null,
  turnId: parsed.turn_id || parsed.turnId || null,
  transcriptPath: parsed.transcript_path || parsed.transcriptPath || null,
  cwd: parsed.cwd || null,
  prompt: parsed.prompt || null,
  lastAssistantMessage: parsed.last_assistant_message || parsed.lastMessage || null,
  keys: Object.keys(parsed),
};
fs.appendFileSync(targetFile, JSON.stringify(entry) + '\\n', 'utf8');
`,
    'utf8',
  );

  const baseEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
  };

  // =========================================================================
  // PART 1: P0-A & P0-H — Claude Code CLI (2.1.318) Hooks + Resume + ConPTY
  // =========================================================================
  const claudeEventsFile = path.join(workDir, 'claude-hooks.jsonl');
  const claudeHookCmd = `"${process.execPath}" "${hookScriptPath}" "${claudeEventsFile}" "claude"`;
  const claudeSettingsPath = path.join(workDir, 'claude-settings.json');
  fs.writeFileSync(
    claudeSettingsPath,
    JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: claudeHookCmd, timeout: 15 }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: claudeHookCmd, timeout: 15 }] }],
          Stop: [{ hooks: [{ type: 'command', command: claudeHookCmd, timeout: 15 }] }],
          SubagentStart: [{ hooks: [{ type: 'command', command: claudeHookCmd, timeout: 15 }] }],
          SubagentStop: [{ hooks: [{ type: 'command', command: claudeHookCmd, timeout: 15 }] }],
        },
      },
      null,
      2,
    ),
    'utf8',
  );

  const claudeConfigDir = path.join(workDir, 'claude-config');
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeConfigDir, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      bypassPermissionsModeAccepted: true,
      projects: {
        [projectDir]: {
          allowedTools: [],
          hasTrustDialogAccepted: true,
        },
        [projectDir.replace(/\\/g, '/')]: {
          allowedTools: [],
          hasTrustDialogAccepted: true,
        },
      },
    }, null, 2),
    'utf8',
  );

  const claudeEnv = {
    ...baseEnv,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
    ANTHROPIC_API_KEY: 'sk-ant-mock-p0a-key',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };

  // 1A. Spawn Claude in ConPTY with -p (or interactive) for Turn 1
  let claudeTurn1Output = '';
  const claudePty1 = nodePty.spawn(
    CLAUDE_BIN,
    [
      '--settings',
      claudeSettingsPath,
      '--dangerously-skip-permissions',
      '-p',
      'Claude Turn 1 initial task',
    ],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 35,
      cwd: projectDir,
      env: claudeEnv,
    },
  );
  claudePty1.onData((d) => {
    claudeTurn1Output += d;
  });

  const claudeTurn1Stop = await waitForHookCount(claudeEventsFile, 'Stop', 1, 15000);
  try { claudePty1.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 300));

  // 1B. P0-H: Resume Claude session with new instruction (`claude --resume <sessionId> ...`) in ConPTY
  const claudeSessionId = claudeTurn1Stop?.sessionId;
  let claudeResumeOutput = '';
  let claudeResumeStop = null;
  if (claudeSessionId) {
    const claudePty2 = nodePty.spawn(
      CLAUDE_BIN,
      [
        '--resume',
        claudeSessionId,
        '--settings',
        claudeSettingsPath,
        '--dangerously-skip-permissions',
        '-p',
        'Claude Turn 2 via resume-with-instruction',
      ],
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 35,
        cwd: projectDir,
        env: claudeEnv,
      },
    );
    claudePty2.onData((d) => {
      claudeResumeOutput += d;
    });
    claudeResumeStop = await waitForHookCount(claudeEventsFile, 'Stop', 2, 15000);
    try { claudePty2.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  // 1C. Also probe interactive TUI mode of Claude in ConPTY to see what dialog / prompt appears on startup
  let claudeInteractiveOutput = '';
  const claudePtyInteractive = nodePty.spawn(
    CLAUDE_BIN,
    ['--settings', claudeSettingsPath, '--dangerously-skip-permissions'],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 35,
      cwd: projectDir,
      env: claudeEnv,
    },
  );
  claudePtyInteractive.onData((d) => {
    claudeInteractiveOutput += d;
  });
  await new Promise((r) => setTimeout(r, 3500));
  try { claudePtyInteractive.kill(); } catch {}

  // =========================================================================
  // PART 2: P0-B & P0-H — Codex CLI (0.167.0) Hooks + ConPTY + Resume
  // =========================================================================
  const codexEventsFile = path.join(workDir, 'codex-hooks.jsonl');
  const rawCodexHookCmd = `node "${hookScriptPath}" "${codexEventsFile}" "codex"`;

  const codexConfigToml = `
model = "gpt-5.4"
model_provider = "mock_openai"

[features]
hooks = true

[shell_environment_policy]
inherit = "all"

[model_providers.mock_openai]
name = "Mock OpenAI"
base_url = "http://127.0.0.1:${mock.port}/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"

[[hooks.SessionStart]]
matcher = ""
[[hooks.SessionStart.hooks]]
type = "command"
command = ${JSON.stringify(rawCodexHookCmd)}
timeout = 15

[[hooks.UserPromptSubmit]]
matcher = ""
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = ${JSON.stringify(rawCodexHookCmd)}
timeout = 15

[[hooks.Stop]]
matcher = ""
[[hooks.Stop.hooks]]
type = "command"
command = ${JSON.stringify(rawCodexHookCmd)}
timeout = 15
`;
  fs.writeFileSync(path.join(codexHome, 'config.toml'), codexConfigToml.trim() + '\n', 'utf8');

  const codexEnv = {
    ...baseEnv,
    CODEX_HOME: codexHome,
    OPENAI_API_KEY: 'sk-mock-p0b-key',
    OPENAI_BASE_URL: `http://127.0.0.1:${mock.port}/v1`,
  };

  // 2A. Spawn Codex in ConPTY with initial prompt arg (Turn 1), then test idle-wake (Turn 2)
  let codexPtyOutput = '';
  const codexPty1 = nodePty.spawn(
    CODEX_BIN,
    [
      '--no-alt-screen',
      '--no-daemon',
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-hook-trust',
      '-C',
      projectDir,
      'Codex Turn 1 initial task',
    ],
    {
      name: 'xterm-256color',
      cols: 120,
      rows: 35,
      cwd: projectDir,
      env: codexEnv,
    },
  );
  codexPty1.onData((d) => {
    codexPtyOutput += d;
  });

  const codexTurn1Stop = await waitForHookCount(codexEventsFile, 'Stop', 1, 15000);

  // Test idle-wake on Codex interactive ConPTY
  let codexIdleWakePromptSubmit = null;
  let codexIdleWakeStop = null;
  if (codexTurn1Stop) {
    await new Promise((r) => setTimeout(r, 800));
    codexPty1.write('\x1b[200~Codex Turn 2 via idle-wake\x1b[201~');
    await new Promise((r) => setTimeout(r, 400));
    codexPty1.write('\r');

    codexIdleWakePromptSubmit = await waitForHookCount(codexEventsFile, 'UserPromptSubmit', 2, 5000);
    codexIdleWakeStop = await waitForHookCount(codexEventsFile, 'Stop', 2, 12000);
  }
  try { codexPty1.kill(); } catch {}
  await new Promise((r) => setTimeout(r, 400));

  // 2B. P0-H: Test Codex `resume-with-instruction` (`codex resume <sessionId> ... "Codex Turn 3 via resume-with-instruction"`)
  const codexSessionId = codexTurn1Stop?.sessionId;
  const stopsBeforeCodexResume = readJsonl(codexEventsFile).filter((e) => e.hookEventName === 'Stop').length;
  let codexResumeStop = null;
  if (codexSessionId) {
    const codexPtyResume = nodePty.spawn(
      CODEX_BIN,
      [
        'resume',
        codexSessionId,
        '--no-alt-screen',
        '--no-daemon',
        '--dangerously-bypass-approvals-and-sandbox',
        '--dangerously-bypass-hook-trust',
        '-C',
        projectDir,
        'Codex Turn 3 via resume-with-instruction',
      ],
      {
        name: 'xterm-256color',
        cols: 120,
        rows: 35,
        cwd: projectDir,
        env: codexEnv,
      },
    );
    codexPtyResume.onData((d) => {
      codexPtyOutput += d;
    });
    codexResumeStop = await waitForHookCount(codexEventsFile, 'Stop', stopsBeforeCodexResume + 1, 15000);
    try { codexPtyResume.kill(); } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }

  mock.server.close();

  const claudeHookEvents = readJsonl(claudeEventsFile);
  const codexHookEvents = readJsonl(codexEventsFile);

  const report = {
    p0A_Claude: {
      binary: CLAUDE_BIN,
      version: '2.1.318',
      hookEventsRecorded: claudeHookEvents,
      anthropicHttpRequests: mock.anthropicRequests,
      turn1StopVerified: Boolean(claudeTurn1Stop),
      resumeWithInstructionVerified: Boolean(claudeResumeStop),
      resumeSameSessionId: Boolean(claudeSessionId && claudeResumeStop?.sessionId === claudeSessionId),
      resumePreservedContextInHttp: mock.anthropicRequests.some((r) => r.messageCount >= 3),
      claudeTurn1OutputPreview: stripAnsi(claudeTurn1Output).trim().slice(0, 300),
      claudeResumeOutputPreview: stripAnsi(claudeResumeOutput).trim().slice(0, 300),
      claudeInteractiveStartupScreenPreview: stripAnsi(claudeInteractiveOutput).trim().slice(0, 500),
    },
    p0B_Codex: {
      binary: CODEX_BIN,
      version: '0.167.0',
      hookEventsRecorded: codexHookEvents,
      openAiHttpRequests: mock.openAiRequests,
      turn1StopVerified: Boolean(codexTurn1Stop),
      idleWakePromptSubmitVerified: Boolean(codexIdleWakePromptSubmit),
      idleWakeStopVerified: Boolean(codexIdleWakeStop),
      resumeWithInstructionVerified: Boolean(codexResumeStop),
      resumeSameSessionId: Boolean(codexSessionId && codexResumeStop?.sessionId === codexSessionId),
      resumePreservedContextInHttp: mock.openAiRequests.some((r) => r.inputCount >= 3),
      codexPtyOutputPreview: stripAnsi(codexPtyOutput).trim().slice(-600),
    },
  };

  const reportJson = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(__dirname, 'p0-a-b-h-report.json'), reportJson, 'utf8');
  console.log(reportJson);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
