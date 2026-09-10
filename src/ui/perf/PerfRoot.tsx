// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Performance budget top-toolbar control
// ───────────────────────────────────────────────────────────────────────────
// Docked directly in `DocToolbar`'s action group: a compact icon trigger that
// opens a popover anchored to the toolbar, replacing the earlier
// fixed-position toggle + full-height overlay dialog pattern. `PerfPanel`'s
// content/logic is untouched — this is a presentation/mount-point change
// only.
//
// `PerfPanel` is only mounted while `open`, so every time it opens it
// re-reads `ProjectSettings` fresh (via `useProjectSettings`'s lazy
// `useState` initializer) instead of holding a stale snapshot from whenever
// the app first booted.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';

import { Icon } from '../shell/Icon';
import { PerfPanel } from './PerfPanel';
import './perf.css';

export function PerfRoot() {
  const [open, setOpen] = useState(false);

  return (
    <div className="sg-perf-dock">
      <button
        type="button"
        className="sg-perf__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Performance budget"
        title="Performance budget"
      >
        <Icon name="speed" />
      </button>
      {open && (
        <div className="sg-perf__popover" role="dialog" aria-label="Performance budget">
          <button
            type="button"
            className="sg-perf__close"
            onClick={() => setOpen(false)}
            aria-label="Close performance budget"
          >
            <Icon name="close" />
          </button>
          <PerfPanel />
        </div>
      )}
    </div>
  );
}
