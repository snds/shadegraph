// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset browser: auto-graph thumbnail planning
// ───────────────────────────────────────────────────────────────────────────
// The pure decision behind `AssetBrowserPanel.tsx`'s per-row thumbnail cell,
// split out the same way `virtualRange.ts`/`graphThis.ts` are: no React, no
// store, no GPU — just "given this node's already-in-memory recognition
// data, what should the row show", so it is unit-testable with plain
// `AssetTreeNode` fixtures.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShaderDocument } from '../../model/document';
import type { AssetTreeNode } from '../../storage';
import { autoGraphContentSignature, buildAutoGraphDocument } from '../../storage/recognition';

/** Same `${rootId}::${nodeId}` convention `assetStore.ts`'s own `previewKey`
 *  uses for reference-media object URLs — kept identical here so a nodeId
 *  that happens to collide across two different connected roots can never
 *  collide in the thumbnail scheduler's cache either. */
export function assetThumbnailKey(rootId: string, nodeId: string): string {
  return `${rootId}::${nodeId}`;
}

/** What `AssetRow`'s thumbnail cell should show for one node, computed
 *  PURELY from already-in-memory data (`node.recognizedObjects`/
 *  `node.sourceText`, populated by `recognizeNode`'s lazy, visible-only
 *  recognition — never re-read from disk here):
 *
 *  - `'none'`     — not a recognized file (a folder, or a file that
 *                   failed/hasn't finished recognition yet) — the existing
 *                   plain folder/file icon.
 *  - `'fallback'` — recognized, but `buildAutoGraphDocument` refused (e.g. a
 *                   `missing-requires` chunk) — this task's "consolidated
 *                   single generic node icon" case, never a broken/blank
 *                   cell.
 *  - `'render'`   — a real throwaway document is ready to compile + render. */
export type AssetThumbnailPlan =
  | { kind: 'none' }
  | { kind: 'fallback' }
  | { kind: 'render'; doc: ShaderDocument; signature: string };

export function planAssetThumbnail(node: AssetTreeNode): AssetThumbnailPlan {
  if (node.kind !== 'file' || !node.recognized || !node.recognizedObjects || node.sourceText === undefined) {
    return { kind: 'none' };
  }
  const result = buildAutoGraphDocument(node.recognizedObjects, node.sourceText);
  if (!result.ok) return { kind: 'fallback' };
  return { kind: 'render', doc: result.doc, signature: autoGraphContentSignature(node.sourceText) };
}
