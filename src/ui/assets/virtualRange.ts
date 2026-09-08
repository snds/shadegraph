// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset browser: virtualization math
// ───────────────────────────────────────────────────────────────────────────
// Pure fixed-row-height windowing, deliberately hand-rolled instead of a new
// dependency (no virtualization library is in `package.json`, and this is a
// small, well-understood calculation). Split out from `useVirtualRows.ts` so
// it's unit-testable without a DOM/jsdom — the hook itself just wires this to
// a scroll-container ref and re-renders on scroll.
// ═══════════════════════════════════════════════════════════════════════════

export interface VirtualRange {
  /** First rendered row index (inclusive). */
  startIndex: number;
  /** Last rendered row index (exclusive). */
  endIndex: number;
  /** `transform: translateY(...)`-style offset for the rendered slice. */
  offsetY: number;
  /** Total scrollable height of the full (unvirtualized) list. */
  totalHeight: number;
}

export function computeVirtualRange(
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  itemCount: number,
  overscan = 6,
): VirtualRange {
  const totalHeight = itemCount * rowHeight;
  if (itemCount === 0 || viewportHeight <= 0 || rowHeight <= 0) {
    return { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight };
  }
  const firstVisible = Math.floor(scrollTop / rowHeight);
  const visibleRowCount = Math.ceil(viewportHeight / rowHeight);
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(itemCount, firstVisible + visibleRowCount + overscan);
  return { startIndex, endIndex, offsetY: startIndex * rowHeight, totalHeight };
}
