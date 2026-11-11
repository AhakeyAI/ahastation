import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CODEX_BIN = process.env.CODEX_BIN || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');

function sendSse(res, eventType, payload) {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`);
}

class JsonRpcStdioClient {
  constructor(binaryPath, args, env, cwd) {
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.stderrLines = [];
    this.onRequestHandler = null;
    this.notificationWaiters = [];

    this.proc = spawn(binaryPath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const rlOut = readline.createInterface({ input: this.proc.stdout });
    rlOut.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id !== undefined && msg.method) {
        // Server-to-client request
        this.serverRequests.push(msg);
        if (this.onRequestHandler) {
          Promise.resolve(this.onRequestHandler(msg))
            .then((result) => {
              this.proc.stdin.write(JSON.stringify({ id: msg.id, result }) + '\n');
            })
            .catch((err) => {
              this.proc.stdin.write(
                JSON.stringify({ id: msg.id, error: { code: -32000, message: String(err?.message ?? err) } }) + '\n',
              );
            });
        }
      } else if (msg.id !== undefined) {
        // Response to client request
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.notifications.push(msg);
        for (const w of [...this.notificationWaiters]) {
          if (w.predicate(msg)) {
            this.notificationWaiters.splice(this.notificationWaiters.indexOf(w), 1);
            w.resolve(msg);
          }
        }
      }
    });

    const rlErr = readline.createInterface({ input: this.proc.stderr });
    rlErr.on('line', (line) => {
      this.stderrLines.push(line);
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.proc.stdin.write(JSON.stringify({ method, params }) + '\n');
  }

  waitForNotification(predicate, timeoutMs = 4000) {
    for (const existing of this.notifications) {
      if (predicate(existing)) return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.kill();
        reject(new Error(`Timed out waiting for notification. Seen: ${JSON.stringify(this.notifications)} | Stderr: ${this.stderrLines.slice(-5).join(' // ')}`));
      }, timeoutMs);
      this.notificationWaiters.push({
        predicate,
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
      });
    });
  }

  kill() {
    try {
      this.proc.kill();
    } catch {}
  }
}

async function main() {
  const workDir = path.join(__dirname, `p0-g-codex-host-data-${Date.now()}`);
  const codexHome = path.join(workDir, 'codex-home');
  const projectCwd = path.join(workDir, 'project');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(projectCwd, { recursive: true });

  const openAiRequests = [];
  let holdStreamForInterrupt = false;
  let heldRes = null;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyStr = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try {
      body = JSON.parse(bodyStr);
    } catch {}

    openAiRequests.push({
      method: req.method,
      url: req.url,
      model: body.model,
      toolsCount: Array.isArray(body.tools) ? body.tools.length : 0,
      toolNames: Array.isArray(body.tools) ? body.tools.map((t) => t.name || t.type) : [],
      inputItems: Array.isArray(body.input) ? body.input : [],
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    if (holdStreamForInterrupt) {
      heldRes = res;
      sendSse(res, 'response.created', {
        type: 'response.created',
        response: {
          id: 'resp_hold',
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'in_progress',
          model: body.model || 'gpt-5.4',
          output: [],
        },
      });
      req.on('close', () => {
        heldRes = null;
      });
      return;
    }

    // Check if the request input already includes function_call_output for call_p0g_001
    const hasToolOutput = Array.isArray(body.input) && body.input.some(
      (item) => item.type === 'function_call_output' && item.call_id === 'call_p0g_001',
    );

    if (!hasToolOutput) {
      // First leg of Turn 1: emit a dynamic tool call to PrepareDispatch
      const callArgs = JSON.stringify({
        requestId: 'req-p0g-1',
        targetAgentId: 'worker-alpha',
        instruction: 'Implement feature X',
      });
      sendSse(res, 'response.created', {
        type: 'response.created',
        response: {
          id: 'resp_1',
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'in_progress',
          model: body.model || 'gpt-5.4',
          output: [],
        },
      });
      const fcItem = {
        id: 'fc_p0g_1',
        type: 'function_call',
        status: 'completed',
        call_id: 'call_p0g_001',
        name: 'PrepareDispatch',
        arguments: callArgs,
      };
      sendSse(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...fcItem, status: 'in_progress', arguments: '' },
      });
      sendSse(res, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_p0g_1',
        output_index: 0,
        delta: callArgs,
      });
      sendSse(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: fcItem,
      });
      sendSse(res, 'response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          status: 'completed',
          model: body.model || 'gpt-5.4',
          output: [fcItem],
          usage: { input_tokens: 25, output_tokens: 15, total_tokens: 40 },
        },
      });
      res.end();
      return;
    }

    // Second leg of Turn 1: after dynamic tool result is returned
    const msgItem = {
      id: 'msg_p0g_1',
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'PrepareDispatch succeeded with token tok-p0g-verified.',
          annotations: [],
        },
      ],
    };
    sendSse(res, 'response.created', {
      type: 'response.created',
      response: {
        id: 'resp_2',
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'in_progress',
        model: body.model || 'gpt-5.4',
        output: [],
      },
    });
    sendSse(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...msgItem, status: 'in_progress', content: [] },
    });
    sendSse(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: msgItem,
    });
    sendSse(res, 'response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_2',
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        status: 'completed',
        model: body.model || 'gpt-5.4',
        output: [msgItem],
        usage: { input_tokens: 40, output_tokens: 12, total_tokens: 52 },
      },
    });
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // Write config.toml in codexHome so codex app-server uses our local mock OpenAI base URL without ChatGPT login
  const configToml = `
model = "gpt-5.4"
model_provider = "mock_openai"

[model_providers.mock_openai]
name = "Mock OpenAI"
base_url = "http://127.0.0.1:${port}/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
`;
  fs.writeFileSync(path.join(codexHome, 'config.toml'), configToml.trim() + '\n', 'utf8');

  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    OPENAI_API_KEY: 'sk-mock-p0g-key',
    OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
  };

  const client1 = new JsonRpcStdioClient(CODEX_BIN, ['app-server', '--stdio'], env, projectCwd);

  const interceptedToolCalls = [];
  client1.onRequestHandler = async (req) => {
    if (req.method === 'item/tool/call') {
      interceptedToolCalls.push(req.params);
      return {
        contentItems: [
          {
            type: 'inputText',
            text: JSON.stringify({
              ok: true,
              dispatchToken: 'tok-p0g-verified',
              source: 'host_tool',
              sourceId: req.params.callId,
            }),
          },
        ],
        success: true,
      };
    }
    throw new Error(`Unexpected server request: ${req.method}`);
  };

  // 1. Initialize with experimentalApi: true
  const initRes = await client1.request('initialize', {
    clientInfo: { name: 'ahastation-p0g', title: 'AhaStudio P0-G Probe', version: '0.19.0' },
    capabilities: { experimentalApi: true },
  });
  client1.notify('initialized', {});

  // 2. Start thread with dynamicTools
  const dynamicTools = [
    {
      name: 'PrepareDispatch',
      description: 'Authorize and prepare an instruction dispatch to a worker agent.',
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          targetAgentId: { type: 'string' },
          instruction: { type: 'string' },
        },
        required: ['requestId', 'targetAgentId', 'instruction'],
        additionalProperties: false,
      },
    },
    {
      name: 'ListAgents',
      description: 'List active agents in the workflow.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  ];

  const threadStartRes = await client1.request('thread/start', {
    cwd: projectCwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    developerInstructions: 'You are the Workflow Host.',
    dynamicTools,
    experimentalRawEvents: false,
  });
  const threadId = threadStartRes.thread.id;

  // 3. Start Turn 1 (triggers PrepareDispatch dynamicToolCall -> tool response -> assistant completion)
  const turn1StartRes = await client1.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Please dispatch feature X to worker-alpha.', text_elements: [] }],
  });
  const turn1Id = turn1StartRes.turn.id;

  const turn1Completed = await client1.waitForNotification(
    (n) => n.method === 'turn/completed' && n.params?.turn?.id === turn1Id,
    15000,
  );

  // 4. Start Turn 2 with held SSE stream and test turn/interrupt
  holdStreamForInterrupt = true;
  const turn2StartRes = await client1.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Start a long running thought.', text_elements: [] }],
  });
  const turn2Id = turn2StartRes.turn.id;

  // Wait briefly for Turn 2 HTTP request to arrive at mock server
  await new Promise((r) => setTimeout(r, 300));
  const interruptRes = await client1.request('turn/interrupt', {
    threadId,
    turnId: turn2Id,
  });
  const turn2Completed = await client1.waitForNotification(
    (n) => n.method === 'turn/completed' && n.params?.turn?.id === turn2Id,
    15000,
  );
  if (heldRes) {
    try { heldRes.end(); } catch {}
  }
  holdStreamForInterrupt = false;

  // 5. Simulate Host crash / restart: kill client1 and start client2 against same CODEX_HOME, then thread/resume!
  client1.kill();
  await new Promise((r) => setTimeout(r, 300));

  const client2 = new JsonRpcStdioClient(CODEX_BIN, ['app-server', '--stdio'], env, projectCwd);
  await client2.request('initialize', {
    clientInfo: { name: 'ahastation-p0g-restart', title: 'AhaStudio P0-G Restart', version: '0.19.0' },
    capabilities: { experimentalApi: true },
  });
  client2.notify('initialized', {});

  const resumeRes = await client2.request('thread/resume', {
    threadId,
    dynamicTools,
  });

  // Also test thread/turns/list with itemsView: "full" if supported
  let turnsListRes = null;
  try {
    turnsListRes = await client2.request('thread/turns/list', {
      threadId,
      itemsView: 'full',
    });
  } catch (err) {
    turnsListRes = { error: String(err?.message ?? err) };
  }

  client2.kill();
  server.close();

  // Extract persisted dynamicToolCall items from resumeRes.thread.turns
  const resumedTurns = resumeRes?.thread?.turns ?? [];
  const resumedDynamicToolItems = [];
  for (const t of resumedTurns) {
    for (const item of t.items ?? []) {
      if (item.type === 'dynamicToolCall') {
        resumedDynamicToolItems.push(item);
      }
    }
  }

  const report = {
    initUserAgent: initRes.userAgent,
    threadId,
    turn1: {
      turnId: turn1Id,
      completedStatus: turn1Completed.params.turn.status,
      interceptedToolCalls,
      secondOpenAiRequestReceivedToolOutput: openAiRequests.length >= 2 && openAiRequests[1].inputItems.some(
        (i) => i.type === 'function_call_output' && i.call_id === 'call_p0g_001',
      ),
    },
    turn2Interrupt: {
      turnId: turn2Id,
      interruptResponse: interruptRes,
      completedStatus: turn2Completed.params.turn.status,
    },
    crashResume: {
      resumedThreadId: resumeRes?.thread?.id,
      resumedTurnCount: resumedTurns.length,
      resumedDynamicToolItems,
      callIdPreservedAfterRestart: resumedDynamicToolItems.some((item) => item.id === 'call_p0g_001'),
      turnsListRes,
    },
  };

  const reportJson = JSON.stringify(report, null, 2);
  fs.writeFileSync(path.join(__dirname, 'p0-g-report.json'), reportJson, 'utf8');
  console.log(reportJson);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
