import { describe, expect, it } from 'vitest';

import '../../nodes/definitions';
import { nodes } from '../../nodes/registry';
import { CATEGORY_ORDER } from '../graph/AddNodePalette';
import { groupedNodeDefinitions } from './galleryGroups';

describe('groupedNodeDefinitions', () => {
  it('includes every registered node type exactly once', () => {
    const flattened = groupedNodeDefinitions().flatMap((g) => g.defs);
    const flattenedTypes = flattened.map((d) => d.type).sort();
    const registeredTypes = nodes
      .all()
      .map((d) => d.type)
      .sort();
    expect(flattenedTypes).toEqual(registeredTypes);
  });

  it('groups the starter set under the categories CATEGORY_ORDER expects', () => {
    const groups = groupedNodeDefinitions();
    const byType = new Map(groups.flatMap((g) => g.defs.map((d) => [d.type, g.category] as const)));
    expect(byType.get('input.uv')).toBe('input');
    expect(byType.get('math.mix')).toBe('math');
    expect(byType.get('noise.fbm')).toBe('noise');
    expect(byType.get('color.ramp')).toBe('color');
    expect(byType.get('output.surface')).toBe('output');
    expect(byType.get('chunk.raw')).toBe('imported');
  });

  it('orders known categories per CATEGORY_ORDER, before any unlisted ones', () => {
    const groups = groupedNodeDefinitions();
    const knownSeen = groups.map((g) => g.category).filter((c) => CATEGORY_ORDER.includes(c));
    const ranks = knownSeen.map((c) => CATEGORY_ORDER.indexOf(c));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('sorts definitions within a category alphabetically by title', () => {
    for (const group of groupedNodeDefinitions()) {
      const titles = group.defs.map((d) => d.title);
      expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
    }
  });
});
