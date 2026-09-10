// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Gallery click-to-add placement
// ───────────────────────────────────────────────────────────────────────────
// Clicking a gallery entry (as opposed to dragging it, which drops exactly
// where the pointer released — see `GraphCanvas.tsx`'s drop handler) has no
// pointer position to anchor on, the same problem the old "+ Add node"
// toolbar button had. Reuses that button's fan-out cascade
// (`paletteCascade.ts`) around a fixed flow-space anchor instead of a
// screen-space pane center, since the gallery lives outside the canvas'
// `ReactFlowProvider` and has no `screenToFlowPosition` to call.
// ═══════════════════════════════════════════════════════════════════════════

import { cascadeOffset } from '../graph/paletteCascade';

/** Flow-space anchor for the first click-to-add. Near the origin, matching
 *  where a fresh document's own nodes start out. */
export const GALLERY_PLACEMENT_ANCHOR = { x: 40, y: 40 };

/** `index` is the 0-based count of gallery click-to-adds so far in this
 *  session. Pure and deterministic, mirroring `cascadeOffset` itself. */
export function galleryAddPosition(index: number): { x: number; y: number } {
  const offset = cascadeOffset(index);
  return { x: GALLERY_PLACEMENT_ANCHOR.x + offset.dx, y: GALLERY_PLACEMENT_ANCHOR.y + offset.dy };
}
