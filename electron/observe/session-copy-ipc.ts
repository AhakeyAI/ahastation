import { dialog, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { emptyPayloadSchema, handleSecure, mainWindowSenderPolicy } from '../ipc/validators.js';
import { SessionCopyStorage, SessionCopyStorageError } from './session-copy-storage.js';

export function registerSessionCopyIpc(options: { window: () => BrowserWindow | null; storage: SessionCopyStorage }) {
  const authorize = mainWindowSenderPolicy(() => options.window()?.webContents.id ?? null);
  const errorResult = (error: unknown) => ({ ok: false, error: error instanceof SessionCopyStorageError
    && error.code === 'preparation-changed' ? '备份记录已变化，请刷新后重新确认'
    : error instanceof SessionCopyStorageError && error.code === 'busy' ? '备份正在使用，请稍后重试'
    : '备份暂不可管理，请保留原文件并检查本机存储' });
  handleSecure('observe:listSessionCopies', { authorize, schema: emptyPayloadSchema, handler: async () => {
    try { return { ok: true, inventory: await options.storage.list() }; }
    catch (error) { return errorResult(error); }
  } });
  let confirming = false;
  handleSecure('observe:discardSessionCopy', { authorize, schema: z.object({
    preparationId: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    revision: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(), handler: async ({ preparationId, revision }) => {
    const win = options.window();
    if (!win || confirming) return { ok: false, error: '请先完成当前备份确认操作' };
    confirming = true;
    try {
      const row = (await options.storage.list()).entries.find(entry => entry.preparationId === preparationId);
      if (!row?.revision || row.revision !== revision) return errorResult(new SessionCopyStorageError('preparation-changed'));
      const answer = await dialog.showMessageBox(win, { type: 'warning', title: '删除本机会话备份',
        message: '永久删除这份备份和准备副本？',
        detail: `记录 ${preparationId}\n占用 ${row.storedBytes} 字节。\n\n这会删除此准备记录中的备份与工作副本，无法撤销。原始 CLI 会话和项目文件保持不变，也不会结束正在运行的会话。`,
        buttons: ['取消', '永久删除备份'], defaultId: 0, cancelId: 0, noLink: true });
      if (answer.response !== 1 || options.window() !== win) return { ok: true, canceled: true };
      await options.storage.discard(preparationId, revision);
      return { ok: true };
    } catch (error) { return errorResult(error); }
    finally { confirming = false; }
  } });
}
