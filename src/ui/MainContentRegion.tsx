// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — main content region (graph canvas + preview, dockable)
// ───────────────────────────────────────────────────────────────────────────
// `GraphCanvas` and `MainViewer` together fill one column to the right of the
// pivot rail (`Shell`) and to the left of `Inspector`. This component owns
// ONLY their vertical order — which of the two sits on top — never their
// internals: both are passed in as already-built elements (`graph`/`viewer`
// props) exactly as `App.tsx` used to mount them directly, so neither
// `GraphCanvas.tsx` nor `MainViewer.tsx` changes for this.
//
// Dock position ('top' puts the preview above the graph, 'bottom' — today's
// pre-existing default, preview as a footer — puts it below) is read from
// `ProjectSettings.previewDockPosition` via `useProjectSettings`, the same
// load-once/write-through hook every other settings-backed pane already
// uses, so the choice survives a reload the same way those do.
// ═══════════════════════════════════════════════════════════════════════════

import type { ReactNode } from 'react';

import './mainContentRegion.css';
import { useProjectSettings } from './settings/useProjectSettings';
import { Icon } from './shell/Icon';

interface MainContentRegionProps {
  graph: ReactNode;
  viewer: ReactNode;
}

export function MainContentRegion({ graph, viewer }: MainContentRegionProps) {
  const [settings, updateSettings] = useProjectSettings();
  const position = settings.previewDockPosition ?? 'bottom';

  function toggleDockPosition() {
    updateSettings((prev) => ({
      ...prev,
      previewDockPosition: (prev.previewDockPosition ?? 'bottom') === 'bottom' ? 'top' : 'bottom',
    }));
  }

  return (
    <div className="sg-main-region">
      <button
        type="button"
        className="sg-main-region__dock-toggle"
        onClick={toggleDockPosition}
        aria-pressed={position === 'top'}
        aria-label={position === 'top' ? 'Dock preview to bottom' : 'Dock preview to top'}
        title={position === 'top' ? 'Dock preview to bottom' : 'Dock preview to top'}
      >
        <Icon name="swap_vert" />
      </button>
      {position === 'top' ? (
        <>
          {viewer}
          {graph}
        </>
      ) : (
        <>
          {graph}
          {viewer}
        </>
      )}
    </div>
  );
}
