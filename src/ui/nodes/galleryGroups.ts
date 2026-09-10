// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Node gallery grouping
// ───────────────────────────────────────────────────────────────────────────
// Pure grouping logic for `NodeGallery.tsx`, kept free of React so it is
// testable without a DOM (matching `groupBounds.ts`/`paletteCascade.ts`'s
// split from their React callers). Groups the registry by category in the
// same order the right-click `AddNodePalette` uses, so the two node-adding
// surfaces never disagree about grouping.
// ═══════════════════════════════════════════════════════════════════════════

import { nodes, type NodeCategory, type NodeDefinition } from '../../nodes/registry';
import { CATEGORY_ORDER } from '../graph/AddNodePalette';

export const CATEGORY_LABEL: Record<NodeCategory, string> = {
  input: 'Input',
  math: 'Math',
  noise: 'Noise',
  color: 'Color',
  sdf: 'SDF',
  lighting: 'Lighting',
  texture: 'Texture',
  util: 'Util',
  imported: 'Imported',
  output: 'Output',
};

export interface CategoryGroup {
  category: NodeCategory;
  defs: NodeDefinition[];
}

/** All registered definitions, grouped and ordered exactly like
 *  `AddNodePalette`'s `CATEGORY_ORDER` — any category not in that list still
 *  appears (alphabetically, after the known ones) rather than being dropped,
 *  so a new `NodeCategory` never silently disappears from the gallery. */
export function groupedNodeDefinitions(): CategoryGroup[] {
  const byCategory = nodes.byCategory();
  const seen = new Set<NodeCategory>();
  const groups: CategoryGroup[] = [];

  for (const category of CATEGORY_ORDER) {
    const defs = byCategory[category];
    if (defs?.length) {
      groups.push({ category, defs: [...defs].sort((a, b) => a.title.localeCompare(b.title)) });
      seen.add(category);
    }
  }
  const remaining = (Object.keys(byCategory) as NodeCategory[])
    .filter((c) => !seen.has(c) && byCategory[c]?.length)
    .sort();
  for (const category of remaining) {
    groups.push({ category, defs: [...byCategory[category]].sort((a, b) => a.title.localeCompare(b.title)) });
  }
  return groups;
}
