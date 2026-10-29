import type { BackendInfo } from '../types';

/** One read at a time; a settings change during a read requests a fresh read. */
export function watchBackendList(update: (rows: BackendInfo[]) => void, failed: (error: unknown) => void) {
  let disposed = false, busy = false, dirty = false;
  const refresh = async () => {
    dirty = true;
    if (busy || disposed) return;
    busy = true;
    try {
      while (dirty && !disposed) {
        dirty = false;
        try {
          const rows = await window.vibeMeet.backendAuth.list();
          if (!disposed && !dirty) update(rows);
        } catch (error) { if (!disposed) failed(error); }
      }
    } finally { busy = false; }
  };
  const onFocus = () => { void refresh(); };
  const unsubscribe = window.vibeMeet.remoteControl.onChanged(onFocus);
  window.addEventListener('focus', onFocus);
  void refresh();
  return () => { disposed = true; unsubscribe(); window.removeEventListener('focus', onFocus); };
}
