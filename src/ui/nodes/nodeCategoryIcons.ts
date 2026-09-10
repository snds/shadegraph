// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Node gallery category icons
// ───────────────────────────────────────────────────────────────────────────
// One static Material Symbol per `NodeCategory`, used by the gallery
// (`NodeGallery.tsx`) as a cheap category glyph — deliberately NOT a live
// rendered thumbnail (that only ever happens once a node is actually placed
// on the canvas; see `ShaderNodeCard.tsx`'s preview wiring). Pure data, no
// React, so the "every category has an icon" contract is unit-testable
// without a DOM.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeCategory } from '../../nodes/registry';

/** Ligature name for the shared `Icon` component (`src/ui/shell/Icon.tsx`) —
 *  see https://fonts.google.com/icons for the full catalog. */
export const NODE_CATEGORY_ICON: Record<NodeCategory, string> = {
  input: 'input',
  math: 'functions',
  noise: 'grain',
  color: 'palette',
  sdf: 'shapes',
  lighting: 'flare',
  texture: 'texture',
  util: 'build',
  imported: 'download',
  output: 'output',
};

/** Falls back to a generic glyph rather than throwing — keeps the gallery
 *  rendering even if `NodeCategory` grows a member before this map does. */
export function categoryIcon(category: NodeCategory): string {
  return NODE_CATEGORY_ICON[category] ?? 'category';
}
