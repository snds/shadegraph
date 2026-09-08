// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Performance budget panel mount point
// ───────────────────────────────────────────────────────────────────────────
// Same self-contained-pane pattern as `SettingsRoot.tsx`/`AssetBrowserPanel`
// (Phase 4's established convention for concurrent, disjoint tasks sharing
// one working tree): a small fixed-position toggle button plus the panel it
// reveals, mountable by adding ONE sibling element next to `<App />` — no
// existing file's internals need to change for the panel to become reachable.
//
// `PerfPanel` is only mounted while `open`, mirroring `SettingsRoot` — so
// every time it opens it re-reads `ProjectSettings` fresh (via
// `useProjectSettings`'s lazy `useState` initializer) instead of holding a
// stale snapshot from whenever the app first booted.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';

import { PerfPanel } from './PerfPanel';
import './perf.css';

export function PerfRoot() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="sg-perf__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Performance budget"
        title="Performance budget"
      >
        ⏱
      </button>
      {open && (
        <div className="sg-perf__overlay" role="dialog" aria-label="Performance budget">
          <div className="sg-perf__dialog">
            <button
              type="button"
              className="sg-perf__close"
              onClick={() => setOpen(false)}
              aria-label="Close performance budget"
            >
              ✕
            </button>
            <PerfPanel />
          </div>
        </div>
      )}
    </>
  );
}
