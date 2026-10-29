// Settings information architecture, shared by the top-bar settings dropdown
// and the settings window's side nav so both always list the same items in
// the same order. Picking an item opens the settings window on that section.

import { AudioLines, Blocks, Brain, Code2, Cpu, Fingerprint, Network, Settings2, Sparkles, Volume2, type LucideIcon } from 'lucide-react';

export type SettingsSectionId =
  | 'backends'
  | 'ahatalk'
  | 'speech'
  | 'ide'
  | 'skills'
  | 'memory'
  | 'voicelock'
  | 'collab'
  | 'general'
  | 'upcoming';

export interface SettingsSection {
  id: SettingsSectionId;
  title: string;
  /** One plain sentence: what you change here. */
  description: string;
  icon: LucideIcon;
}

export interface SettingsGroup {
  label: string;
  sections: SettingsSection[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: 'AI 与语音',
    sections: [
      { id: 'backends', title: 'AI 后端', description: '登录 Claude、Codex，选 Host 和 Worker 用谁', icon: Cpu },
      { id: 'ahatalk', title: 'AhaTalk', description: '语音识别走哪条路径，口语要不要整理', icon: AudioLines },
      { id: 'speech', title: '播报', description: '播报音色、过滤哪些内容、长回复怎么念', icon: Volume2 },
    ],
  },
  {
    label: '工作区',
    sections: [
      { id: 'ide', title: '编辑器', description: '打开文件和交付成果时用哪个 IDE', icon: Code2 },
      { id: 'skills', title: '技能', description: '管理 Host 和 Worker 能调用的技能', icon: Sparkles },
      { id: 'memory', title: '记忆', description: '查看和清理 Host 记住的项目信息', icon: Brain },
    ],
  },
  {
    label: '安全与设备',
    sections: [
      { id: 'voicelock', title: '声纹锁', description: '只响应你本人的声音', icon: Fingerprint },
      { id: 'collab', title: '多设备协作', description: '实验功能：让多台设备加入同一个会议', icon: Network },
    ],
  },
  {
    label: '其他',
    sections: [
      { id: 'general', title: '通用', description: '版本更新、桌面或掌机布局', icon: Settings2 },
      { id: 'upcoming', title: '即将推出', description: '正在开发、还不能用的设置', icon: Blocks },
    ],
  },
];

export const SETTINGS_SECTIONS: SettingsSection[] = SETTINGS_GROUPS.flatMap((g) => g.sections);

/** Map a focus request (a section id, or a legacy in-section anchor) to a section. */
export function resolveSettingsSection(focus: string | null | undefined): SettingsSectionId {
  if (!focus) return 'backends';
  if (focus.startsWith('backends')) return 'backends';
  return SETTINGS_SECTIONS.find((s) => s.id === focus)?.id ?? 'backends';
}
