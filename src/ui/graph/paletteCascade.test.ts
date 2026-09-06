import { describe, expect, it } from 'vitest';

import { CASCADE_CYCLE, cascadeOffset } from './paletteCascade';

describe('cascadeOffset', () => {
  it('starts with a nonzero offset', () => {
    const first = cascadeOffset(0);
    expect(first.dx).toBeGreaterThan(0);
    expect(first.dy).toBeGreaterThan(0);
  });

  it('increases with each successive index within a cycle', () => {
    const a = cascadeOffset(0);
    const b = cascadeOffset(1);
    const c = cascadeOffset(2);
    expect(b.dx).toBeGreaterThan(a.dx);
    expect(c.dx).toBeGreaterThan(b.dx);
  });

  it('wraps back to the first offset after a full cycle', () => {
    expect(cascadeOffset(CASCADE_CYCLE)).toEqual(cascadeOffset(0));
    expect(cascadeOffset(CASCADE_CYCLE + 3)).toEqual(cascadeOffset(3));
  });

  it('never returns a zero offset, so repeats never fully overlap', () => {
    for (let i = 0; i < CASCADE_CYCLE * 2; i++) {
      const { dx, dy } = cascadeOffset(i);
      expect(dx).not.toBe(0);
      expect(dy).not.toBe(0);
    }
  });
});
