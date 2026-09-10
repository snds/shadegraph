// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Preview topology / uniform-naming helpers
// ───────────────────────────────────────────────────────────────────────────
// Pure functions the renderer uses to decide "does this document edit need a
// recompile, or can it be pushed straight to an already-bound uniform?" This
// file touches no GPU handle and no DOM, so it is fully unit-testable and is
// the actual, checkable proof of the contract this task exists for: topology
// changes recompile, param changes never do (`topologySignature` is stable
// across a param/opacity-only edit and changes for everything the task's
// Definition of Done lists — add/remove/connect/disconnect/bypass/reorder/
// target/rig change).
// ═══════════════════════════════════════════════════════════════════════════

import { ident } from '../nodes/definitions/helpers';
import { layerOpacityUniformName } from '../compiler/backends/glsl-es';
import type { ScalarOrVector, ShaderDocument, ShaderGraph, SocketType, StackNode } from '../model/document';
import type { TargetLang } from '../compiler/backend';
import type { ViewerSource } from './scheduler';

export { layerOpacityUniformName };

/** Same naming convention as `paramUniform` in `nodes/definitions/helpers.ts`
 *  (`u_${ident(nodeId)}_${paramId}`) — reusing `ident` directly (rather than a
 *  second regex) guarantees the name the renderer predicts always matches the
 *  name the compiled program actually declared. */
export function paramUniformName(nodeId: string, paramId: string): string {
  return `u_${ident(nodeId)}_${paramId}`;
}

interface StructuralNode {
  id: string;
  type: string;
  bypassed: boolean;
}

interface StructuralGraph {
  outputNodeId: string;
  nodes: StructuralNode[];
  edges: string[];
}

/** A `StackNode`'s structural shape: a leaf layer's own graph, or (for a
 *  group) its `children`, recursively — so nesting/order/blend/mask changes
 *  anywhere in the tree register as a topology change exactly like a leaf
 *  layer's own graph edits do. */
type StructuralStackNode =
  | {
      kind: 'layer';
      id: string;
      blend: string;
      enabled: boolean;
      soloed: boolean;
      maskGraph: StructuralGraph | null;
      outputNodeId: string;
      nodes: StructuralNode[];
      edges: string[];
    }
  | {
      kind: 'group';
      id: string;
      blend: string;
      enabled: boolean;
      soloed: boolean;
      maskGraph: StructuralGraph | null;
      children: StructuralStackNode[];
    };

// Node/edge order inside one graph never changes compiled semantics
// (`resolveOrder` topologically sorts independently) — sorted so a no-op
// array reshuffle can never look like a topology change.
function structuralGraph(graph: ShaderGraph): StructuralGraph {
  return {
    outputNodeId: graph.outputNodeId,
    nodes: graph.nodes
      .map((n) => ({ id: n.id, type: n.type, bypassed: n.bypassed ?? false }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges.map((e) => e.id)].sort(),
  };
}

function structuralStackNode(node: StackNode): StructuralStackNode {
  const maskGraph = node.maskGraph ? structuralGraph(node.maskGraph) : null;
  if (node.kind === 'group') {
    return {
      kind: 'group',
      id: node.id,
      blend: node.blend,
      enabled: node.enabled,
      soloed: node.soloed ?? false,
      maskGraph,
      children: node.children.map(structuralStackNode),
    };
  }
  const graph = structuralGraph(node.graph);
  return {
    kind: 'layer',
    id: node.id,
    blend: node.blend,
    enabled: node.enabled,
    soloed: node.soloed ?? false,
    maskGraph,
    outputNodeId: graph.outputNodeId,
    nodes: graph.nodes,
    edges: graph.edges,
  };
}

/** A JSON fingerprint of everything that changes the COMPILED PROGRAM: graph
 *  topology (nodes/edges/bypass), per-layer compositing shape (blend/enabled/
 *  soloed/mask), layer stack ORDER (compositing is bottom-to-top), the active
 *  backend target, the viewer's compile options (solo node/layer), and the
 *  preview rig (the task's Definition of Done lists rig change as a required
 *  recompile trigger even though this backend's shader source does not
 *  actually depend on it).
 *
 *  Deliberately EXCLUDES: node param values, layer opacity, node position/
 *  collapsed/previewEnabled, and `layerStack.activeLayerId` — none of those
 *  affect the compiled program, so a document whose only edit was one of
 *  those changes produces the identical signature. */
export function topologySignature(
  doc: ShaderDocument,
  target: TargetLang,
  viewerSource: ViewerSource,
): string {
  return JSON.stringify({
    target,
    rig: doc.previewRig,
    viewerSource,
    // Layer stack ORDER is significant (compositing order) — not sorted.
    layers: doc.layerStack.layers.map(structuralStackNode),
  });
}

export interface UniformValueEntry {
  name: string;
  type: SocketType;
  value: ScalarOrVector | string;
}

/** Every value in `doc` that could conceivably be bound to a uniform: one
 *  entry per node param, plus one synthetic entry per stack node's (layer OR
 *  group — a group gets its own opacity uniform too, see `foldStack` in
 *  `src/compiler/backends/glsl-es.ts`) opacity. Used by the renderer to diff
 *  against the last-pushed values on a topology-unchanged edit and push only
 *  what actually changed. Names mirror exactly what the glsl-es backend
 *  declares (see `paramUniformName` / `layerOpacityUniformName`) — whether a
 *  name in here is actually a LIVE uniform in the currently-bound program is
 *  for the caller to check (some params, e.g. `noise.fbm`'s `octaves`, are
 *  baked as GLSL literals instead of uniforms and have no bound location at
 *  all). */
export function collectUniformValues(doc: ShaderDocument): UniformValueEntry[] {
  const entries: UniformValueEntry[] = [];
  const collect = (nodes: StackNode[]) => {
    for (const node of nodes) {
      entries.push({ name: layerOpacityUniformName(node.id), type: 'float', value: node.opacity });
      if (node.kind === 'group') {
        collect(node.children);
        continue;
      }
      for (const graphNode of node.graph.nodes) {
        for (const p of graphNode.params) {
          entries.push({ name: paramUniformName(graphNode.id, p.id), type: p.type, value: p.value });
        }
      }
    }
  };
  collect(doc.layerStack.layers);
  return entries;
}

/** `ScalarOrVector` includes tuple arrays (color/vector params); `===` alone
 *  would treat every edit as "changed" since the store always produces a
 *  fresh array reference. */
export function sameUniformValue(a: ScalarOrVector | string, b: ScalarOrVector | string): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}
