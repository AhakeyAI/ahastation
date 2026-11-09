import type { ObservedSnapshot } from './types.js';

/** One generic notification per newly seen batch; no paths/titles on the lock screen. */
export class ScanNotifications {
  private readonly seen = new Set<string>();
  private lastShownAt = Number.NEGATIVE_INFINITY;
  private close?: () => void;
  constructor(private readonly show: () => (() => void) | undefined, private readonly now = Date.now) {}
  update(snapshot: ObservedSnapshot): void {
    const pending = snapshot.pendingDirectories ?? [];
    if (!snapshot.access?.enabled || !pending.length) { this.close?.(); this.close = undefined; return; }
    if (this.seen.size >= 1000 || this.now() - this.lastShownAt < 60_000 || !pending.some((row) => !this.seen.has(row.key))) return;
    this.close?.(); this.close = undefined;
    try { this.close = this.show(); } catch { /* In-app review remains available. */ }
    // A denied OS notification must not be retried every fast scan.
    this.lastShownAt = this.now();
    for (const row of pending) if (this.seen.size < 1000) this.seen.add(row.key);
  }
}
