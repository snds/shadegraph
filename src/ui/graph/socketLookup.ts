// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Registry-backed socket lookup for the canvas
// ───────────────────────────────────────────────────────────────────────────
// `validateConnection` in `src/model/connect.ts` is the ONE authority on which
// links are legal; it just needs someone to tell it a socket's declared type.
// The store already does this internally for committed connections. The canvas
// needs the same resolution *before* committing, to answer React Flow's
// `isValidConnection` while a link is being dragged.
//
// This is plumbing (graph node → registry definition → socket type), not
// compatibility logic — SOCKET_COMPATIBILITY is never re-implemented here.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShaderGraph } from '../../model/document';
import type { SocketTypeLookup } from '../../model/connect';
import { nodes } from '../../nodes/registry';

/** A `SocketTypeLookup` bound to one graph, resolving through the node registry. */
export function registrySocketLookup(graph: ShaderGraph): SocketTypeLookup {
  return (nodeId, socketId, direction) => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;
    const def = nodes.get(node.type);
    if (!def) return undefined;
    const sockets = direction === 'out' ? def.outputs : def.inputs;
    return sockets.find((s) => s.id === socketId)?.type;
  };
}
