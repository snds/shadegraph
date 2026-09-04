// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Document factories
// ───────────────────────────────────────────────────────────────────────────
// Constructors for the pieces `emptyDocument()` builds inline, so the store can
// mint a *second* layer (each with its own graph + output node) without
// duplicating shape knowledge. Pure data; every field is JSON-safe and no key
// is ever set to `undefined` — that would break lossless round-trips.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShaderGraph, ShaderLayer } from './document';
import { makeLayerId, makeNodeId } from './ids';

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

/** A visible, fully-opaque layer wrapping a fresh empty graph. */
export function emptyLayer(name = 'Layer'): ShaderLayer {
  return {
    id: makeLayerId(),
    name,
    graph: emptyGraph(),
    blend: 'normal',
    opacity: 1,
    enabled: true,
    visible: true,
  };
}
