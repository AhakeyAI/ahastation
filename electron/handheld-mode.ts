// handheld-mode.ts — UI mode detection (Phase 5, §3.3).
//
// Three-way setting: auto (default) / force-handheld / force-desktop,
// persisted in settings.json. The AUTO heuristic only decides the mode when
// no override is set: (pointer: coarse) AND screen.width ≤ 1300 → handheld.
// Layout is driven by a root class from the RESOLVED mode — never by raw
// width breakpoints (a pure-width rule misses both target devices: Steam
// Deck 1280 would land desktop, AhaStation 1080p/7" at 2x lands compact).
//
// Canonical copy: node tests import the compiled version of this file.
// The renderer has a hand-synced mirror in src/lib/handheld-mode.ts.

export type HandheldOverride = 'auto' | 'handheld' | 'desktop';
export type UiMode = 'handheld' | 'desktop';

// Handheld layout is parked (2026-11-05): until it is redesigned as its own,
// simpler interaction, every setting resolves to the desktop UI. The stored
// three-way setting and the auto heuristic below are kept for that redesign.
export const HANDHELD_LAYOUT_ENABLED = false;

export const HANDHELD_AUTO_MAX_SCREEN_WIDTH = 1300;

export function resolveUiMode(
  override: HandheldOverride,
  pointerCoarse: boolean,
  screenWidth: number,
): UiMode {
  if (!HANDHELD_LAYOUT_ENABLED) return 'desktop';
  if (override === 'handheld') return 'handheld';
  if (override === 'desktop') return 'desktop';
  return pointerCoarse && screenWidth <= HANDHELD_AUTO_MAX_SCREEN_WIDTH
    ? 'handheld'
    : 'desktop';
}
