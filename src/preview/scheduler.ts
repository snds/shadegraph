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
import type { TargetLang } from '../compiler/backend';

export interface ThumbnailRequest {
  nodeId: string;
  /** Render the graph up to this node ("solo") and show its output. */
  size?: number; // px, snapped to pool bucket
  priority?: 'visible' | 'hover' | 'background';
}

/** What the main viewer is currently showing. */
export type ViewerSource =
  | { kind: 'document' } // full composited layer stack (default)
  | { kind: 'node'; nodeId: string } // Nuke-style solo a node
  | { kind: 'layer'; layerId: string }; // isolate one layer

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
