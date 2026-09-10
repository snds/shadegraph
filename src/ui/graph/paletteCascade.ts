// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Cascade offset for anchor-less node adds
// ───────────────────────────────────────────────────────────────────────────
// Some ways of adding a node have no pointer position to anchor on (unlike
// double-click / right-click, which always land where the user pointed): the
// Nodes gallery's click-to-add (`galleryPlacement.ts`) is the current caller.
// Without this offset, every such add would land on the exact same point and
// stack invisibly. Each call fans the anchor out along a diagonal, wrapping
// back to the start after `CASCADE_CYCLE` steps so a long run of adds never
// drifts off-screen.
// ═══════════════════════════════════════════════════════════════════════════

/** Pixels per step, in screen space. */
const CASCADE_STEP = 32;

/** Steps before the cascade wraps back to the first offset. */
export const CASCADE_CYCLE = 8;

export interface CascadeOffset {
  dx: number;
  dy: number;
}

/** `index` is the 0-based count of anchor-less adds so far. Pure and
 *  deterministic so it is testable without React or React Flow. */
export function cascadeOffset(index: number): CascadeOffset {
  const step = (index % CASCADE_CYCLE) + 1;
  return { dx: CASCADE_STEP * step, dy: CASCADE_STEP * step };
}
