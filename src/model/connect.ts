// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Connection validation
// ───────────────────────────────────────────────────────────────────────────
// The editor-side gate that keeps a ShaderDocument structurally valid: sockets
// are type-checked against `SOCKET_COMPATIBILITY`, an input socket takes at
// most one edge, and the graph stays a DAG. Pure data in, verdict out — no
// registry, no React, no DOM. Callers supply a `SocketTypeLookup` so the model
// never has to know about the node registry.
// ═══════════════════════════════════════════════════════════════════════════

import {
  SOCKET_COMPATIBILITY,
  type Edge,
  type ShaderGraph,
  type SocketDirection,
  type SocketType,
} from './document';

/** Can a `sourceType` output feed a `targetType` input? */
export function canConnect(sourceType: SocketType, targetType: SocketType): boolean {
  return SOCKET_COMPATIBILITY[sourceType]?.includes(targetType) ?? false;
}

/** One end of a prospective link. */
export interface EndpointRef {
  node: string;
  socket: string;
}

/** Resolves the declared type of a socket. The store implements this over the
 *  node registry; tests can pass a literal map. */
export type SocketTypeLookup = (
  nodeId: string,
  socketId: string,
  direction: SocketDirection,
) => SocketType | undefined;

export type ConnectionRejection =
  | 'unknown-source'
  | 'unknown-target'
  | 'unknown-source-socket'
  | 'unknown-target-socket'
  | 'same-node'
  | 'type-mismatch'
  | 'target-occupied'
  | 'duplicate-edge'
  | 'cycle';

export type ConnectionCheck =
  | { ok: true }
  | { ok: false; reason: ConnectionRejection; message: string };

const reject = (reason: ConnectionRejection, message: string): ConnectionCheck => ({
  ok: false,
  reason,
  message,
});

/** The edge already feeding `nodeId.socketId`, if any. Inputs are single-slot. */
export function edgeIntoSocket(
  graph: ShaderGraph,
  nodeId: string,
  socketId: string,
): Edge | undefined {
  return graph.edges.find((e) => e.target.node === nodeId && e.target.socket === socketId);
}

/** Every edge with either endpoint on one of `nodeIds`. */
export function edgesTouchingNodes(graph: ShaderGraph, nodeIds: Iterable<string>): Edge[] {
  const ids = new Set(nodeIds);
  return graph.edges.filter((e) => ids.has(e.source.node) || ids.has(e.target.node));
}

/** Would linking `fromNode → toNode` close a loop? Walks forward from `toNode`
 *  looking for `fromNode`. */
export function wouldCreateCycle(graph: ShaderGraph, fromNode: string, toNode: string): boolean {
  if (fromNode === toNode) return true;
  const seen = new Set<string>();
  const stack = [toNode];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === fromNode) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const e of graph.edges) {
      if (e.source.node === current) stack.push(e.target.node);
    }
  }
  return false;
}

/**
 * Full connect-time validation. Returns `{ ok: true }` or a typed rejection the
 * UI can surface verbatim.
 */
export function validateConnection(
  graph: ShaderGraph,
  source: EndpointRef,
  target: EndpointRef,
  lookup: SocketTypeLookup,
): ConnectionCheck {
  if (source.node === target.node) {
    return reject('same-node', 'A node cannot connect to itself.');
  }

  const sourceNode = graph.nodes.find((n) => n.id === source.node);
  if (!sourceNode) return reject('unknown-source', `No node "${source.node}" in this graph.`);
  const targetNode = graph.nodes.find((n) => n.id === target.node);
  if (!targetNode) return reject('unknown-target', `No node "${target.node}" in this graph.`);

  const sourceType = lookup(source.node, source.socket, 'out');
  if (!sourceType) {
    return reject('unknown-source-socket', `No output socket "${source.socket}" on this node.`);
  }
  const targetType = lookup(target.node, target.socket, 'in');
  if (!targetType) {
    return reject('unknown-target-socket', `No input socket "${target.socket}" on this node.`);
  }

  if (!canConnect(sourceType, targetType)) {
    return reject('type-mismatch', `Cannot connect ${sourceType} to ${targetType}.`);
  }

  const existing = edgeIntoSocket(graph, target.node, target.socket);
  if (existing) {
    const duplicate =
      existing.source.node === source.node && existing.source.socket === source.socket;
    return duplicate
      ? reject('duplicate-edge', 'That connection already exists.')
      : reject('target-occupied', 'That input already has a connection.');
  }

  if (wouldCreateCycle(graph, source.node, target.node)) {
    return reject('cycle', 'That connection would create a cycle.');
  }

  return { ok: true };
}
