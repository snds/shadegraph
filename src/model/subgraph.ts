// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Subgraph instances
// ───────────────────────────────────────────────────────────────────────────
// Per the Phase 3 sketch's finalized decision: a subgraph-instance node is
// SPECIAL-CASED, not a `NodeRegistry` generalization. `NodeRegistry` /
// `NodeDefinition` stay exactly as-is for every real node type.
//
// THE CONVENTION (stable — the later compiler inlining task depends on it):
//   • `ShaderNode.type === SUBGRAPH_INSTANCE_NODE_TYPE` ("subgraph.instance")
//   • `ShaderNode.subGraphId` names the `SubGraph` (`ShaderDocument.subGraphs`)
//     this node instances.
// Its sockets are NEVER copied onto the node — every reader resolves them
// live from `SubGraph.inputs`/`outputs` (`subGraphInstanceSocket` below), so
// editing the subgraph's interface is instantly visible on every instance,
// with nothing to keep in sync. This is what every `nodes.get(node.type)`
// call site (`ShaderNodeCard`, `Inspector`, `registrySocketLookup`, the
// store's own `socketLookup`, and later `src/compiler/lower.ts`) must branch
// on before falling through to the registry.
//
// Pure data + pure functions, same treatment as `connect.ts`: no React, no
// node registry import (a `SocketTypeLookup` is threaded in instead), so
// `src/model/` never depends on `src/nodes/` or `src/ui/`.
// ═══════════════════════════════════════════════════════════════════════════

import type {
  Edge,
  ShaderGraph,
  ShaderNode,
  Socket,
  SocketDirection,
  SubGraph,
} from './document';
import type { SocketTypeLookup } from './connect';
import { makeEdgeId, makeNodeId, makeSubGraphId } from './ids';

/** The reserved `ShaderNode.type` for a subgraph instance. Never registered
 *  in `NodeRegistry` — see the file header. */
export const SUBGRAPH_INSTANCE_NODE_TYPE = 'subgraph.instance';

export function isSubGraphInstanceNode(node: Pick<ShaderNode, 'type'>): boolean {
  return node.type === SUBGRAPH_INSTANCE_NODE_TYPE;
}

/** Look up one `SubGraph` by id, or `undefined` (unknown id / no id yet).
 *  Every call site treats a miss the same way a registry miss already is
 *  (`ShaderNodeCard`'s "Unknown node" card, a socket lookup returning
 *  `undefined`). */
export function findSubGraph(subGraphs: SubGraph[], id: string | undefined): SubGraph | undefined {
  return id === undefined ? undefined : subGraphs.find((sg) => sg.id === id);
}

/** One socket on a subgraph-instance node, resolved LIVE from the referenced
 *  `SubGraph.inputs`/`outputs` — the special-cased equivalent of a registry
 *  definition's socket list (`NodeDefinition.inputs`/`outputs`). */
export function subGraphInstanceSocket(
  subGraphs: SubGraph[],
  node: Pick<ShaderNode, 'subGraphId'>,
  socketId: string,
  direction: SocketDirection,
): Socket | undefined {
  const subGraph = findSubGraph(subGraphs, node.subGraphId);
  if (!subGraph) return undefined;
  const sockets = direction === 'out' ? subGraph.outputs : subGraph.inputs;
  return sockets.find((s) => s.id === socketId);
}

/** A new instance node referencing `subGraph`, ready to drop into any
 *  `ShaderGraph.nodes` (via `store.instantiateSubGraph`). */
export function instantiateSubGraph(subGraph: SubGraph, position: { x: number; y: number }): ShaderNode {
  return {
    id: makeNodeId(SUBGRAPH_INSTANCE_NODE_TYPE),
    type: SUBGRAPH_INSTANCE_NODE_TYPE,
    subGraphId: subGraph.id,
    position: { ...position },
    params: [],
  };
}

// ── Extraction ──────────────────────────────────────────────────────────────

export type ExtractSubGraphResult =
  | { ok: true; subGraph: SubGraph; parentGraph: ShaderGraph; instanceNodeId: string }
  | { ok: false; message: string };

/** "uv" -> "Uv", "roughness" -> "Roughness" — a readable-enough default label
 *  for an auto-detected exposed socket. Extraction only has the internal
 *  socket's ID to go on: `SocketTypeLookup` resolves types, not labels, and
 *  keeping it that way avoids coupling `src/model/` to the node registry just
 *  for display strings (the user can rename the interface later via the
 *  subgraph interface editor). */
function titleCaseId(id: string): string {
  const spaced = id.replace(/[_-]+/g, ' ').trim();
  return spaced.length === 0 ? id : spaced[0].toUpperCase() + spaced.slice(1);
}

function averagePosition(nodes: ShaderNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 0, y: 0 };
  const sum = nodes.reduce((acc, n) => ({ x: acc.x + n.position.x, y: acc.y + n.position.y }), { x: 0, y: 0 });
  return { x: sum.x / nodes.length, y: sum.y / nodes.length };
}

/**
 * Extract `nodeIds` (+ the edges strictly between them) out of `graph` into a
 * new `SubGraph`, replacing the selection in `graph` with one instance node.
 *
 * Exposed sockets are auto-detected from edges crossing the selection
 * boundary: an outside→inside edge's internal target becomes an exposed
 * INPUT; an inside→outside edge's internal source becomes an exposed OUTPUT.
 * Each exposed socket's `id` is deterministically `${internalNodeId}:${internalSocketId}`
 * (node ids never contain `:`, see `ids.ts`) — a stable, recoverable pointer
 * back to exactly which internal node/socket it came from, which is what a
 * later compiler inlining task will need in order to substitute the
 * instance's real incoming/outgoing edges for the subgraph's own. Every
 * crossing edge in the PARENT graph is rewritten onto the new instance node
 * at that same socket id, so the document's connectivity survives extraction
 * unchanged from the parent's point of view.
 *
 * The graph's own `outputNodeId` can never be selected (mirrors
 * `store.removeNodes`'s rule — extracting it would leave the parent graph
 * without one).
 */
export function extractSubGraph(
  graph: ShaderGraph,
  nodeIds: string[],
  name: string,
  lookup: SocketTypeLookup,
): ExtractSubGraphResult {
  const selected = new Set(nodeIds.filter((id) => graph.nodes.some((n) => n.id === id)));
  if (selected.has(graph.outputNodeId)) {
    return { ok: false, message: 'The graph output node cannot be extracted into a subgraph.' };
  }
  if (selected.size === 0) {
    return { ok: false, message: 'Select at least one node to extract into a subgraph.' };
  }

  const internalNodes = graph.nodes.filter((n) => selected.has(n.id));
  const remainingNodes = graph.nodes.filter((n) => !selected.has(n.id));

  const internalEdges: Edge[] = [];
  const crossingIn: Edge[] = []; // source outside the selection, target inside
  const crossingOut: Edge[] = []; // source inside the selection, target outside
  const externalEdges: Edge[] = [];
  for (const edge of graph.edges) {
    const sourceIn = selected.has(edge.source.node);
    const targetIn = selected.has(edge.target.node);
    if (sourceIn && targetIn) internalEdges.push(edge);
    else if (targetIn) crossingIn.push(edge);
    else if (sourceIn) crossingOut.push(edge);
    else externalEdges.push(edge);
  }

  // Exposed inputs: one per unique internal (node, socket) TARGET crossed
  // into. Inputs are single-slot (`edgeIntoSocket`), so `crossingIn` can never
  // actually contain a duplicate key — the `seen` guard is just defensive.
  const inputs: Socket[] = [];
  const seenInputs = new Set<string>();
  for (const edge of crossingIn) {
    const key = `${edge.target.node}:${edge.target.socket}`;
    if (seenInputs.has(key)) continue;
    const type = lookup(edge.target.node, edge.target.socket, 'in');
    if (!type) continue;
    seenInputs.add(key);
    inputs.push({ id: key, label: titleCaseId(edge.target.socket), type, direction: 'in' });
  }

  // Exposed outputs: one per unique internal (node, socket) SOURCE crossed
  // out of — an output CAN fan out to several external targets, so dedup
  // here is load-bearing, not defensive.
  const outputs: Socket[] = [];
  const seenOutputs = new Set<string>();
  for (const edge of crossingOut) {
    const key = `${edge.source.node}:${edge.source.socket}`;
    if (seenOutputs.has(key)) continue;
    const type = lookup(edge.source.node, edge.source.socket, 'out');
    if (!type) continue;
    seenOutputs.add(key);
    outputs.push({ id: key, label: titleCaseId(edge.source.socket), type, direction: 'out' });
  }

  const instanceNodeId = makeNodeId(SUBGRAPH_INSTANCE_NODE_TYPE);
  const rewritten: Edge[] = [
    ...externalEdges,
    ...crossingIn.map((edge) => ({
      source: edge.source,
      target: { node: instanceNodeId, socket: `${edge.target.node}:${edge.target.socket}` },
    })),
    ...crossingOut.map((edge) => ({
      source: { node: instanceNodeId, socket: `${edge.source.node}:${edge.source.socket}` },
      target: edge.target,
    })),
  ].map((edge) => ({ id: makeEdgeId(edge.source, edge.target), ...edge }));

  const subGraph: SubGraph = {
    id: makeSubGraphId(),
    name: name.trim() || 'Subgraph',
    inputs,
    outputs,
    graph: {
      nodes: internalNodes,
      edges: internalEdges,
      // Placeholder: an extracted subgraph has no single "result" node the
      // way a layer/mask graph does — every exposed OUTPUT is a valid result.
      // Kept non-empty only because `ShaderGraph.outputNodeId` is required by
      // the model's schema; the (separate, later) compiler inlining task is
      // what will give this real meaning, if it ends up needing one at all.
      outputNodeId: internalNodes[internalNodes.length - 1].id,
    },
  };

  const instanceNode: ShaderNode = {
    id: instanceNodeId,
    type: SUBGRAPH_INSTANCE_NODE_TYPE,
    subGraphId: subGraph.id,
    position: averagePosition(internalNodes),
    params: [],
  };

  const parentGraph: ShaderGraph = {
    ...graph,
    nodes: [...remainingNodes, instanceNode],
    edges: rewritten,
  };

  return { ok: true, subGraph, parentGraph, instanceNodeId };
}
