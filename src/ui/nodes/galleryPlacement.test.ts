import { describe, expect, it } from 'vitest';

import { GALLERY_PLACEMENT_ANCHOR, galleryAddPosition } from './galleryPlacement';

describe('galleryAddPosition', () => {
  it('starts at an offset from the anchor, not exactly on it', () => {
    const first = galleryAddPosition(0);
    expect(first.x).toBeGreaterThan(GALLERY_PLACEMENT_ANCHOR.x);
    expect(first.y).toBeGreaterThan(GALLERY_PLACEMENT_ANCHOR.y);
  });

  it('fans out further with each successive add', () => {
    const a = galleryAddPosition(0);
    const b = galleryAddPosition(1);
    expect(b.x).toBeGreaterThan(a.x);
    expect(b.y).toBeGreaterThan(a.y);
  });

  it('never returns the same point twice within a cycle', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      const p = galleryAddPosition(i);
      seen.add(`${p.x},${p.y}`);
    }
    expect(seen.size).toBe(8);
  });
});
