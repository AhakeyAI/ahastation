// codex-terminal-adapter.ts — interactive `codex` TUI as a Worker backend.
//
// Runs the user's own Codex CLI inside a PtyHost pty (see the generic
// skeleton in terminal-cli-adapter.ts). The Stop hook is injected via
// `-c key=value` inline-TOML overrides on the command line, so the user's
// own ~/.codex/config.toml (auth, project trust, model prefs) stays fully
// intact — no managed CODEX_HOME, no config writes.
//
// Known limitation (docs/research/codex-cli-protocol.md): non-managed
// command hooks must be trusted once in the TUI (`/hooks`) before they fire.
// The terminal worker is human-supervised by design, so this surfaces as a
// one-time prompt the user answers at the stage terminal; the confirm bar
// remains the manual fallback until then.

import type { BackendCapabilities } from './cli-backend.js';
import { resolveBinaryFromPath } from './subprocess-backend.js';
import {
  TerminalCliBackend,
  type TerminalCliBackendDeps,
  type TerminalCliProfile,
} from './terminal-cli-adapter.js';

const CODEX_TERMINAL_CAPABILITIES: BackendCapabilities = {
  coordinate: false,
  executeTasks: true,
  displayName: 'Codex (终端)',
  iconId: 'codex',
  mcp: false,
  permissions: false,
  systemPrompt: false,
  skills: false,
  interrupt: true,
  // No pinned defaultModel: 'auto' omits `-m` so Codex inherits the user's own
  // ~/.codex/config.toml model unless a task explicitly selects a model.
  models: ['gpt-5.4'],
  installHint: '使用本机已安装的 codex CLI（PATH 上的 codex 命令，npm i -g @openai/codex）',
};

export const CODEX_TERMINAL_PROFILE: TerminalCliProfile = {
  id: 'codex-terminal',
  capabilities: CODEX_TERMINAL_CAPABILITIES,
  displayLabel: 'Codex',
  resolveBinary: () => resolveBinaryFromPath('codex'),
  buildCliArgs: (config) => {
    const args: string[] = [];
    if (config.model && config.model !== 'auto') args.push('-m', config.model);
    // Native CLI Worker launches always preserve Codex's own permission/sandbox
    // configuration and never inject --full-auto or bypass flags.
    if (
      config.executionRole !== 'worker'
      && !config.taskProfile
      && !config.nativeCliWorker
    ) {
      if (config.autoApproveScope === 'read') args.push('--full-auto');
      else if (config.autoApproveScope === 'all') {
        args.push('--dangerously-bypass-approvals-and-sandbox');
      }
    }
    return args;
  },
  registerTurnHook: ({ hookCommand }) => {
    // Inline-TOML injection: `codex -c hooks=true -c 'hooks.Stop=[...]'`.
    // The hook command is embedded as a TOML basic string (backslashes and
    // double quotes escaped). No files are created here — the shared hook
    // script and events file are skeleton-managed.
    const tomlCommand = hookCommand.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return {
      cliArgs: [
        '-c', 'features.hooks=true',
        '-c', `hooks.Stop=[{matcher="",hooks=[{type="command",command="${tomlCommand}",timeout=30}]}]`,
      ],
      cleanupPaths: [],
    };
  },
  startupMessage: '终端 Codex 已启动，任务提示词将自动注入 TUI。若提示信任目录或 hooks，请在终端中确认一次。',
  missingBinaryMessage: '未找到 codex CLI，可执行文件不在 PATH 上。可运行 npm i -g @openai/codex 安装。',
  startupBlocker: {
    pattern: /\bTERM\s+is\s+set\s+to\s+["'“‘]?dumb\b/i,
    message: 'Codex 拒绝在 TERM=dumb 的终端中启动。请重新打开任务终端后重试。',
  },
  loginGate: {
    pattern: /sign\s+in\s+with\s+chatgpt|continue\s+with\s+api\s+key|codex\s+login|log\s+in\s+to\s+openai|authenticate\s+with\s+your\s+chatgpt/i,
    message: '检测到 Codex CLI 登录界面，请先在终端完成登录再点击「发送待发任务」。',
  },
  applyAuth: (env, auth) => {
    if (auth.apiKey) env.OPENAI_API_KEY = auth.apiKey;
    if (auth.baseUrl) env.OPENAI_BASE_URL = auth.baseUrl;
  },
};

export class CodexTerminalBackend extends TerminalCliBackend {
  constructor(deps: TerminalCliBackendDeps = {}) {
    super(CODEX_TERMINAL_PROFILE, deps);
  }
}
