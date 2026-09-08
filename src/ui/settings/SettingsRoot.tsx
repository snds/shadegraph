// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Settings panel mount point
// ───────────────────────────────────────────────────────────────────────────
// Phase 4 scope explicitly keeps this task off `App.tsx` and every other
// existing `src/ui/` file (a parallel Phase 4 task touches a disjoint file
// set in the same shared working tree). `SettingsRoot` is therefore fully
// self-contained: a small fixed-position toggle button plus the panel it
// reveals, mountable by adding ONE sibling element next to `<App />` — no
// existing file's internals need to change for the panel to become reachable.
//
// Props-free, same "reads its own state, renders exactly one root element"
// contract other panes use (see `DocToolbar`/`MainViewer`).
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';

import { SettingsPanel } from './SettingsPanel';
import './settings.css';

export function SettingsRoot() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="sg-settings__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Project settings"
        title="Project settings"
      >
        ⚙
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
              ✕
            </button>
            <SettingsPanel />
          </div>
        </div>
      )}
    </>
  );
}
