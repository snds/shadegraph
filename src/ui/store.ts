// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Editor store
// ───────────────────────────────────────────────────────────────────────────
// The ONLY thing React touches. It holds one `ShaderDocument` (pure data) plus
// transient editor state (selection, last error) and exposes intent-shaped
// actions. Every graph mutation targets the ACTIVE LAYER's graph — there is no
// flattened mega-graph — and every mutation bumps `meta.updated`.
//
// Node *types* are resolved through the `nodes` registry singleton, so the
// store never hard-codes a node's sockets or params. Whoever boots the app is
// responsible for importing the node definitions barrel so the registry is
// populated before `addNode` runs.
// ═══════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';

import {
  emptyDocument,
  type ScalarOrVector,
  type ShaderDocument,
  type ShaderGraph,
  type ShaderLayer,
  type ShaderNode,
} from '../model/document';
import {
  edgesTouchingNodes,
  validateConnection,
  type ConnectionCheck,
  type EndpointRef,
  type SocketTypeLookup,
} from '../model/connect';
import { emptyLayer } from '../model/factory';
import { makeEdgeId, makeNodeId } from '../model/ids';
import { nodes } from '../nodes/registry';
import { moveLayer, type StackDirection } from './layers/reorder';

// ── Selectors (pure, reusable by any pane) ─────────────────────────────────

/** The active layer id, falling back to the bottom layer. */
export function activeLayerId(doc: ShaderDocument): string {
  const { layers, activeLayerId: id } = doc.layerStack;
  if (id && layers.some((l) => l.id === id)) return id;
  return layers[0].id;
}

/** The layer currently being edited. */
export function activeLayer(doc: ShaderDocument): ShaderLayer {
  const id = activeLayerId(doc);
  return doc.layerStack.layers.find((l) => l.id === id) ?? doc.layerStack.layers[0];
}

/** The graph currently being edited. */
export function activeGraph(doc: ShaderDocument): ShaderGraph {
  return activeLayer(doc).graph;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Stamp `meta.updated`. Called by every mutation. */
function touch(doc: ShaderDocument): ShaderDocument {
  return { ...doc, meta: { ...doc.meta, updated: new Date().toISOString() } };
}

/** Replace the active layer's graph immutably. `fn` returns `null` to abort. */
function withActiveGraph(
  doc: ShaderDocument,
  fn: (graph: ShaderGraph) => ShaderGraph | null,
): ShaderDocument | null {
  const id = activeLayerId(doc);
  const index = doc.layerStack.layers.findIndex((l) => l.id === id);
  if (index < 0) return null;
  const layer = doc.layerStack.layers[index];
  const nextGraph = fn(layer.graph);
  if (!nextGraph || nextGraph === layer.graph) return null;
  const layers = doc.layerStack.layers.slice();
  layers[index] = { ...layer, graph: nextGraph };
  return touch({ ...doc, layerStack: { ...doc.layerStack, layers } });
}

/** Socket-type resolution for one graph, via the node registry. */
function socketLookup(graph: ShaderGraph): SocketTypeLookup {
  return (nodeId, socketId, direction) => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;
    const def = nodes.get(node.type);
    if (!def) return undefined;
    const sockets = direction === 'out' ? def.outputs : def.inputs;
    return sockets.find((s) => s.id === socketId)?.type;
  };
}

/** A document with an explicit active layer, so the field is never `undefined`
 *  in a saved file. */
function withActiveLayerSet(doc: ShaderDocument): ShaderDocument {
  return {
    ...doc,
    layerStack: { ...doc.layerStack, activeLayerId: activeLayerId(doc) },
  };
}

// ── Store ──────────────────────────────────────────────────────────────────

/** Layer fields the UI may edit directly. `id` and `graph` are not among them. */
export type LayerPatch = Partial<Omit<ShaderLayer, 'id' | 'graph'>>;

export interface EditorStore {
  /** The one durable artifact. */
  doc: ShaderDocument;
  /** Editor-only: currently selected node ids. */
  selectedNodeIds: string[];
  /** Human-readable reason the last rejected action failed, or `null`. */
  lastError: string | null;

  // Graph
  /** Instantiate a registry node type into the active graph. Returns its id. */
  addNode: (type: string, position: { x: number; y: number }) => string | null;
  removeNodes: (ids: string[]) => void;
  moveNode: (id: string, position: { x: number; y: number }) => void;
  connect: (source: EndpointRef, target: EndpointRef) => ConnectionCheck;
  disconnect: (edgeId: string) => void;
  setParam: (nodeId: string, paramId: string, value: ScalarOrVector | string) => void;
  setParamExposed: (nodeId: string, paramId: string, exposed: boolean) => void;

  // Layers
  setActiveLayer: (id: string) => void;
  addLayer: (name?: string) => string | null;
  removeLayer: (id: string) => void;
  setLayerProp: (id: string, patch: LayerPatch) => void;
  /** Move one layer a single step in SCREEN direction (see `./layers/reorder`).
   *  No-op at either end of the stack. Never touches `selectedNodeIds`. */
  reorderLayer: (id: string, direction: StackDirection) => void;

  // Editor / document
  selectNodes: (ids: string[]) => void;
  loadDocument: (doc: ShaderDocument) => void;
  newDocument: (name?: string) => void;
  /** Rename the whole document. No-op on an empty/unchanged trimmed name.
   *  Never touches `selectedNodeIds`. */
  renameDocument: (name: string) => void;
  clearError: () => void;
}

function initialDocument(name?: string): ShaderDocument {
  return withActiveLayerSet(emptyDocument(name));
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  doc: initialDocument(),
  selectedNodeIds: [],
  lastError: null,

  addNode(type, position) {
    const def = nodes.get(type);
    if (!def) {
      set({ lastError: `Unknown node type "${type}".` });
      return null;
    }
    const node: ShaderNode = {
      id: makeNodeId(type),
      type,
      position: { x: position.x, y: position.y },
      params: def.params ? deepClone(def.params) : [],
      previewEnabled: def.previewable ?? false,
    };
    const doc = withActiveGraph(get().doc, (graph) => ({
      ...graph,
      nodes: [...graph.nodes, node],
    }));
    if (!doc) {
      set({ lastError: 'No active layer to add a node to.' });
      return null;
    }
    set({ doc, lastError: null });
    return node.id;
  },

  removeNodes(ids) {
    if (ids.length === 0) return;
    let blocked = false;
    const doc = withActiveGraph(get().doc, (graph) => {
      // The output node is the graph's result — it can never be deleted.
      const removable = new Set(
        ids.filter((id) => {
          if (id === graph.outputNodeId) {
            blocked = true;
            return false;
          }
          return graph.nodes.some((n) => n.id === id);
        }),
      );
      if (removable.size === 0) return null;
      const doomed = new Set(edgesTouchingNodes(graph, removable).map((e) => e.id));
      return {
        ...graph,
        nodes: graph.nodes.filter((n) => !removable.has(n.id)),
        edges: graph.edges.filter((e) => !doomed.has(e.id)),
      };
    });
    const lastError = blocked ? 'The output node cannot be deleted.' : null;
    if (!doc) {
      set({ lastError });
      return;
    }
    const removed = new Set(ids);
    set({
      doc,
      selectedNodeIds: get().selectedNodeIds.filter((id) => !removed.has(id)),
      lastError,
    });
  },

  moveNode(id, position) {
    const doc = withActiveGraph(get().doc, (graph) => {
      const index = graph.nodes.findIndex((n) => n.id === id);
      if (index < 0) return null;
      const next = graph.nodes.slice();
      next[index] = { ...next[index], position: { x: position.x, y: position.y } };
      return { ...graph, nodes: next };
    });
    if (doc) set({ doc });
  },

  connect(source, target) {
    const graph = activeGraph(get().doc);
    const verdict = validateConnection(graph, source, target, socketLookup(graph));
    if (!verdict.ok) {
      set({ lastError: verdict.message });
      return verdict;
    }
    const edge = {
      id: makeEdgeId(source, target),
      source: { node: source.node, socket: source.socket },
      target: { node: target.node, socket: target.socket },
    };
    const doc = withActiveGraph(get().doc, (g) => ({ ...g, edges: [...g.edges, edge] }));
    if (!doc) {
      const failure: ConnectionCheck = {
        ok: false,
        reason: 'unknown-source',
        message: 'No active layer to connect in.',
      };
      set({ lastError: failure.message });
      return failure;
    }
    set({ doc, lastError: null });
    return verdict;
  },

  disconnect(edgeId) {
    const doc = withActiveGraph(get().doc, (graph) => {
      if (!graph.edges.some((e) => e.id === edgeId)) return null;
      return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
    });
    if (doc) set({ doc, lastError: null });
  },

  setParam(nodeId, paramId, value) {
    const doc = withActiveGraph(get().doc, (graph) => {
      const index = graph.nodes.findIndex((n) => n.id === nodeId);
      if (index < 0) return null;
      const node = graph.nodes[index];
      const paramIndex = node.params.findIndex((p) => p.id === paramId);
      if (paramIndex < 0) return null;
      const params = node.params.slice();
      params[paramIndex] = { ...params[paramIndex], value };
      const nextNodes = graph.nodes.slice();
      nextNodes[index] = { ...node, params };
      return { ...graph, nodes: nextNodes };
    });
    if (doc) set({ doc, lastError: null });
    else set({ lastError: `No param "${paramId}" on node "${nodeId}".` });
  },

  setParamExposed(nodeId, paramId, exposed) {
    const doc = withActiveGraph(get().doc, (graph) => {
      const index = graph.nodes.findIndex((n) => n.id === nodeId);
      if (index < 0) return null;
      const node = graph.nodes[index];
      const paramIndex = node.params.findIndex((p) => p.id === paramId);
      if (paramIndex < 0) return null;
      if ((node.params[paramIndex].exposed ?? false) === exposed) return null;
      const params = node.params.slice();
      params[paramIndex] = { ...params[paramIndex], exposed };
      const nextNodes = graph.nodes.slice();
      nextNodes[index] = { ...node, params };
      return { ...graph, nodes: nextNodes };
    });
    if (doc) set({ doc, lastError: null });
    else set({ lastError: `No param "${paramId}" on node "${nodeId}".` });
  },

  setActiveLayer(id) {
    const doc = get().doc;
    if (!doc.layerStack.layers.some((l) => l.id === id)) {
      set({ lastError: `No layer "${id}".` });
      return;
    }
    if (doc.layerStack.activeLayerId === id) return;
    set({
      doc: touch({ ...doc, layerStack: { ...doc.layerStack, activeLayerId: id } }),
      selectedNodeIds: [],
      lastError: null,
    });
  },

  addLayer(name) {
    const doc = get().doc;
    const layer = emptyLayer(name ?? `Layer ${doc.layerStack.layers.length + 1}`);
    set({
      doc: touch({
        ...doc,
        layerStack: {
          ...doc.layerStack,
          layers: [...doc.layerStack.layers, layer],
          activeLayerId: layer.id,
        },
      }),
      selectedNodeIds: [],
      lastError: null,
    });
    return layer.id;
  },

  removeLayer(id) {
    const doc = get().doc;
    const layers = doc.layerStack.layers;
    if (layers.length <= 1) {
      set({ lastError: 'A document needs at least one layer.' });
      return;
    }
    const index = layers.findIndex((l) => l.id === id);
    if (index < 0) {
      set({ lastError: `No layer "${id}".` });
      return;
    }
    const nextLayers = layers.filter((l) => l.id !== id);
    const wasActive = activeLayerId(doc) === id;
    const fallback = nextLayers[Math.min(index, nextLayers.length - 1)].id;
    set({
      doc: touch({
        ...doc,
        layerStack: {
          ...doc.layerStack,
          layers: nextLayers,
          activeLayerId: wasActive ? fallback : doc.layerStack.activeLayerId,
        },
      }),
      selectedNodeIds: wasActive ? [] : get().selectedNodeIds,
      lastError: null,
    });
  },

  setLayerProp(id, patch) {
    const doc = get().doc;
    const index = doc.layerStack.layers.findIndex((l) => l.id === id);
    if (index < 0) {
      set({ lastError: `No layer "${id}".` });
      return;
    }
    const layers = doc.layerStack.layers.slice();
    layers[index] = { ...layers[index], ...patch, id, graph: layers[index].graph };
    set({
      doc: touch({ ...doc, layerStack: { ...doc.layerStack, layers } }),
      lastError: null,
    });
  },

  reorderLayer(id, direction) {
    const doc = get().doc;
    const layers = moveLayer(doc.layerStack.layers, id, direction);
    if (!layers) return;
    set({
      doc: touch({ ...doc, layerStack: { ...doc.layerStack, layers } }),
      lastError: null,
    });
  },

  selectNodes(ids) {
    set({ selectedNodeIds: [...ids] });
  },

  loadDocument(doc) {
    set({ doc: withActiveLayerSet(doc), selectedNodeIds: [], lastError: null });
  },

  newDocument(name) {
    set({ doc: initialDocument(name), selectedNodeIds: [], lastError: null });
  },

  renameDocument(name) {
    const next = name.trim();
    const doc = get().doc;
    if (!next || next === doc.name) return;
    set({ doc: touch({ ...doc, name: next }), lastError: null });
  },

  clearError() {
    set({ lastError: null });
  },
}));
