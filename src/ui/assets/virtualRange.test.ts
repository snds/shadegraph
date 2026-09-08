import { describe, expect, it } from 'vitest';

import { computeVirtualRange } from './virtualRange';

describe('computeVirtualRange', () => {
  it('renders only a small overscanned window for a huge list at the top', () => {
    const range = computeVirtualRange(0, 300, 24, 10_000, 4);
    expect(range.startIndex).toBe(0);
    // visible rows = ceil(300/24) = 13, + 4 overscan = 17
    expect(range.endIndex).toBe(17);
    expect(range.offsetY).toBe(0);
    expect(range.totalHeight).toBe(10_000 * 24);
  });

  it('shifts the window forward, with overscan, as scrollTop increases', () => {
    const range = computeVirtualRange(2400, 300, 24, 10_000, 4);
    // firstVisible = 2400/24 = 100
    expect(range.startIndex).toBe(96);
    expect(range.offsetY).toBe(96 * 24);
    expect(range.endIndex).toBe(100 + 13 + 4);
  });

  it('clamps the end index to the item count near the bottom of the list', () => {
    const range = computeVirtualRange(2350, 300, 24, 100, 4);
    expect(range.endIndex).toBe(100);
    expect(range.endIndex).toBeLessThanOrEqual(100);
  });

  it('returns an empty range for an empty list', () => {
    const range = computeVirtualRange(0, 300, 24, 0);
    expect(range).toEqual({ startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 });
  });
});
