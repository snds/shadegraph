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
  type NodeGroup,
  type ScalarOrVector,
  type ShaderDocument,
  type ShaderGraph,
  type ShaderLayer,
  type ShaderNode,
  type Socket,
  type SocketDirection,
  type SocketType,
  type SubGraph,
} from '../model/document';
import {
  edgesTouchingNodes,
  validateConnection,
  type ConnectionCheck,
  type EndpointRef,
  type SocketTypeLookup,
} from '../model/connect';
import { emptyLayer, emptyMaskGraph } from '../model/factory';
import { makeEdgeId, makeGroupId, makeNodeId, makeSocketId } from '../model/ids';
import {
  extractSubGraph as extractSubGraphModel,
  instantiateSubGraph as instantiateSubGraphModel,
  isSubGraphInstanceNode,
  subGraphInstanceSocket,
} from '../model/subgraph';
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
 *  `{ kind: 'mask', layerId }` shows that layer's `maskGraph` instead;
 *  `{ kind: 'subgraph', subGraphId }` shows that `SubGraph`'s own internal
 *  graph instead — the "dive in" view entered from a subgraph-instance node
 *  (`ShaderNodeCard`'s dive-in affordance), independent of the active layer.
 *  Lives in the store (not the document) — it is view state, same treatment
 *  as `selectedNodeIds`, never serialized. `layerId`/`subGraphId` are checked
 *  against the live document on every read (see `activeGraphKind`), so a
 *  stale target (its layer/mask/subgraph removed, or the active layer
 *  switched away from underneath it) self-heals back to `'layer'` rather
 *  than pointing at nothing. */
export type EditingTarget =
  | { kind: 'layer' }
  | { kind: 'mask'; layerId: string }
  | { kind: 'subgraph'; subGraphId: string };

/** Whether the canvas is currently showing the active layer's mask graph, a
 *  subgraph's own graph, or the active layer's main graph. The one place
 *  that decides this, so `activeGraph`, `withActiveGraph` and the UI
 *  (breadcrumb, layer-stack mask control) can never disagree. */
export function activeGraphKind(doc: ShaderDocument, editingTarget: EditingTarget): 'layer' | 'mask' | 'subgraph' {
  if (editingTarget.kind === 'subgraph') {
    return doc.subGraphs.some((sg) => sg.id === editingTarget.subGraphId) ? 'subgraph' : 'layer';
  }
  const layer = activeLayer(doc);
  return editingTarget.kind === 'mask' && editingTarget.layerId === layer.id && !!layer.maskGraph
    ? 'mask'
    : 'layer';
}

/** The graph currently being edited: the active layer's main graph, unless
 *  `editingTarget` names its mask or a subgraph (see `activeGraphKind`).
 *  `editingTarget` defaults to the LIVE store value (evaluated per call, not
 *  memoized) — pre-existing single-argument callers (`Inspector.tsx`, the
 *  store's own tests) keep reading `activeGraph(doc)` unmodified and still
 *  resolve against whichever graph the canvas actually has open. Reactive
 *  callers that need a re-render on `editingTarget` changes alone (e.g.
 *  `GraphCanvas.tsx`) should still subscribe to it explicitly and pass it
 *  in, since a default-parameter read does not itself trigger React updates. */
export function activeGraph(
  doc: ShaderDocument,
  editingTarget: EditingTarget = useEditorStore.getState().editingTarget,
): ShaderGraph {
  if (editingTarget.kind === 'subgraph') {
    const subGraph = doc.subGraphs.find((sg) => sg.id === editingTarget.subGraphId);
    if (subGraph) return subGraph.graph;
  }
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

/** Replace the currently EDITED graph immutably — a `SubGraph`'s own `graph`
 *  while `editingTarget` names one (mutating `doc.subGraphs`, never
 *  `layerStack`), the active layer's `maskGraph` while it names that instead
 *  (per `activeGraphKind`), otherwise its main `graph`. `fn` returns `null`
 *  to abort. */
function withActiveGraph(
  doc: ShaderDocument,
  editingTarget: EditingTarget,
  fn: (graph: ShaderGraph) => ShaderGraph | null,
): ShaderDocument | null {
  if (editingTarget.kind === 'subgraph') {
    const index = doc.subGraphs.findIndex((sg) => sg.id === editingTarget.subGraphId);
    if (index >= 0) {
      const subGraph = doc.subGraphs[index];
      const nextGraph = fn(subGraph.graph);
      if (!nextGraph || nextGraph === subGraph.graph) return null;
      const subGraphs = doc.subGraphs.slice();
      subGraphs[index] = { ...subGraph, graph: nextGraph };
      return touch({ ...doc, subGraphs });
    }
    // Unknown subGraphId (e.g. self-healing from a stale target) — fall
    // through to the layer/mask path exactly like `activeGraphKind` would.
  }
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

/** Socket-type resolution for one graph, via the node registry — except a
 *  subgraph-instance node, special-cased per the Phase 3 sketch's decision:
 *  its sockets come from `subGraphs` (the referenced `SubGraph.inputs`/
 *  `outputs`) at read time, never the registry. Mirrors
 *  `src/ui/graph/socketLookup.ts`'s `registrySocketLookup`, which the canvas
 *  uses for the same purpose before a connection is committed. */
function socketLookup(graph: ShaderGraph, subGraphs: SubGraph[]): SocketTypeLookup {
  return (nodeId, socketId, direction) => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) return undefined;
    if (isSubGraphInstanceNode(node)) {
      return subGraphInstanceSocket(subGraphs, node, socketId, direction)?.type;
    }
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

/** Minimal `get`/`set` shape the two helpers below need — narrower than
 *  zustand's full `StoreApi`, since neither ever needs the functional-update
 *  overload of `set`. */
type GetEditorState = () => EditorStore;
type SetEditorState = (partial: Partial<EditorStore>) => void;

/** Shared body for `addSubGraphInput`/`addSubGraphOutput`: append a fresh
 *  exposed socket to a `SubGraph`'s interface. Returns the new socket's id,
 *  or `null` (with `lastError`) if `subGraphId` names no `SubGraph`. */
function addSubGraphSocket(
  get: GetEditorState,
  set: SetEditorState,
  subGraphId: string,
  direction: SocketDirection,
  label: string,
  type: SocketType,
): string | null {
  const doc = get().doc;
  const index = doc.subGraphs.findIndex((sg) => sg.id === subGraphId);
  if (index < 0) {
    set({ lastError: `No subgraph "${subGraphId}".` });
    return null;
  }
  const socket: Socket = {
    id: makeSocketId(),
    label: label.trim() || (direction === 'in' ? 'Input' : 'Output'),
    type,
    direction,
  };
  const subGraph = doc.subGraphs[index];
  const nextSubGraph =
    direction === 'in'
      ? { ...subGraph, inputs: [...subGraph.inputs, socket] }
      : { ...subGraph, outputs: [...subGraph.outputs, socket] };
  const subGraphs = doc.subGraphs.slice();
  subGraphs[index] = nextSubGraph;
  set({ doc: touch({ ...doc, subGraphs }), lastError: null });
  return socket.id;
}

/** Shared body for `removeSubGraphInput`/`removeSubGraphOutput`. No-op if
 *  `subGraphId`/`socketId` do not resolve. */
function removeSubGraphSocket(
  get: GetEditorState,
  set: SetEditorState,
  subGraphId: string,
  direction: SocketDirection,
  socketId: string,
): void {
  const doc = get().doc;
  const index = doc.subGraphs.findIndex((sg) => sg.id === subGraphId);
  if (index < 0) return;
  const subGraph = doc.subGraphs[index];
  const list = direction === 'in' ? subGraph.inputs : subGraph.outputs;
  if (!list.some((s) => s.id === socketId)) return;
  const filtered = list.filter((s) => s.id !== socketId);
  const nextSubGraph = direction === 'in' ? { ...subGraph, inputs: filtered } : { ...subGraph, outputs: filtered };
  const subGraphs = doc.subGraphs.slice();
  subGraphs[index] = nextSubGraph;
  set({ doc: touch({ ...doc, subGraphs }), lastError: null });
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
  /** Insert an already fully-constructed `ShaderNode` into the graph
   *  currently being edited, unlike `addNode` (which builds a fresh node
   *  from a registry type's own defaults) — for callers that construct a
   *  node's content themselves, e.g. the asset browser's "graph this"
   *  action (`graphFromRecognizedObject`'s `chunk.raw` node ships its own
   *  `params`/`chunkSource` derived from a recognized shader object, not
   *  the registry's empty defaults). Returns the node's id, or `null` (with
   *  `lastError`) if there is no active graph to add it to. */
  addPreparedNode: (node: ShaderNode) => string | null;
  removeNodes: (ids: string[]) => void;
  moveNode: (id: string, position: { x: number; y: number }) => void;
  connect: (source: EndpointRef, target: EndpointRef) => ConnectionCheck;
  disconnect: (edgeId: string) => void;
  setParam: (nodeId: string, paramId: string, value: ScalarOrVector | string) => void;
  setParamExposed: (nodeId: string, paramId: string, exposed: boolean) => void;

  // Groups / frames (purely organisational — see `NodeGroup` in the model;
  // never read by the compiler)
  /** Frame `nodeIds` (must resolve against the graph currently being edited)
   *  under one new `NodeGroup` at `bounds`, and assign each member's
   *  `groupId`. Returns the new group's id, or `null` (with `lastError`) if
   *  fewer than two of `nodeIds` resolve. */
  createGroup: (nodeIds: string[], bounds: NodeGroup['bounds'], title?: string) => string | null;
  renameGroup: (groupId: string, title: string) => void;
  recolorGroup: (groupId: string, color: string | undefined) => void;
  setGroupBounds: (groupId: string, bounds: NodeGroup['bounds']) => void;
  /** Delete the group and clear `groupId` on any member nodes — the members
   *  themselves are never touched otherwise. */
  removeGroup: (groupId: string) => void;
  /** Assign or clear (`undefined`) one node's `groupId` directly — how
   *  dragging a node into/out of a frame's bounds updates membership.
   *  Silently ignored if `groupId` does not name a group in the current
   *  graph. */
  setNodeGroup: (nodeId: string, groupId: string | undefined) => void;

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

  // Subgraphs (reusable graphs referenced by an instance node — see
  // `SubGraph`, `src/model/subgraph.ts`, and `EditingTarget`'s `'subgraph'`
  // kind). Instance nodes themselves are created by `extractSubGraph` /
  // `instantiateSubGraph`; there is no separate "addNode" path for them since
  // they are not in the `NodeRegistry`.
  /** Move `nodeIds` (+ their internal edges) out of the graph currently being
   *  edited into a new `SubGraph`, auto-detecting exposed inputs/outputs from
   *  edges crossing the selection boundary, and replace the selection with
   *  one instance node (selected afterward). Returns the new instance node's
   *  id, or `null` (with `lastError`) if the selection is empty or includes
   *  the graph's output node — see `extractSubGraph` in `src/model/subgraph.ts`. */
  extractSubGraph: (nodeIds: string[], name?: string) => string | null;
  /** Drop a NEW instance of an existing `SubGraph` into the graph currently
   *  being edited, at `position`. Returns its node id, or `null` (with
   *  `lastError`) if `subGraphId` names no `SubGraph`. */
  instantiateSubGraph: (subGraphId: string, position: { x: number; y: number }) => string | null;
  /** Rename a `SubGraph`. No-op on an empty/unchanged trimmed name. */
  renameSubGraph: (subGraphId: string, name: string) => void;
  /** Append a new exposed input/output socket to a `SubGraph`'s interface —
   *  visible immediately on every instance, since instances read sockets live
   *  (see `subGraphInstanceSocket`). Returns the new socket's id, or `null`
   *  (with `lastError`) if `subGraphId` names no `SubGraph`. */
  addSubGraphInput: (subGraphId: string, label: string, type: SocketType) => string | null;
  addSubGraphOutput: (subGraphId: string, label: string, type: SocketType) => string | null;
  /** Remove one exposed input/output from a `SubGraph`'s interface. No-op if
   *  `subGraphId`/`socketId` do not resolve. Note: this does NOT prune any
   *  edge elsewhere in the document that happened to target that socket on an
   *  instance — a follow-on concern for whoever wires up the compiler-side
   *  inlining, not this task. */
  removeSubGraphInput: (subGraphId: string, socketId: string) => void;
  removeSubGraphOutput: (subGraphId: string, socketId: string) => void;
  /** Switch the canvas to editing `subGraphId`'s own graph ("dive in" —
   *  reuses the mask task's `EditingTarget` switching mechanism, extended to
   *  a third kind, rather than a parallel one). Fails via `lastError` if
   *  `subGraphId` names no `SubGraph`. */
  enterSubGraphEditing: (subGraphId: string) => void;
  /** Switch the canvas back to the active layer's main graph. No-op if
   *  already there. */
  exitSubGraphEditing: () => void;

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

  addPreparedNode(node) {
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
    const doc = get().doc;
    const graph = activeGraph(doc, get().editingTarget);
    const verdict = validateConnection(graph, source, target, socketLookup(graph, doc.subGraphs));
    if (!verdict.ok) {
      set({ lastError: verdict.message });
      return verdict;
    }
    const edge = {
      id: makeEdgeId(source, target),
      source: { node: source.node, socket: source.socket },
      target: { node: target.node, socket: target.socket },
    };
    const nextDoc = withActiveGraph(doc, get().editingTarget, (g) => ({ ...g, edges: [...g.edges, edge] }));
    if (!nextDoc) {
      const failure: ConnectionCheck = {
        ok: false,
        reason: 'unknown-source',
        message: 'No active layer to connect in.',
      };
      set({ lastError: failure.message });
      return failure;
    }
    set({ doc: nextDoc, lastError: null });
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

  createGroup(nodeIds, bounds, title) {
    const newGroup: NodeGroup = {
      id: makeGroupId(),
      title: title?.trim() || 'Group',
      bounds: { ...bounds },
    };
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => {
      const members = new Set(nodeIds.filter((id) => graph.nodes.some((n) => n.id === id)));
      if (members.size < 2) return null;
      return {
        ...graph,
        groups: [...(graph.groups ?? []), newGroup],
        nodes: graph.nodes.map((n) => (members.has(n.id) ? { ...n, groupId: newGroup.id } : n)),
      };
    });
    if (!doc) {
      set({ lastError: 'Select at least two nodes to group.' });
      return null;
    }
    set({ doc, lastError: null });
    return newGroup.id;
  },

  renameGroup(groupId, title) {
    const next = title.trim() || 'Group';
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => {
      const index = (graph.groups ?? []).findIndex((g) => g.id === groupId);
      if (index < 0) return null;
      const groups = graph.groups!.slice();
      if (groups[index].title === next) return null;
      groups[index] = { ...groups[index], title: next };
      return { ...graph, groups };
    });
    if (doc) set({ doc, lastError: null });
    else set({ lastError: `No group "${groupId}".` });
  },

  recolorGroup(groupId, color) {
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => {
      const index = (graph.groups ?? []).findIndex((g) => g.id === groupId);
      if (index < 0) return null;
      const groups = graph.groups!.slice();
      groups[index] = { ...groups[index], color };
      return { ...graph, groups };
    });
    if (doc) set({ doc, lastError: null });
    else set({ lastError: `No group "${groupId}".` });
  },

  setGroupBounds(groupId, bounds) {
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => {
      const index = (graph.groups ?? []).findIndex((g) => g.id === groupId);
      if (index < 0) return null;
      const groups = graph.groups!.slice();
      groups[index] = { ...groups[index], bounds: { ...bounds } };
      return { ...graph, groups };
    });
    if (doc) set({ doc });
  },

  removeGroup(groupId) {
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => {
      if (!(graph.groups ?? []).some((g) => g.id === groupId)) return null;
      return {
        ...graph,
        groups: graph.groups!.filter((g) => g.id !== groupId),
        nodes: graph.nodes.map((n) => (n.groupId === groupId ? { ...n, groupId: undefined } : n)),
      };
    });
    if (doc) set({ doc, lastError: null });
    else set({ lastError: `No group "${groupId}".` });
  },

  setNodeGroup(nodeId, groupId) {
    const doc = withActiveGraph(get().doc, get().editingTarget, (graph) => {
      if (groupId && !(graph.groups ?? []).some((g) => g.id === groupId)) return null;
      const index = graph.nodes.findIndex((n) => n.id === nodeId);
      if (index < 0) return null;
      if (graph.nodes[index].groupId === groupId) return null;
      const nextNodes = graph.nodes.slice();
      nextNodes[index] = { ...nextNodes[index], groupId };
      return { ...graph, nodes: nextNodes };
    });
    if (doc) set({ doc });
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

  extractSubGraph(nodeIds, name) {
    const doc = get().doc;
    const editingTarget = get().editingTarget;
    const graph = activeGraph(doc, editingTarget);
    const result = extractSubGraphModel(graph, nodeIds, name?.trim() || 'Subgraph', socketLookup(graph, doc.subGraphs));
    if (!result.ok) {
      set({ lastError: result.message });
      return null;
    }
    const nextDoc = withActiveGraph(doc, editingTarget, () => result.parentGraph);
    if (!nextDoc) {
      set({ lastError: 'No active graph to extract from.' });
      return null;
    }
    set({
      doc: { ...nextDoc, subGraphs: [...nextDoc.subGraphs, result.subGraph] },
      selectedNodeIds: [result.instanceNodeId],
      lastError: null,
    });
    return result.instanceNodeId;
  },

  instantiateSubGraph(subGraphId, position) {
    const doc = get().doc;
    const subGraph = doc.subGraphs.find((sg) => sg.id === subGraphId);
    if (!subGraph) {
      set({ lastError: `No subgraph "${subGraphId}".` });
      return null;
    }
    const node = instantiateSubGraphModel(subGraph, position);
    const nextDoc = withActiveGraph(doc, get().editingTarget, (graph) => ({
      ...graph,
      nodes: [...graph.nodes, node],
    }));
    if (!nextDoc) {
      set({ lastError: 'No active graph to instantiate into.' });
      return null;
    }
    set({ doc: nextDoc, lastError: null });
    return node.id;
  },

  renameSubGraph(subGraphId, name) {
    const next = name.trim();
    const doc = get().doc;
    const index = doc.subGraphs.findIndex((sg) => sg.id === subGraphId);
    if (index < 0) {
      set({ lastError: `No subgraph "${subGraphId}".` });
      return;
    }
    if (!next || doc.subGraphs[index].name === next) return;
    const subGraphs = doc.subGraphs.slice();
    subGraphs[index] = { ...subGraphs[index], name: next };
    set({ doc: touch({ ...doc, subGraphs }), lastError: null });
  },

  addSubGraphInput(subGraphId, label, type) {
    return addSubGraphSocket(get, set, subGraphId, 'in', label, type);
  },

  addSubGraphOutput(subGraphId, label, type) {
    return addSubGraphSocket(get, set, subGraphId, 'out', label, type);
  },

  removeSubGraphInput(subGraphId, socketId) {
    removeSubGraphSocket(get, set, subGraphId, 'in', socketId);
  },

  removeSubGraphOutput(subGraphId, socketId) {
    removeSubGraphSocket(get, set, subGraphId, 'out', socketId);
  },

  enterSubGraphEditing(subGraphId) {
    const doc = get().doc;
    if (!doc.subGraphs.some((sg) => sg.id === subGraphId)) {
      set({ lastError: `No subgraph "${subGraphId}".` });
      return;
    }
    set({ editingTarget: { kind: 'subgraph', subGraphId }, selectedNodeIds: [], lastError: null });
  },

  exitSubGraphEditing() {
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
