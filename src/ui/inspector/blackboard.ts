// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Blackboard (exposed params) + document summary
// ───────────────────────────────────────────────────────────────────────────
// A param is "exposed" when it should be promoted to a document-level dial:
// the thing that becomes a uniform the host app can drive at runtime (and, for
// Legion, a lab-store entry). The flag lives on the param itself
// (`NodeParam.exposed`), so it round-trips with the document for free.
//
// The panel's Blackboard section is therefore a DERIVED VIEW, recomputed from
// the document rather than mirrored into a second list — nothing to keep in
// sync, and a loaded file shows its dials immediately. `doc.blackboard` holds
// global dials that belong to no node; those are listed alongside.
//
// Pure data in, pure data out: no React, no store, no DOM.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeParam, ShaderDocument } from '../../model/document';
import { flattenLayers, mapLeafLayers } from '../../model/layerTree';

export interface BlackboardEntry {
  /** Stable React key / identity for the row. */
  key: string;
  /** `undefined` for a global dial that lives on `doc.blackboard`. */
  layerId?: string;
  layerName?: string;
  nodeId?: string;
  nodeTitle?: string;
  param: NodeParam;
}

/** Resolves a node type to its registry title. Injected so this stays pure. */
export type TitleLookup = (type: string) => string | undefined;

/**
 * Every dial in the document, in layer order: each node param flagged
 * `exposed`, then the document's own global params.
 */
export function collectExposedParams(doc: ShaderDocument, titleOf?: TitleLookup): BlackboardEntry[] {
  const entries: BlackboardEntry[] = [];
  for (const layer of flattenLayers(doc.layerStack.layers)) {
    for (const node of layer.graph.nodes) {
      for (const param of node.params) {
        if (!param.exposed) continue;
        entries.push({
          key: `${layer.id}:${node.id}:${param.id}`,
          layerId: layer.id,
          layerName: layer.name,
          nodeId: node.id,
          nodeTitle: node.title ?? titleOf?.(node.type) ?? node.type,
          param,
        });
      }
    }
  }
  for (const param of doc.blackboard) {
    entries.push({ key: `doc:${param.id}`, param });
  }
  return entries;
}

/**
 * Flip one param's `exposed` flag, anywhere in the document.
 *
 * Returns a NEW document (structurally shared), or `null` when the param does
 * not exist or already has the requested state — letting the caller skip a
 * pointless store write. Searches every layer, not just the active one, so the
 * blackboard can un-expose a dial belonging to a layer you are not editing.
 */
export function withParamExposed(
  doc: ShaderDocument,
  nodeId: string,
  paramId: string,
  exposed: boolean,
): ShaderDocument | null {
  const layers = mapLeafLayers(doc.layerStack.layers, (layer) => {
    const nodeIndex = layer.graph.nodes.findIndex((n) => n.id === nodeId);
    if (nodeIndex < 0) return layer;
    const node = layer.graph.nodes[nodeIndex];
    const paramIndex = node.params.findIndex((p) => p.id === paramId);
    if (paramIndex < 0) return layer;
    if ((node.params[paramIndex].exposed ?? false) === exposed) return layer;

    const params = node.params.slice();
    params[paramIndex] = { ...params[paramIndex], exposed };
    const nodes = layer.graph.nodes.slice();
    nodes[nodeIndex] = { ...node, params };
    return { ...layer, graph: { ...layer.graph, nodes } };
  });
  if (layers === doc.layerStack.layers) return null;
  return {
    ...doc,
    layerStack: { ...doc.layerStack, layers },
    meta: { ...doc.meta, updated: new Date().toISOString() },
  };
}

// ── Document properties (shown when nothing is selected) ───────────────────

export interface DocumentSummary {
  name: string;
  archetype: string;
  previewRig: string;
  layerCount: number;
  exposedCount: number;
}

export function describeDocument(doc: ShaderDocument): DocumentSummary {
  return {
    name: doc.name,
    archetype: doc.archetype && doc.archetype !== '' ? doc.archetype : '—',
    previewRig: doc.previewRig,
    layerCount: flattenLayers(doc.layerStack.layers).length,
    exposedCount: collectExposedParams(doc).length,
  };
}
