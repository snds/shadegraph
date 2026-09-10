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
//
// A draggable divider sits between `graph`/`viewer` (on whichever side dock
// position currently puts it — it moves with them, its drag behavior doesn't
// otherwise change) and resizes `viewer`'s share of the column. That size is
// `ProjectSettings.previewSize`, same load-once/write-through hook and same
// "survives a reload" contract as dock position. The drag itself is
// hand-rolled pointer events, no DnD library — the SAME technique
// `LayerStack.tsx`'s drag-reorder already uses: a ref carries the live value
// across `window` `pointermove`/`pointerup` so `pointerup`'s handler never
// closes over a stale render, state exists only to drive the live visual.
// ═══════════════════════════════════════════════════════════════════════════

import { useRef, useState, type ReactNode } from 'react';

import './mainContentRegion.css';
import { useProjectSettings } from './settings/useProjectSettings';
import { Icon } from './shell/Icon';

interface MainContentRegionProps {
  graph: ReactNode;
  viewer: ReactNode;
}

/** `.sg-viewer`'s original Phase-1 fixed height (`app.css`) — the default
 *  once nothing's been dragged/persisted yet. */
const DEFAULT_PREVIEW_SIZE = 120;
/** Neither pane may shrink smaller than this via the divider — keeps both
 *  the graph and the preview usably visible. */
const MIN_PANE_SIZE = 96;

export function MainContentRegion({ graph, viewer }: MainContentRegionProps) {
  const [settings, updateSettings] = useProjectSettings();
  const position = settings.previewDockPosition ?? 'bottom';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragSizeRef = useRef<number | null>(null);
  // Live drag override, distinct from persisted `settings.previewSize`:
  // `null` while idle (or after a drag commits), a px value while a drag is
  // in progress — same split as `LayerStack.tsx`'s `dragId`/`dropIndicator`,
  // state exists ONLY to drive this render's visual, the ref is what
  // `endResize` reads to commit.
  const [dragSize, setDragSize] = useState<number | null>(null);

  function toggleDockPosition() {
    updateSettings((prev) => ({
      ...prev,
      previewDockPosition: (prev.previewDockPosition ?? 'bottom') === 'bottom' ? 'top' : 'bottom',
    }));
  }

  function beginResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const startClientY = event.clientY;
    const startSize = settings.previewSize ?? DEFAULT_PREVIEW_SIZE;
    // Measured once, at drag start — same "read fresh state, not a stale
    // closure" discipline as `LayerStack.tsx`'s `beginDrag`, just applied to
    // a rect instead of the store.
    const containerSize = container.getBoundingClientRect().height;
    const maxSize = Math.max(MIN_PANE_SIZE, containerSize - MIN_PANE_SIZE);

    function handleMove(ev: PointerEvent) {
      const delta = ev.clientY - startClientY;
      // Dragging the divider toward the graph should always grow the
      // preview, regardless of which side it's docked to — with `viewer` on
      // top, that's a downward drag; on the bottom, an upward one.
      const signedDelta = position === 'top' ? delta : -delta;
      const next = clamp(startSize + signedDelta, MIN_PANE_SIZE, maxSize);
      dragSizeRef.current = next;
      setDragSize(next);
    }

    function endResize() {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', endResize);
      window.removeEventListener('pointercancel', endResize);
      const finalSize = dragSizeRef.current;
      dragSizeRef.current = null;
      setDragSize(null);
      if (finalSize != null) {
        updateSettings((prev) => ({ ...prev, previewSize: finalSize }));
      }
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', endResize);
    window.addEventListener('pointercancel', endResize);
  }

  const previewSize = dragSize ?? settings.previewSize ?? DEFAULT_PREVIEW_SIZE;
  const divider = (
    <div
      className="sg-main-region__divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize preview panel"
      onPointerDown={beginResize}
    />
  );

  return (
    <div
      className="sg-main-region"
      ref={containerRef}
      style={{ '--sg-preview-size': `${previewSize}px` } as React.CSSProperties}
    >
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
          {divider}
          {graph}
        </>
      ) : (
        <>
          {graph}
          {divider}
          {viewer}
        </>
      )}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
