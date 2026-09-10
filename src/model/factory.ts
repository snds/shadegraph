// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Document factories
// ───────────────────────────────────────────────────────────────────────────
// Constructors for the pieces `emptyDocument()` builds inline, so the store can
// mint a *second* layer (each with its own graph + output node) without
// duplicating shape knowledge. Pure data; every field is JSON-safe and no key
// is ever set to `undefined` — that would break lossless round-trips.
// ═══════════════════════════════════════════════════════════════════════════

import type { LayerGroup, ShaderGraph, ShaderLayer, StackNode } from './document';
import { makeLayerGroupId, makeLayerId, makeNodeId } from './ids';

/** The node type every graph terminates in. */
export const OUTPUT_NODE_TYPE = 'output.surface';

/** A graph containing nothing but its output node. */
export function emptyGraph(position = { x: 640, y: 200 }): ShaderGraph {
  const outputNodeId = makeNodeId(OUTPUT_NODE_TYPE);
  return {
    nodes: [
      {
        id: outputNodeId,
        type: OUTPUT_NODE_TYPE,
        position: { ...position },
        params: [],
        previewEnabled: true,
      },
    ],
    edges: [],
    outputNodeId,
  };
}

/** The node type every MASK graph terminates in (`ShaderLayer.maskGraph`'s
 *  `outputNodeId`). Same treatment as `OUTPUT_NODE_TYPE` above: a hardcoded
 *  string rather than an import from `nodes/definitions/mask.ts`'s
 *  `OUTPUT_MASK_NODE_TYPE`, so `src/model/` never depends on `src/nodes/`. */
export const OUTPUT_MASK_NODE_TYPE = 'output.mask';

/** A graph containing nothing but its `output.mask` node — the mask
 *  equivalent of `emptyGraph()`, for `ShaderLayer.maskGraph`. */
export function emptyMaskGraph(position = { x: 640, y: 200 }): ShaderGraph {
  const outputNodeId = makeNodeId(OUTPUT_MASK_NODE_TYPE);
  return {
    nodes: [
      {
        id: outputNodeId,
        type: OUTPUT_MASK_NODE_TYPE,
        position: { ...position },
        params: [],
        previewEnabled: true,
      },
    ],
    edges: [],
    outputNodeId,
  };
}

/** A visible, fully-opaque layer wrapping a fresh empty graph. */
export function emptyLayer(name = 'Layer'): ShaderLayer {
  return {
    kind: 'layer',
    id: makeLayerId(),
    name,
    graph: emptyGraph(),
    blend: 'normal',
    opacity: 1,
    enabled: true,
    visible: true,
  };
}

/** A visible, fully-opaque, empty group — the `LayerGroup` equivalent of
 *  `emptyLayer`, for `groupLayers`/tests. `children` defaults to empty; the
 *  store's `groupLayers` action fills it with the wrapped siblings itself. */
export function emptyLayerGroup(name = 'Group', children: StackNode[] = []): LayerGroup {
  return {
    kind: 'group',
    id: makeLayerGroupId(),
    name,
    blend: 'normal',
    opacity: 1,
    enabled: true,
    visible: true,
    children,
  };
}
