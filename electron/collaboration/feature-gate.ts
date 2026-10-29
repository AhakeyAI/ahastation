import { app } from 'electron';

/** Public cross-device functionality stays closed until device signing is ready. */
export function isCollaborationPreviewEnabled(): boolean {
  return !app.isPackaged
    && process.env.AHASTATION_ENABLE_COLLABORATION === '1'
    && process.env.AHASTATION_REMOTE_ALLOW_LOOPBACK === '1'
    && Boolean(process.env.AHASTATION_USER_DATA_DIR);
}

/** Preview traffic can only reach an explicitly selected local fixture Hub. */
export function requirePublicHubUrl(value: string): void {
  if (!isCollaborationPreviewEnabled()) throw new Error('跨设备协作暂未开放');
  const url = new URL(value);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password) {
    throw new Error('隔离协作预览仅允许本机 Hub');
  }
}
