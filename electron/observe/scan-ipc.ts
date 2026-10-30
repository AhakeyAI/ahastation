import { dialog, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import { emptyPayloadSchema, handleSecure, mainWindowSenderPolicy } from '../ipc/validators.js';
import { ScanAccessStore } from './scan-access.js';
import type { ObserveService } from './observe-service.js';
import type { ObservedSnapshot } from './types.js';

export function registerScanIpc(options: {
  window: () => BrowserWindow | null;
  access: ScanAccessStore;
  service: ObserveService;
  snapshot: () => ObservedSnapshot;
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
        detail: '扫描 Claude、Codex 的本机历史和运行中会话。为定位项目，会先读取有限的会话标识与目录元数据；只有你选择的目录才会读取会话标题和状态。不会修改原会话、启动 Agent 或共享到其他设备。可随时停用并清除扫描授权。',
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
  return { promptFirstRun: async () => options.access.needsPrompt ? chooseDirectory() : undefined };
}
