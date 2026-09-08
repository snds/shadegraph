// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset browser: virtualization hook
// ───────────────────────────────────────────────────────────────────────────
// Wires `computeVirtualRange`'s pure math to a scroll container: recomputes
// on scroll and on the container's own resize (a `ResizeObserver`, so the
// panel resizing/opening still gets a correct viewport height even before any
// scroll event fires).
// ═══════════════════════════════════════════════════════════════════════════

import { useLayoutEffect, useRef, useState } from 'react';

import { computeVirtualRange, type VirtualRange } from './virtualRange';

export function useVirtualRows(itemCount: number, rowHeight: number, overscan = 6) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState<VirtualRange>(() =>
    computeVirtualRange(0, 0, rowHeight, itemCount, overscan),
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const update = (): void => {
      setRange(computeVirtualRange(el.scrollTop, el.clientHeight, rowHeight, itemCount, overscan));
    };
    update();

    el.addEventListener('scroll', update, { passive: true });
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(el);

    return () => {
      el.removeEventListener('scroll', update);
      resizeObserver.disconnect();
    };
  }, [itemCount, rowHeight, overscan]);

  return { containerRef, range };
}
