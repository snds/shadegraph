// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Document ⇄ React Flow projection
// ───────────────────────────────────────────────────────────────────────────
// The seam that keeps React Flow a *view*. Everything here is a pure function
// over `ShaderGraph`, with React Flow referenced by TYPE ONLY, so:
//
//   • the model never learns about the diagram library (AGENTS.md boundary),
//   • these functions are unit-testable in a plain node environment,
//   • swapping React Flow for a canvas renderer later means rewriting this one
//     file, not the store.
//
// Direction of travel:
//   graph → toFlowNodes / toFlowEdges → <ReactFlow nodes edges>
//   <ReactFlow onConnect> → endpointsFrom → store.connect
// ═══════════════════════════════════════════════════════════════════════════

import type { Edge as RFEdge, Node as RFNode } from '@xyflow/react';

import type { ShaderGraph } from '../../model/document';
import type { EndpointRef, SocketTypeLookup } from '../../model/connect';
import { socketColor } from './socketStyle';

/** The single custom React Flow node type. Every shader node renders as one. */
export const SHADER_NODE_TYPE = 'shaderNode';

/** What `ShaderNodeCard` needs to draw itself. Deliberately minimal — sockets
 *  and params are looked up from the registry by `shaderType`, never copied,
 *  so a definition change cannot go stale in the view layer. */
export interface ShaderCardData extends Record<string, unknown> {
  shaderType: string;
  /** User's per-node title override, if any. */
  title?: string;
  /** The graph's result node: it is never deletable. */
  isOutput: boolean;
  bypassed: boolean;
}

export type ShaderFlowNode = RFNode<ShaderCardData, typeof SHADER_NODE_TYPE>;
export type ShaderFlowEdge = RFEdge;

/** Project the active graph's nodes into React Flow nodes. */
export function toFlowNodes(graph: ShaderGraph, selectedNodeIds: Iterable<string>): ShaderFlowNode[] {
  const selected = new Set(selectedNodeIds);
  return graph.nodes.map((node) => {
    const isOutput = node.id === graph.outputNodeId;
    return {
      id: node.id,
      type: SHADER_NODE_TYPE,
      position: { x: node.position.x, y: node.position.y },
      selected: selected.has(node.id),
      // Structural guarantee, not just a store check: React Flow never even
      // proposes deleting the output node, so it cannot cascade-delete the
      // edges feeding it either.
      deletable: !isOutput,
      data: {
        shaderType: node.type,
        title: node.title,
        isOutput,
        bypassed: node.bypassed ?? false,
      },
    };
  });
}

/** Project the active graph's edges into React Flow edges, tinted by the type
 *  flowing through them. `lookup` is optional so tests can skip the registry. */
export function toFlowEdges(
  graph: ShaderGraph,
  selectedEdgeIds: Iterable<string>,
  lookup?: SocketTypeLookup,
): ShaderFlowEdge[] {
  const selected = new Set(selectedEdgeIds);
  return graph.edges.map((edge) => {
    const type = lookup?.(edge.source.node, edge.source.socket, 'out');
    const stroke = socketColor(type);
    return {
      id: edge.id,
      source: edge.source.node,
      sourceHandle: edge.source.socket,
      target: edge.target.node,
      targetHandle: edge.target.socket,
      selected: selected.has(edge.id),
      style: { stroke, strokeWidth: selected.has(edge.id) ? 3 : 2 },
    };
  });
}

/** The shape both `Connection` and `Edge` satisfy, so one helper covers
 *  `onConnect`, `isValidConnection`, and reconnects. */
export interface FlowConnectionLike {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

/** React Flow endpoints → model endpoints. `null` when a handle id is missing,
 *  which the caller must treat as "not a valid connection". */
export function endpointsFrom(
  connection: FlowConnectionLike,
): { source: EndpointRef; target: EndpointRef } | null {
  const { source, target, sourceHandle, targetHandle } = connection;
  if (!source || !target || !sourceHandle || !targetHandle) return null;
  return {
    source: { node: source, socket: sourceHandle },
    target: { node: target, socket: targetHandle },
  };
}
