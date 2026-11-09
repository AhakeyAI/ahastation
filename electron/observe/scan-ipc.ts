import { dialog, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { z } from 'zod';
import { emptyPayloadSchema, handleSecure, mainWindowSenderPolicy } from '../ipc/validators.js';
import { canReadProject, ScanAccessStore } from './scan-access.js';
import { ScanPreferences } from './scan-preferences.js';
import { readOwnership, ownershipKey } from './ownership.js';
import type { ObserveService } from './observe-service.js';
import type { ObservedSnapshot } from './types.js';

export function registerScanIpc(options: {
  window: () => BrowserWindow | null;
  access: ScanAccessStore;
  service: ObserveService;
  snapshot: () => ObservedSnapshot;
  preferences?: ScanPreferences;
  ownershipPath?: string;
}) {
  const authorize = mainWindowSenderPolicy(() => options.window()?.webContents.id ?? null);
  const common = { authorize, schema: emptyPayloadSchema };
  handleSecure('observe:getSnapshot', { ...common, handler: () => options.snapshot() });
  let choosing = false;
  const chooseDirectory = async () => {
    const win = options.window();
    if (!win || choosing) return { ok: false, error: '请先完成当前授权操作' };
    choosing = true;
    try {
      // Remember the first offer as disabled before opening the dialog. Cancel
      // never grants access and does not prompt again at each subsequent start.
      if (options.access.needsPrompt) {
        const save = options.access.set({ enabled: false, roots: [] });
        const initialRevision = options.access.revision;
        await save;
        if (options.access.revision !== initialRevision) return { ok: true, canceled: true };
      }
      const revision = options.access.revision;
      const consent = await dialog.showMessageBox(win, {
        type: 'question', title: '本机会话扫描', message: '允许只读扫描所选目录的会话？',
        detail: '扫描 Claude、Codex 的本机历史和运行中会话。先读取有限的会话标识与目录元数据，发现其他目录时提醒你确认；只有获准目录才会读取会话标题和状态。不会修改原会话、启动 Agent 或共享到其他设备。可忽略会话或目录提醒，也可随时停用并清除扫描授权。',
        buttons: ['取消', '选择允许读取的目录'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (consent.response !== 1) return { ok: true, canceled: true };
      const picked = await dialog.showOpenDialog(win, { title: '允许读取此目录下的会话', properties: ['openDirectory'] });
      if (picked.canceled || picked.filePaths.length !== 1) return { ok: true, canceled: true };
      const root = await fs.realpath(picked.filePaths[0]);
      if (options.access.revision !== revision) return { ok: true, canceled: true };
      const roots = [...new Set([...options.access.get().roots, root])];
      if (roots.length > 100) return { ok: false, error: '最多授权 100 个目录' };
      await options.access.set({ enabled: true, roots });
      options.service.invalidate();
      await options.service.tickOnce();
      return { ok: true };
    } finally { choosing = false; }
  };
  handleSecure('observe:allowDirectory', { ...common, handler: chooseDirectory });
  handleSecure('observe:disable', { ...common, handler: async () => {
    const write = options.access.set({ enabled: false, roots: [] });
    options.service.invalidate();
    await write;
    return { ok: true };
  } });
  const preferences = options.preferences;
  if (preferences) {
    const directorySchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
    const resolveDirectory = async (key: string) => {
      const row = options.snapshot().pendingDirectories?.find((candidate) => candidate.key === key);
      if (!row || !options.access.get().enabled || !preferences.available || preferences.hiddenDirectory(key)
        || await fs.realpath(row.path).catch(() => null) !== row.path
        || !await fs.stat(row.path).then((stat) => stat.isDirectory()).catch(() => false)) return null;
      return row;
    };
    handleSecure('observe:reviewDirectory', { authorize, schema: directorySchema, handler: async ({ key }) => {
      const win = options.window();
      if (!win || choosing) return { ok: false, error: '请先完成当前授权操作' };
      choosing = true;
      try {
        const revision = options.access.revision, preferenceRevision = preferences.revision;
        const row = await resolveDirectory(key);
        if (!row) return { ok: false, error: '待授权目录已变化，请刷新后重试' };
        const before = await fs.stat(row.path);
        const consent = await dialog.showMessageBox(win, { type: 'question', title: '确认目录扫描授权',
          message: '允许读取这个目录下的本机会话？', detail: `${row.path}\n\n仅授予此目录及其子目录的只读扫描权限，读取会话标题和状态。不会授予 Agent 执行、文件写入或跨设备分享权限，不会启动或关闭原会话。其他工作树和目录需要分别授权。`,
          buttons: ['取消', '允许只读扫描'], defaultId: 0, cancelId: 0, noLink: true });
        const after = await fs.stat(row.path).catch(() => null);
        if (consent.response !== 1 || !(await resolveDirectory(key)) || !after || before.dev !== after.dev || before.ino !== after.ino
          || options.access.revision !== revision || preferences.revision !== preferenceRevision) return { ok: true, canceled: true };
        const roots = [...new Set([...options.access.get().roots, row.path])];
        if (roots.length > 100) return { ok: false, error: '最多授权 100 个目录' };
        await options.access.set({ enabled: true, roots });
        options.service.invalidate(); await options.service.tickOnce();
        return { ok: true };
      } finally { choosing = false; }
    } });
    handleSecure('observe:ignoreDirectory', { authorize, schema: directorySchema, handler: async ({ key }) => {
      if (!await resolveDirectory(key)) return { ok: false, error: '待授权目录已变化，请刷新后重试' };
      await preferences.hide('directory', key);
      options.service.invalidate(); await options.service.tickOnce(); return { ok: true };
    } });
    handleSecure('observe:ignoreSession', { authorize, schema: z.object({ id: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
      handler: async ({ id }) => {
        const session = options.snapshot().sessions.find((row) => row.id === id);
        const revision = options.access.revision;
        if (!session || !['user', 'user-adopted'].includes(session.origin ?? '') || session.ownership === 'unresolved'
          || !await canReadProject(session.cwd, options.access.get())) return { ok: false, error: '只能忽略已授权且归属明确的用户会话' };
        if (options.ownershipPath) {
          const latest = await readOwnership(options.ownershipPath);
          const origin = latest.origins.get(ownershipKey(session.clientKind === 'claude-code' ? 'claude' : 'codex', session.nativeSessionId));
          if (!latest.available || (origin ?? (latest.pending ? 'unknown' : 'user')) !== session.origin) return { ok: false, error: '会话归属已变化，请刷新后重试' };
        }
        if (options.access.revision !== revision) return { ok: false, error: '扫描授权已变化，请重试' };
        await preferences.hide('session', id);
        options.service.invalidate(); await options.service.tickOnce(); return { ok: true };
      } });
    handleSecure('observe:restoreHidden', { ...common, handler: async () => {
      const win = options.window();
      if (!win || choosing) return { ok: false, error: '请先完成当前授权操作' };
      choosing = true;
      try {
        const consent = await dialog.showMessageBox(win, { type: 'question', title: '恢复扫描显示',
          message: preferences.available ? '恢复所有已忽略的会话和目录提醒？' : '忽略记录无法读取，确认重置？',
          detail: '恢复后仍按当前扫描授权读取。此操作不会授予新目录权限、启动 Agent 或修改原会话。',
          buttons: ['取消', '恢复显示'], defaultId: 0, cancelId: 0, noLink: true });
        if (consent.response !== 1) return { ok: true, canceled: true };
        await preferences.restore(); options.service.invalidate(); await options.service.tickOnce(); return { ok: true };
      } finally { choosing = false; }
    } });
  }
  return { promptFirstRun: async () => options.access.needsPrompt ? chooseDirectory() : undefined };
}
