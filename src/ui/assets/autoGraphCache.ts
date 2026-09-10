// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset browser: auto-graph → "graph this" reuse cache
// ───────────────────────────────────────────────────────────────────────────
// "Formalize, don't discard" (this task's own scope): the background
// auto-graph pass (`AssetBrowserPanel.tsx`'s `useAssetThumbnailFrame`) already
// builds a real `ShaderNode` per recognized object, purely to render a
// thumbnail from. This tiny module is the seam that lets `graphThis.ts`'s
// real "graph this" action REUSE that exact node — same id, same params,
// same `chunkSource` — instead of calling `graphFromRecognizedObject` a
// second time for the same (object, sourceText) pair.
//
// Deliberately a plain module-level cache, not store state: it holds no
// document/manifest data of its own (only a caller-built throwaway
// `ShaderDocument`, same one already handed to the preview renderer) and
// nothing outside `src/ui/assets/` ever reads it — same "cheap opportunistic
// cache" treatment as `LayerStack.tsx`'s `visibleStackIds` module-level
// `Set`. A cache MISS (key never populated, or `sourceText`'s signature has
// since changed) is always safe — `graphThis.ts` falls back to deriving a
// fresh node exactly as it did before this task, so this is purely a
// dedup/performance seam, never a correctness dependency.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShaderDocument, ShaderLayer, ShaderNode } from '../../model/document';
import { autoGraphContentSignature } from '../../storage/recognition';

interface CacheEntry {
  signature: string;
  doc: ShaderDocument;
}

const cache = new Map<string, CacheEntry>();

/** Records the throwaway document an auto-graph render just built for `key`
 *  (`assetThumbnailKey(rootId, nodeId)`) — called every time
 *  `useAssetThumbnailFrame` has a `'render'`-plan doc to hand the preview
 *  renderer, so the cache always reflects the LATEST content actually
 *  rendered (or about to be). */
export function cacheAutoGraphDocument(key: string, signature: string, doc: ShaderDocument): void {
  cache.set(key, { signature, doc });
}

/** Drops `key`'s cached document — pairs with `releaseAssetThumbnailsForRoot`
 *  (a connected folder going away for good; that folder's cached nodes can
 *  never be reused again either). */
export function clearAutoGraphDocument(key: string): void {
  cache.delete(key);
}

/** Looks up the already-built `ShaderNode` for one recognized object, IF the
 *  cache for `key` still matches `sourceText`'s current content signature
 *  (a stale/never-populated cache is a plain miss, not an error — see this
 *  module's header). Never mutates the cached document/node; the caller
 *  (`graphThis`) inserts the SAME object reference into the real document via
 *  `addPreparedNode`, exactly as a freshly `graphFromRecognizedObject`-built
 *  node would be. */
export function getCachedAutoGraphNode(
  key: string,
  sourceText: string,
  objectName: string,
): ShaderNode | undefined {
  const entry = cache.get(key);
  if (!entry || entry.signature !== autoGraphContentSignature(sourceText)) return undefined;
  const layer = entry.doc.layerStack.layers[0] as ShaderLayer;
  return layer.graph.nodes.find((n) => n.chunkSource?.name === objectName);
}
