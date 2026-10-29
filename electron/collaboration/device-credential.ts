import { app, safeStorage } from 'electron';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export interface CredentialBinding { ownerId: string; serviceUrl: string; deviceId: string }
export interface DeviceCredentialMetadata extends CredentialBinding {
  version: 1;
  purpose: 'station-device';
  provider: 'electron-safeStorage';
  profileId: string;
  keyFingerprint: string | null;
  appVersion: string;
  electronVersion: string;
  createdAt: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Non-secret diagnostics are synchronous; OS credential operations are async. */
export function credentialContext() {
  const path = resolve(app.getPath('userData'));
  let keyFingerprint: string | null = null;
  try {
    const key = JSON.parse(readFileSync(join(path, 'Local State'), 'utf8')).os_crypt?.encrypted_key;
    if (typeof key === 'string') keyFingerprint = digest(key);
  } catch { /* OS key metadata may be unavailable on this platform. */ }
  return {
    ready: typeof app.isReady === 'function' ? app.isReady() : true,
    profileId: digest(process.platform === 'win32' ? path.toLowerCase() : path),
    keyFingerprint,
    platform: process.platform,
    electron: process.versions.electron ?? 'test-stub',
    appVersion: typeof app.getVersion === 'function' ? app.getVersion() : 'unavailable',
  };
}

export class LocalCredentialError extends Error {
  constructor(readonly kind: string, readonly diagnostic: Record<string, unknown>) {
    super('本机设备凭据无法安全使用（' + kind + '）；原密文、任务和成果已保留。请正常登录后明确选择凭据恢复，重登本身不保证修复。');
  }
}

export function credentialMetadata(binding: CredentialBinding): DeviceCredentialMetadata {
  const context = credentialContext();
  return {
    ...binding, version: 1, purpose: 'station-device', provider: 'electron-safeStorage',
    profileId: context.profileId, keyFingerprint: context.keyFingerprint,
    appVersion: context.appVersion, electronVersion: context.electron, createdAt: new Date().toISOString(),
  };
}

async function requireSecureStorage(detail: Record<string, unknown>): Promise<void> {
  let available = false;
  try {
    available = detail.ready === true && await safeStorage.isAsyncEncryptionAvailable();
    if (process.platform === 'linux') {
      available &&= ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend());
    }
  } catch { /* An unavailable OS keychain must fail closed. */ }
  if (!available) throw new LocalCredentialError('secure-storage-unavailable', { ...detail, available: false });
}

export async function decryptDeviceCredential(
  cipher: string, binding: CredentialBinding, metadata?: DeviceCredentialMetadata,
): Promise<string> {
  const context = credentialContext();
  const detail = { ...context, purpose: 'station-device', format: metadata?.version ?? 'legacy', deviceId: binding.deviceId, ownerId: binding.ownerId };
  await requireSecureStorage(detail);
  if (metadata && (metadata.version !== 1 || metadata.purpose !== 'station-device'
    || metadata.provider !== 'electron-safeStorage' || metadata.ownerId !== binding.ownerId
    || metadata.deviceId !== binding.deviceId || metadata.serviceUrl !== binding.serviceUrl
    || metadata.profileId !== context.profileId)) {
    throw new LocalCredentialError('credential-profile-or-identity-mismatch', detail);
  }
  try {
    const bytes = Buffer.from(cipher, 'base64');
    if (!bytes.length || bytes.toString('base64') !== cipher) {
      throw Object.assign(new Error('Invalid cipher format'), { code: 'INVALID_CIPHER_FORMAT' });
    }
    return (await safeStorage.decryptStringAsync(bytes)).result;
  } catch (error) {
    const exception = error as { name?: string; code?: string };
    throw new LocalCredentialError('local-decryption-failed', {
      ...detail, exceptionName: exception.name ?? 'Error', exceptionCode: exception.code ?? 'SAFE_STORAGE_DECRYPT_FAILED',
      originalKeyFingerprint: metadata?.keyFingerprint ?? null,
      keyChanged: !!metadata?.keyFingerprint && !!context.keyFingerprint && metadata.keyFingerprint !== context.keyFingerprint,
    });
  }
}

export async function encryptDeviceCredential(token: string, binding: CredentialBinding) {
  const context = credentialContext();
  await requireSecureStorage(context);
  let cipher: string;
  try {
    cipher = (await safeStorage.encryptStringAsync(token)).toString('base64');
  } catch (error) {
    const exception = error as { name?: string; code?: string };
    throw new LocalCredentialError('local-encryption-failed', {
      ...context, exceptionName: exception.name ?? 'Error', exceptionCode: exception.code ?? 'SAFE_STORAGE_ENCRYPT_FAILED',
    });
  }
  const metadata = credentialMetadata(binding);
  if (await decryptDeviceCredential(cipher, binding, metadata) !== token) {
    throw new LocalCredentialError('roundtrip-failed', context);
  }
  return { cipher, metadata };
}
