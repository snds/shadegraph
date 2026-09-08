// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique panel mount point
// ───────────────────────────────────────────────────────────────────────────
// Same self-contained-pane pattern as `SettingsRoot.tsx`/`PerfRoot.tsx`/
// `AssetBrowserPanel.tsx` (Phase 4's established convention for concurrent,
// disjoint tasks sharing one working tree): a small fixed-position toggle
// button plus the panel it reveals, mountable by adding ONE sibling element
// next to `<App />` — no existing file's internals need to change. See
// `src/main.tsx` for the one-line addition.
//
// `CritiquePanel` is only mounted while `open`, so every open re-reads
// `ProjectSettings` fresh (via `useProjectSettings`'s lazy `useState`
// initializer) rather than holding a stale snapshot from app boot.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';

import { CritiquePanel } from './CritiquePanel';
import './critique.css';

export function CritiqueRoot() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="sg-critique__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Reference critique"
        title="Reference critique"
      >
        ◎
      </button>
      {open && (
        <div className="sg-critique__overlay" role="dialog" aria-label="Reference critique">
          <div className="sg-critique__dialog">
            <button
              type="button"
              className="sg-critique__close"
              onClick={() => setOpen(false)}
              aria-label="Close reference critique"
            >
              ✕
            </button>
            <CritiquePanel />
          </div>
        </div>
      )}
    </>
  );
}
