// SettingsMenu — top-bar gear with a dropdown of settings sections. Picking a
// section opens the standalone settings window (or re-targets the open one)
// on that section; the list comes from settings-sections so the dropdown and
// the window's side nav never drift.

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Settings } from 'lucide-react';
import { SETTINGS_GROUPS, type SettingsSectionId } from '../lib/settings-sections';

interface SettingsMenuProps {
  /** Voice-print enrollment in progress — dots the gear and 声纹锁. */
  badge?: boolean;
}

export function SettingsMenu({ badge = false }: SettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (id: SettingsSectionId) => {
    setOpen(false);
    void window.vibeMeet.settingsWindow.open({ focus: id });
  };

  return (
    <div className="settings-menu" ref={wrapRef}>
      <button
        type="button"
        className={`settings-menu-btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="设置"
        title="设置"
      >
        <Settings size={16} aria-hidden="true" />
        <ChevronDown size={12} aria-hidden="true" className="settings-menu-caret" />
        {badge && <span className="settings-menu-badge" />}
      </button>
      {open && (
        <div
          className="settings-dropdown"
          role="menu"
          aria-label="设置"
          ref={menuRef}
          onKeyDown={(event) => {
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
            } else if (event.key === 'Escape') {
              setOpen(false);
              wrapRef.current?.querySelector<HTMLButtonElement>('.settings-menu-btn')?.focus();
            }
          }}
        >
          {SETTINGS_GROUPS.map((group) => (
            <div className="settings-dropdown-group" role="group" aria-label={group.label} key={group.label}>
              <div className="settings-dropdown-label">{group.label}</div>
              {group.sections.map((item) => {
                const Icon = item.icon;
                return (
                  <button type="button" role="menuitem" className="settings-dropdown-item" key={item.id} onClick={() => pick(item.id)}>
                    <span className="settings-dropdown-icon"><Icon size={15} aria-hidden="true" /></span>
                    <span className="settings-dropdown-text">
                      <span className="settings-dropdown-title">
                        {item.title}
                        {badge && item.id === 'voicelock' && <span className="settings-dropdown-dot" aria-label="录入中" />}
                      </span>
                      <span className="settings-dropdown-desc">{item.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
