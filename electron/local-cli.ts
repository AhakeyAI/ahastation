// Manual terminals launch the user's installed commands with their own
// configuration. They do not use meeting backends, SDKs, or app API keys.
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { augmentedPath, resolveBinaryFromPath } from './backends/subprocess-backend.js';
import { resolveDefaultShell } from './pty-host.js';

export const LOCAL_CLI_IDS = ['codex', 'claude', 'opencode', 'qoder', 'kimi', 'qwen', 'pi', 'gemini'] as const;
export type LocalCliId = typeof LOCAL_CLI_IDS[number];
export const LOCAL_SHELL_IDS = ['default', 'pwsh', 'powershell', 'cmd', 'git-bash'] as const;
export type LocalShellId = typeof LOCAL_SHELL_IDS[number];

const COMMANDS: Record<LocalCliId, { label: string; command: string }> = {
  codex: { label: 'Codex', command: 'codex' },
  claude: { label: 'Claude Code', command: 'claude' },
  opencode: { label: 'OpenCode', command: 'opencode' },
  qoder: { label: 'Qoder CLI', command: 'qodercli' },
  kimi: { label: 'Kimi', command: 'kimi' },
  qwen: { label: 'Qwen Code', command: 'qwen' },
  pi: { label: 'Pi', command: 'pi' },
  gemini: { label: 'Gemini CLI', command: 'gemini' },
};

export function listLocalClis() {
  return LOCAL_CLI_IDS.flatMap((id) => {
    const entry = COMMANDS[id];
    const binaryPath = resolveBinaryFromPath(entry.command);
    return binaryPath ? [{ id, ...entry, binaryPath }] : [];
  });
}

export function listLocalShells() {
  const defaultPath = resolveDefaultShell();
  const entries = [{ id: 'default', label: `默认终端 · ${basename(defaultPath).replace(/\.exe$/i, '')}`, command: 'shell', binaryPath: defaultPath }];
  if (process.platform !== 'win32') return entries;
  for (const [id, label] of [['pwsh', 'PowerShell 7'], ['powershell', 'Windows PowerShell'], ['cmd', '命令提示符']] as const) {
    const binaryPath = resolveBinaryFromPath(id);
    if (binaryPath) entries.push({ id, label, command: id, binaryPath });
  }
  const git = resolveBinaryFromPath('git');
  const gitBash = [
    ...(git ? [join(dirname(git), '..', 'bin', 'bash.exe')] : []),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 'Git', 'bin', 'bash.exe'),
  ].find(existsSync);
  if (gitBash) entries.push({ id: 'git-bash', label: 'Git Bash', command: 'bash', binaryPath: gitBash });
  return entries;
}

export function resolveLocalTerminal(cliId?: LocalCliId, shellId: LocalShellId = 'default') {
  const file = cliId ? resolveBinaryFromPath(COMMANDS[cliId].command)
    : shellId === 'default' ? resolveDefaultShell() : listLocalShells().find((shell) => shell.id === shellId)?.binaryPath;
  if (!file) throw new Error(`未找到本机 ${cliId ? COMMANDS[cliId].label : 'Shell'}，请检查安装和 PATH 后重试。`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: augmentedPath(),
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  // Electron switches belong to the app, not a manually launched CLI.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  // Keep the user's color and theme preferences unchanged. TERM and
  // COLORTERM above describe the embedded terminal's capabilities only.
  return { file, args: !cliId && shellId === 'git-bash' ? ['--login', '-i'] : [], env, cwd: homedir() };
}
