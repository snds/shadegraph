// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Preview Runtime Contract
// ───────────────────────────────────────────────────────────────────────────
// The layer that makes previews an *accurate live representation of the final
// output*: one shared renderer compiles the document with the selected backend
// and renders it, feeding BOTH the main viewer and every per-node thumbnail.
//
// Fidelity: thumbnails and the main viewer run the SAME compiled program on the
// SAME device/rig that the shipping target uses — the graph is the output, not
// an approximation.
//
// Scale: the scheduler is the throttle. Only DIRTY + VISIBLE nodes re-render;
// thumbnails draw into a pooled set of small fixed-size render targets and are
// blitted to each node's <canvas>. Node count never multiplies GPU cost —
// visible-thumbnail count (capped) does. This is what lets large graphs stay
// interactive while every node shows live output.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShaderDocument, PreviewRig } from '../model/document';
import type { CompileOptions, TargetLang } from '../compiler/backend';

export interface ThumbnailRequest {
  nodeId: string;
  /** Render the graph up to this node ("solo") and show its output. */
  size?: number; // px, snapped to pool bucket
  priority?: 'visible' | 'hover' | 'background';
}

/** The Layers-panel counterpart of `ThumbnailRequest`: `id` is a STACK NODE
 *  (a leaf `ShaderLayer` or a `LayerGroup`), not a node inside a graph — see
 *  `CompileOptions.previewLayerId`. Every row in the tree (leaf AND group)
 *  requests one of these for its own live composited-output thumbnail. */
export interface StackThumbnailRequest {
  id: string;
  size?: number;
  priority?: 'visible' | 'hover' | 'background';
}

/** The Assets-panel counterpart of `ThumbnailRequest`/`StackThumbnailRequest`:
 *  `doc` is a caller-built, self-contained THROWAWAY document (see
 *  `src/storage/recognition/autoGraph.ts`'s `buildAutoGraphDocument`) — never
 *  the app's real active document, and never shares node ids with it. `key`
 *  is the caller-assigned cache identity (`AssetBrowserPanel.tsx` uses
 *  `${rootId}::${nodeId}`, mirroring `assetStore.ts`'s own `previewKey`), and
 *  `signature` (`autoGraphContentSignature(sourceText)`) is the ONLY thing
 *  that invalidates an already-rendered entry — scrolling the same row back
 *  into view with an unchanged signature resolves instantly from cache,
 *  never re-compiling/re-rendering. */
export interface AssetThumbnailRequest {
  key: string;
  doc: ShaderDocument;
  signature: string;
  size?: number;
}

/** What the main viewer is currently showing. */
export type ViewerSource =
  | { kind: 'document' } // full composited layer stack (default)
  | { kind: 'node'; nodeId: string } // Nuke-style solo a node
  | { kind: 'layer'; layerId: string }; // isolate one layer

/** Maps a `ViewerSource` to the `CompileOptions` that isolate it. Shared by
 *  `PreviewRenderer` (actually compiling for the GPU) and the code panel
 *  (compiling the identical slice for display), so both always agree on what
 *  "the viewer is currently showing" means — never two divergent mappings. */
export function viewerSourceToCompileOptions(src: ViewerSource): CompileOptions {
  if (src.kind === 'node') return { previewNodeId: src.nodeId };
  if (src.kind === 'layer') return { previewLayerId: src.layerId };
  return {};
}

export interface PreviewScheduler {
  /** Bind/replace the document being previewed. */
  setDocument(doc: ShaderDocument): void;
  /** Switch backend (glsl-es / wgsl / tsl); recompiles + re-renders. */
  setTarget(target: TargetLang): void;
  setRig(rig: PreviewRig): void;

  /** Point the main viewer at the whole composite, a soloed node, or a layer. */
  setViewerSource(src: ViewerSource): void;

  /** Mark a node's output stale (param edit, edge change, upstream change).
   *  The scheduler propagates dirtiness downstream and coalesces re-renders. */
  markDirty(nodeId: string): void;
  /** Whole-document invalidation (target/rig change, layer reorder). */
  markAllDirty(): void;

  /** Report which nodes are currently in the viewport so only those get live
   *  thumbnails (viewport culling drives GPU cost, not node count). */
  setVisibleNodes(nodeIds: string[]): void;

  /** Request a thumbnail; resolves to a texture/canvas the node card draws. */
  requestThumbnail(req: ThumbnailRequest): Promise<ImageBitmap | HTMLCanvasElement>;

  /** The Layers-panel counterpart of `setVisibleNodes`/`requestThumbnail`:
   *  which stack-node (leaf layer or group) rows currently have a live
   *  thumbnail on screen. */
  setVisibleLayers(ids: string[]): void;
  /** Request one stack node's (leaf layer OR group) own composited-output
   *  thumbnail. */
  requestLayerThumbnail(req: StackThumbnailRequest): Promise<ImageBitmap | HTMLCanvasElement>;

  /** The Assets-panel counterpart of `setVisibleNodes`/`setVisibleLayers`:
   *  which connected-folder rows (keyed by `AssetThumbnailRequest.key`)
   *  currently have an auto-graphed thumbnail on screen. */
  setVisibleAssetThumbnails(keys: string[]): void;
  /** Compiles + renders `req.doc` (a throwaway auto-graph document — see
   *  `AssetThumbnailRequest`) through the SAME shared GPU/render-target pool
   *  every other thumbnail uses, cached per `key` and re-rendered only when
   *  `signature` changes. */
  requestAssetThumbnail(req: AssetThumbnailRequest): Promise<ImageBitmap | HTMLCanvasElement>;
  /** Drops a cached asset thumbnail entry (rejecting any still-pending
   *  waiters) — pairs with a row scrolling out of the virtualized viewport
   *  for good (unmount) or its connected folder being disconnected, the
   *  same "release on scroll-out" discipline `assetStore.ts`'s
   *  `releasePreview` already applies to reference-media preview URLs. */
  releaseAssetThumbnail(key: string): void;

  /** Time (ms) budget per frame for thumbnail work; the rest goes to the main
   *  viewer so interaction stays smooth. */
  setThumbnailBudget(msPerFrame: number): void;

  dispose(): void;
}

/** Adaptive quality signals, mirroring the Prism article's approach (GPU tier,
 *  battery, measured FPS) so the tool degrades preview resolution/refresh under
 *  load instead of stalling. */
export interface AdaptiveSignals {
  gpuTier: 0 | 1 | 2 | 3;
  battery?: number; // 0..1, undefined if unknown
  fps: number;
}
