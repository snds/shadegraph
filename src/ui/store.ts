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
import { emptyLayer, emptyMaskGraph } from '../model/factory';
import { makeEdgeId, makeNodeId } from '../model/ids';
import { nodes } from '../nodes/registry';
import { moveLayer, type StackDirection } from './layers/reorder';
import type { PreviewScheduler, ViewerSource } from '../preview/scheduler';
import type { CompiledProgram, TargetLang } from '../compiler/backend';

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

/** `{ kind: 'layer' }` shows the active layer's main graph (the default);
 *  `{ kind: 'mask', layerId }` shows that layer's `maskGraph` instead. Lives
 *  in the store (not the document) — it is view state, same treatment as
 *  `selectedNodeIds`, never serialized. `layerId` is checked against the
 *  active layer on every read (see `activeGraphKind`), so a stale target
 *  (its layer removed, its mask removed, or the active layer switched away
 *  from underneath it) self-heals back to `'layer'` rather than pointing at
 *  nothing. */
export type EditingTarget = { kind: 'layer' } | { kind: 'mask'; layerId: string };

/** Whether the canvas is currently showing the active layer's mask graph or
 *  its main graph. The one place that decides this, so `activeGraph`,
 *  `withActiveGraph` and the UI (breadcrumb, layer-stack mask control) can
 *  never disagree. */
export function activeGraphKind(doc: ShaderDocument, editingTarget: EditingTarget): 'layer' | 'mask' {
  const layer = activeLayer(doc);
  return editingTarget.kind === 'mask' && editingTarget.layerId === layer.id && !!layer.maskGraph
    ? 'mask'
    : 'layer';
}

/** The graph currently being edited: the active layer's main graph, unless
 *  `editingTarget` names its mask (see `activeGraphKind`). `editingTarget`
 *  defaults to the LIVE store value (evaluated per call, not memoized) —
 *  pre-existing single-argument callers (`Inspector.tsx`, the store's own
 *  tests) keep reading `activeGraph(doc)` unmodified and still resolve
 *  against whichever graph the canvas actually has open. Reactive callers
 *  that need a re-render on `editingTarget` changes alone (e.g.
 *  `GraphCanvas.tsx`) should still subscribe to it explicitly and pass it
 *  in, since a default-parameter read does not itself trigger React updates. */
export function activeGraph(
  doc: ShaderDocument,
  editingTarget: EditingTarget = useEditorStore.getState().editingTarget,
): ShaderGraph {
  const layer = activeLayer(doc);
  return activeGraphKind(doc, editingTarget) === 'mask' ? (layer.maskGraph as ShaderGraph) : layer.graph;
}

// ── Internal helpers ───────────────────────────────────────────────────────

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Stamp `meta.updated`. Called by every mutation. */
function touch(doc: ShaderDocument): ShaderDocument {
  return { ...doc, meta: { ...doc.meta, updated: new Date().toISOString() } };
}

/** Replace the currently EDITED graph immutably — the active layer's
 *  `maskGraph` while `editingTarget` names it (per `activeGraphKind`),
 *  otherwise its main `graph`. `fn` returns `null` to abort. */
function withActiveGraph(
  doc: ShaderDocument,
  editingTarget: EditingTarget,
  fn: (graph: ShaderGraph) => ShaderGraph | null,
): ShaderDocument | null {
  const id = activeLayerId(doc);
  const index = doc.layerStack.layers.findIndex((l) => l.id === id);
  if (index < 0) return null;
  const layer = doc.layerStack.layers[index];
  const editingMask = activeGraphKind(doc, editingTarget) === 'mask';
  const currentGraph = editingMask ? (layer.maskGraph as ShaderGraph) : layer.graph;
  const nextGraph = fn(currentGraph);
  if (!nextGraph || nextGraph === currentGraph) return null;
  const layers = doc.layerStack.layers.slice();
  layers[index] = editingMask ? { ...layer, maskGraph: nextGraph } : { ...layer, graph: nextGraph };
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
  /** The one shared preview renderer (`createPreviewRenderer`), set by
   *  `MainViewer` once its canvas mounts and cleared on unmount. `null`
   *  before mount / in tests — `ShaderNodeCard` treats that as "no live
   *  thumbnails yet" rather than crashing. Transient editor state, like
   *  `selectedNodeIds`: never serialized, never touched by save/load. */
  previewRenderer: PreviewScheduler | null;
  setPreviewRenderer: (renderer: PreviewScheduler | null) => void;
  /** What the main viewer is currently showing (full composite, a soloed
   *  node, or a soloed layer). Lives here (not just inside the renderer) so
   *  the code panel can read it reactively and compile the identical slice
   *  for display. `MainViewer` forwards every change to the renderer via
   *  `setViewerSource`. Transient editor state: never serialized. */
  viewerSource: ViewerSource;
  setViewerSource: (src: ViewerSource) => void;
  /** The compile target (backend) the main viewer renders with. `MainViewer`
   *  forwards every change to the renderer via `setTarget`. Transient editor
   *  state, same treatment as `viewerSource`: never serialized. */
  target: TargetLang;
  setTarget: (target: TargetLang) => void;
  /** The SAME `CompiledProgram` the renderer just bound (or attempted to
   *  bind) to the GPU for `viewerSource` — set by `MainViewer`'s `onCompiled`
   *  bridge, never re-derived. Powers the code panel (source + click-to-
   *  source) and per-node diagnostic badges (`ShaderNodeCard`). `null` before
   *  the first compile (e.g. no canvas mounted yet, as in tests). */
  compiledProgram: CompiledProgram | null;
  setCompiledProgram: (program: CompiledProgram | null) => void;

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

  // Masks (a layer's optional secondary graph; see `EditingTarget`)
  /** Which graph `activeGraph`/`GraphCanvas` currently show: the active
   *  layer's main graph, or (while it still applies) one of its masks. See
   *  `EditingTarget` and `activeGraphKind`. */
  editingTarget: EditingTarget;
  /** Give `id` an empty mask graph (a lone `output.mask` node — see
   *  `emptyMaskGraph`) and switch the canvas to editing it. No-op if the
   *  layer already has one; use `enterMaskEditing` to switch to an existing
   *  mask instead. */
  addMaskToLayer: (id: string) => void;
  /** Delete `id`'s mask graph entirely. If it was the one being edited, the
   *  canvas falls back to that layer's main graph. */
  removeMaskFromLayer: (id: string) => void;
  /** Switch the canvas to editing `id`'s mask graph (and make `id` the
   *  active layer, if it was not already). Fails via `lastError` if the
   *  layer has no mask yet — call `addMaskToLayer` first. */
  enterMaskEditing: (layerId: string) => void;
  /** Switch the canvas back to the active layer's main graph. No-op if
   *  already there. */
  exitMaskEditing: () => void;

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
  editingTarget: { kind: 'layer' },
  previewRenderer: null,
  setPreviewRenderer(renderer) {
    set({ previewRenderer: renderer });
  },
  viewerSource: { kind: 'document' },
  setViewerSource(src) {
    set({ viewerSource: src });
  },
  target: 'glsl-es',
  setTarget(target) {
    set({ target });
  },
  compiledProgram: null,
  setCompiledProgram(program) {
    set({ compiledProgram: program });
  },

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
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => ({
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
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => {
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
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => {
      const index = graph.nodes.findIndex((n) => n.id === id);
      if (index < 0) return null;
      const next = graph.nodes.slice();
      next[index] = { ...next[index], position: { x: position.x, y: position.y } };
      return { ...graph, nodes: next };
    });
    if (doc) set({ doc });
  },

  connect(source, target) {
    const graph = activeGraph(get().doc, get().editingTarget);
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
    const doc = withActiveGraph(get().doc, get().editingTarget, (g) => ({ ...g, edges: [...g.edges, edge] }));
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
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => {
      if (!graph.edges.some((e) => e.id === edgeId)) return null;
      return { ...graph, edges: graph.edges.filter((e) => e.id !== edgeId) };
    });
    if (doc) set({ doc, lastError: null });
  },

  setParam(nodeId, paramId, value) {
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => {
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
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => {
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
      // Picking a layer directly means "edit ITS main graph" (see
      // `LayerStack.tsx`'s name button) — never leaves a stale mask target
      // from whichever layer was active before pointed at the wrong layer.
      editingTarget: { kind: 'layer' },
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
      editingTarget: { kind: 'layer' },
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
    const editingTarget = get().editingTarget;
    // A mask target pointing at the deleted layer is now meaningless even if
    // that layer was not the active one (shouldn't normally happen, since
    // entering mask editing also activates its layer, but stay defensive).
    const staleTarget = wasActive || (editingTarget.kind === 'mask' && editingTarget.layerId === id);
    set({
      doc: touch({
        ...doc,
        layerStack: {
          ...doc.layerStack,
          layers: nextLayers,
          activeLayerId: wasActive ? fallback : doc.layerStack.activeLayerId,
        },
      }),
      editingTarget: staleTarget ? { kind: 'layer' } : editingTarget,
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

  addMaskToLayer(id) {
    const doc = get().doc;
    const index = doc.layerStack.layers.findIndex((l) => l.id === id);
    if (index < 0) {
      set({ lastError: `No layer "${id}".` });
      return;
    }
    const layer = doc.layerStack.layers[index];
    if (layer.maskGraph) {
      // Already has one — treat as "go edit it" rather than an error.
      get().enterMaskEditing(id);
      return;
    }
    const layers = doc.layerStack.layers.slice();
    layers[index] = { ...layer, maskGraph: emptyMaskGraph() };
    set({
      doc: touch({
        ...doc,
        layerStack: { ...doc.layerStack, layers, activeLayerId: id },
      }),
      editingTarget: { kind: 'mask', layerId: id },
      selectedNodeIds: [],
      lastError: null,
    });
  },

  removeMaskFromLayer(id) {
    const doc = get().doc;
    const index = doc.layerStack.layers.findIndex((l) => l.id === id);
    if (index < 0) {
      set({ lastError: `No layer "${id}".` });
      return;
    }
    const layer = doc.layerStack.layers[index];
    if (!layer.maskGraph) return;
    const { maskGraph: _removed, ...withoutMask } = layer;
    const layers = doc.layerStack.layers.slice();
    layers[index] = withoutMask;
    const editingTarget = get().editingTarget;
    const wasEditingThisMask = editingTarget.kind === 'mask' && editingTarget.layerId === id;
    set({
      doc: touch({ ...doc, layerStack: { ...doc.layerStack, layers } }),
      editingTarget: wasEditingThisMask ? { kind: 'layer' } : editingTarget,
      selectedNodeIds: wasEditingThisMask ? [] : get().selectedNodeIds,
      lastError: null,
    });
  },

  enterMaskEditing(layerId) {
    const doc = get().doc;
    const layer = doc.layerStack.layers.find((l) => l.id === layerId);
    if (!layer) {
      set({ lastError: `No layer "${layerId}".` });
      return;
    }
    if (!layer.maskGraph) {
      set({ lastError: `Layer "${layer.name}" has no mask yet.` });
      return;
    }
    const alreadyActive = activeLayerId(doc) === layerId;
    set({
      doc: alreadyActive
        ? doc
        : touch({ ...doc, layerStack: { ...doc.layerStack, activeLayerId: layerId } }),
      editingTarget: { kind: 'mask', layerId },
      selectedNodeIds: [],
      lastError: null,
    });
  },

  exitMaskEditing() {
    if (get().editingTarget.kind === 'layer') return;
    set({ editingTarget: { kind: 'layer' }, selectedNodeIds: [], lastError: null });
  },

  selectNodes(ids) {
    set({ selectedNodeIds: [...ids] });
  },

  loadDocument(doc) {
    set({
      doc: withActiveLayerSet(doc),
      editingTarget: { kind: 'layer' },
      selectedNodeIds: [],
      lastError: null,
    });
  },

  newDocument(name) {
    set({
      doc: initialDocument(name),
      editingTarget: { kind: 'layer' },
      selectedNodeIds: [],
      lastError: null,
    });
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
