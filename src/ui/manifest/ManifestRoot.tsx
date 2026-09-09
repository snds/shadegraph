// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Project-manifest panel mount point
// ───────────────────────────────────────────────────────────────────────────
// Same self-contained-pane treatment `SettingsRoot.tsx` uses: a small
// fixed-position toggle button plus the panel it reveals, mountable by adding
// ONE sibling element next to `<App />` in `main.tsx` — no existing file's
// internals need to change for the panel to become reachable.
//
// Props-free, same "reads its own state, renders exactly one root element"
// contract other panes use.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';

import { ManifestPanel } from './ManifestPanel';
import './manifest.css';

export function ManifestRoot() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="sg-manifest__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Project manifest"
        title="Project manifest"
      >
        📁
      </button>
      {open && (
        <div className="sg-manifest__overlay" role="dialog" aria-label="Project manifest">
          <div className="sg-manifest__dialog">
            <button
              type="button"
              className="sg-manifest__close"
              onClick={() => setOpen(false)}
              aria-label="Close project manifest"
            >
              ✕
            </button>
            <ManifestPanel />
          </div>
        </div>
      )}
    </>
  );
}
