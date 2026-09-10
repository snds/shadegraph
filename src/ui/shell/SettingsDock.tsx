// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Settings, bottom-docked in the pivot rail
// ───────────────────────────────────────────────────────────────────────────
// NOT a pivot item — Settings lives in the rail's bottom dock, separate from
// the Layers/Assets/Nodes/Manifest/Critique list (see `PivotRail.tsx`).
// Reuses the real `SettingsPanel` unchanged; only the chrome around it is
// new. Same self-contained "own toggle + own overlay" shape the old
// `SettingsRoot.tsx` used, just relocated into the rail's dock instead of a
// fixed-position corner button, and using the shared `Icon` component.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';

import { SettingsPanel } from '../settings/SettingsPanel';
import '../settings/settings.css';
import { Icon } from './Icon';

export function SettingsDock({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="sg-rail__dock-item"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Project settings"
        title="Project settings"
      >
        <Icon name="settings" />
        {!collapsed && <span className="sg-rail__label">Settings</span>}
      </button>
      {open && (
        <div className="sg-settings__overlay" role="dialog" aria-label="Project settings">
          <div className="sg-settings__dialog">
            <button
              type="button"
              className="sg-settings__close"
              onClick={() => setOpen(false)}
              aria-label="Close project settings"
            >
              <Icon name="close" title="Close" />
            </button>
            <SettingsPanel />
          </div>
        </div>
      )}
    </>
  );
}
