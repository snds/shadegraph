// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Group/frame geometry
// ───────────────────────────────────────────────────────────────────────────
// Pure geometry for `NodeGroup` bounds, kept free of React Flow so it is
// testable without a canvas: computing a frame around a selection, and
// deciding whether a dragged node's center now falls inside one. `GraphCanvas`
// supplies the actual node rects (measured via React Flow) and bounds (read
// from the document); this file only does the math.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeGroup } from '../../model/document';

/** A node's on-canvas footprint in flow coordinates. */
export interface NodeRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Fallback footprint for a node React Flow has not measured yet (should be
 *  rare — selection implies it already rendered — but keeps this pure
 *  function total rather than throwing). */
export const FALLBACK_NODE_SIZE = { width: 220, height: 140 };

/** Padding around the selection's bounding box, and extra headroom at the top
 *  for the frame's title bar. */
export const GROUP_PADDING = 32;
export const GROUP_HEADER_HEIGHT = 36;

/** The frame that tightly wraps `rects`, plus padding, or `null` for an empty
 *  selection. */
export function boundsForNodes(rects: NodeRect[]): NodeGroup['bounds'] | null {
  if (rects.length === 0) return null;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.width));
  const maxY = Math.max(...rects.map((r) => r.y + r.height));
  return {
    x: minX - GROUP_PADDING,
    y: minY - GROUP_PADDING - GROUP_HEADER_HEIGHT,
    w: maxX - minX + GROUP_PADDING * 2,
    h: maxY - minY + GROUP_PADDING * 2 + GROUP_HEADER_HEIGHT,
  };
}

/** The center point of a node's footprint — what "dragged into/out of a
 *  frame" tests against, rather than the raw (top-left) position. */
export function rectCenter(rect: NodeRect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Whether point `(x, y)` falls within `bounds`. */
export function pointInBounds(x: number, y: number, bounds: NodeGroup['bounds']): boolean {
  return x >= bounds.x && x <= bounds.x + bounds.w && y >= bounds.y && y <= bounds.y + bounds.h;
}

/** Which of `groups` (if any) a dragged node's rect now belongs in, by
 *  testing its center point. When a rect's center falls inside more than one
 *  group's bounds (overlapping frames), the last match wins — the same "top
 *  of the stack" convention frames render with (later `groups` entries drawn
 *  last / on top). Returns `undefined` when the rect is outside every
 *  group — the caller's cue to clear `groupId`. */
export function groupContaining(rect: NodeRect, groups: NodeGroup[]): string | undefined {
  const center = rectCenter(rect);
  let found: string | undefined;
  for (const group of groups) {
    if (pointInBounds(center.x, center.y, group.bounds)) found = group.id;
  }
  return found;
}
