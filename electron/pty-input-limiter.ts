/** Shared by local PTYs and the IDE bridge; no Electron or settings dependency. */
export const PTY_INPUT_MAX_BYTES = 8192;
export const PTY_INPUT_MAX_PER_SECOND = 60;

export class PtyInputLimiter {
  private second = -1;
  private count = 0;
  dropped = 0;

  allow(bytes: number, now: number = Date.now()): boolean {
    if (bytes > PTY_INPUT_MAX_BYTES) { this.dropped++; return false; }
    const second = Math.floor(now / 1000);
    if (second !== this.second) { this.second = second; this.count = 0; }
    if (this.count >= PTY_INPUT_MAX_PER_SECOND) { this.dropped++; return false; }
    this.count++;
    return true;
  }
}
