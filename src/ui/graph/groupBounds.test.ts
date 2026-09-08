import { describe, expect, it } from 'vitest';

import type { NodeGroup } from '../../model/document';
import {
  GROUP_HEADER_HEIGHT,
  GROUP_PADDING,
  boundsForNodes,
  groupContaining,
  pointInBounds,
  rectCenter,
  type NodeRect,
} from './groupBounds';

describe('boundsForNodes', () => {
  it('returns null for an empty selection', () => {
    expect(boundsForNodes([])).toBeNull();
  });

  it('wraps a single rect with padding and header headroom', () => {
    const rect: NodeRect = { id: 'a', x: 100, y: 100, width: 200, height: 100 };
    const bounds = boundsForNodes([rect]);
    expect(bounds).toEqual({
      x: 100 - GROUP_PADDING,
      y: 100 - GROUP_PADDING - GROUP_HEADER_HEIGHT,
      w: 200 + GROUP_PADDING * 2,
      h: 100 + GROUP_PADDING * 2 + GROUP_HEADER_HEIGHT,
    });
  });

  it('tightly wraps the union of several rects', () => {
    const rects: NodeRect[] = [
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 300, y: 200, width: 100, height: 50 },
    ];
    const bounds = boundsForNodes(rects)!;
    expect(bounds.x).toBe(0 - GROUP_PADDING);
    expect(bounds.y).toBe(0 - GROUP_PADDING - GROUP_HEADER_HEIGHT);
    expect(bounds.w).toBe(400 + GROUP_PADDING * 2);
    expect(bounds.h).toBe(250 + GROUP_PADDING * 2 + GROUP_HEADER_HEIGHT);
  });
});

describe('rectCenter', () => {
  it('is the midpoint of the rect', () => {
    expect(rectCenter({ id: 'a', x: 10, y: 20, width: 100, height: 40 })).toEqual({ x: 60, y: 40 });
  });
});

describe('pointInBounds', () => {
  const bounds: NodeGroup['bounds'] = { x: 0, y: 0, w: 100, h: 100 };

  it('is true for points inside, including the edges', () => {
    expect(pointInBounds(50, 50, bounds)).toBe(true);
    expect(pointInBounds(0, 0, bounds)).toBe(true);
    expect(pointInBounds(100, 100, bounds)).toBe(true);
  });

  it('is false for points outside', () => {
    expect(pointInBounds(-1, 50, bounds)).toBe(false);
    expect(pointInBounds(50, 101, bounds)).toBe(false);
  });
});

describe('groupContaining', () => {
  const groups: NodeGroup[] = [
    { id: 'g1', title: 'A', bounds: { x: 0, y: 0, w: 100, h: 100 } },
    { id: 'g2', title: 'B', bounds: { x: 200, y: 200, w: 100, h: 100 } },
  ];

  it('finds the group whose bounds contain the rect center', () => {
    const rect: NodeRect = { id: 'n', x: 20, y: 20, width: 20, height: 20 };
    expect(groupContaining(rect, groups)).toBe('g1');
  });

  it('returns undefined when the rect center is outside every group', () => {
    const rect: NodeRect = { id: 'n', x: 500, y: 500, width: 20, height: 20 };
    expect(groupContaining(rect, groups)).toBeUndefined();
  });

  it('prefers the later group when frames overlap', () => {
    const overlapping: NodeGroup[] = [
      { id: 'g1', title: 'A', bounds: { x: 0, y: 0, w: 100, h: 100 } },
      { id: 'g2', title: 'B', bounds: { x: 0, y: 0, w: 200, h: 200 } },
    ];
    const rect: NodeRect = { id: 'n', x: 10, y: 10, width: 10, height: 10 };
    expect(groupContaining(rect, overlapping)).toBe('g2');
  });
});
