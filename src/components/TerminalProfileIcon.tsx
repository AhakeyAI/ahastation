import { Terminal, GitBranch } from 'lucide-react';
import { BackendAvatar } from './BackendAvatar';
import { ClaudeIcon, GeminiIcon, OpenAIIcon, OpenCodeIcon, PiIcon, QwenIcon } from './TerminalBrandIcons';

const BRAND_ICONS: Record<string, typeof OpenAIIcon> = {
  claude: ClaudeIcon,
  codex: OpenAIIcon,
  gemini: GeminiIcon,
  opencode: OpenCodeIcon,
  pi: PiIcon,
  qwen: QwenIcon,
};

export function TerminalProfileIcon({ id, size = 16 }: { id?: string; size?: number }) {
  const BrandIcon = id ? BRAND_ICONS[id] : undefined;
  if (BrandIcon) return <span className="terminal-profile-icon" style={{ width: size, height: size }} aria-hidden="true">
    <BrandIcon size={size} />
  </span>;
  if (id && ['kimi', 'qoder'].includes(id)) {
    return <span className="terminal-profile-icon" style={{ width: size, height: size }} aria-hidden="true"><BackendAvatar iconId={id} size={size} /></span>;
  }
  return <span className={`terminal-profile-icon profile-${id ?? 'shell'}`} style={{ width: size, height: size }} aria-hidden="true">
    {id === 'git-bash' ? <GitBranch size={size} /> : <Terminal size={size} />}
  </span>;
}
