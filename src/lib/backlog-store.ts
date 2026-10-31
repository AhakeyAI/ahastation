// Renderer mirror of the board's 待派工 cards (electron/backlog.ts). Loaded once,
// then kept fresh by 'backlog:changed'.

import { useSyncExternalStore } from 'react';
import type { BacklogItem } from './project-rooms';

const EMPTY: BacklogItem[] = [];

class BacklogStore {
  private items: BacklogItem[] = EMPTY;
  private listeners = new Set<() => void>();
  private started = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): BacklogItem[] => this.items;

  private start(): void {
    const api = window.vibeMeet?.projects;
    if (this.started || !api) return;
    this.started = true;
    api.onBacklogChanged?.((items) => this.set(items));
    void api.backlogList?.().then((res) => { if (res.ok) this.set(res.items); }).catch(() => {});
  }

  private set(items: BacklogItem[]): void {
    this.items = items;
    for (const fn of this.listeners) fn();
  }
}

export const backlogStore = new BacklogStore();

export function useBacklog(): BacklogItem[] {
  return useSyncExternalStore(backlogStore.subscribe, backlogStore.getSnapshot, backlogStore.getSnapshot);
}
