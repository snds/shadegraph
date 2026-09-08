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
import type { ScalarOrVector, ShaderDocument, SocketType } from '../model/document';
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

interface StructuralLayer {
  id: string;
  blend: string;
  enabled: boolean;
  soloed: boolean;
  maskGraph: StructuralGraph | null;
  outputNodeId: string;
  nodes: StructuralNode[];
  edges: string[];
}

// Node/edge order inside one graph never changes compiled semantics
// (`resolveOrder` topologically sorts independently) — sorted so a no-op
// array reshuffle can never look like a topology change.
function structuralGraph(graph: ShaderDocument['layerStack']['layers'][number]['graph']): StructuralGraph {
  return {
    outputNodeId: graph.outputNodeId,
    nodes: graph.nodes
      .map((n) => ({ id: n.id, type: n.type, bypassed: n.bypassed ?? false }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges.map((e) => e.id)].sort(),
  };
}

function structuralLayer(layer: ShaderDocument['layerStack']['layers'][number]): StructuralLayer {
  const graph = structuralGraph(layer.graph);
  return {
    id: layer.id,
    blend: layer.blend,
    enabled: layer.enabled,
    soloed: layer.soloed ?? false,
    maskGraph: layer.maskGraph ? structuralGraph(layer.maskGraph) : null,
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
    layers: doc.layerStack.layers.map(structuralLayer),
  });
}

export interface UniformValueEntry {
  name: string;
  type: SocketType;
  value: ScalarOrVector | string;
}

/** Every value in `doc` that could conceivably be bound to a uniform: one
 *  entry per node param, plus one synthetic entry per layer's opacity. Used
 *  by the renderer to diff against the last-pushed values on a topology-
 *  unchanged edit and push only what actually changed. Names mirror exactly
 *  what the glsl-es backend declares (see `paramUniformName` /
 *  `layerOpacityUniformName`) — whether a name in here is actually a LIVE
 *  uniform in the currently-bound program is for the caller to check (some
 *  params, e.g. `noise.fbm`'s `octaves`, are baked as GLSL literals instead of
 *  uniforms and have no bound location at all). */
export function collectUniformValues(doc: ShaderDocument): UniformValueEntry[] {
  const entries: UniformValueEntry[] = [];
  for (const layer of doc.layerStack.layers) {
    entries.push({ name: layerOpacityUniformName(layer.id), type: 'float', value: layer.opacity });
    for (const node of layer.graph.nodes) {
      for (const p of node.params) {
        entries.push({ name: paramUniformName(node.id, p.id), type: p.type, value: p.value });
      }
    }
  }
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
