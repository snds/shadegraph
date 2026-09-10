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
  type LayerGroup,
  type NodeGroup,
  type ScalarOrVector,
  type ShaderDocument,
  type ShaderGraph,
  type ShaderLayer,
  type ShaderNode,
  type Socket,
  type SocketDirection,
  type SocketType,
  type StackNode,
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
import { makeEdgeId, makeGroupId, makeLayerGroupId, makeNodeId, makeSocketId } from '../model/ids';
import {
  findLayer,
  findSiblingArray,
  findStackNode,
  firstLayerId,
  flattenLayers,
  insertStackNode,
  isGroupNode,
  isLayerNode,
  moveStackNode as moveStackNodeInTree,
  replaceSiblingArray,
  subtreeIds,
  updateStackNode,
  type StackMoveTarget,
} from '../model/layerTree';
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

/** The active layer id, falling back to the first LEAF layer in stack order
 *  (a group can never be "active" — there is no graph of its own to edit). */
export function activeLayerId(doc: ShaderDocument): string {
  const { layers, activeLayerId: id } = doc.layerStack;
  if (id && findLayer(layers, id)) return id;
  // firstLayerId always resolves: `validateDocument`/every mutation keeps at
  // least one leaf layer somewhere in the tree.
  return firstLayerId(layers) as string;
}

/** The layer currently being edited. */
export function activeLayer(doc: ShaderDocument): ShaderLayer {
  const id = activeLayerId(doc);
  return findLayer(doc.layerStack.layers, id) ?? (flattenLayers(doc.layerStack.layers)[0] as ShaderLayer);
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

/** The `StackNode` (leaf layer OR group) a `{ kind: 'mask' }` target names,
 *  if it still resolves AND still has a `maskGraph` — the shared "is this
 *  mask target still valid" check `activeGraphKind`/`activeGraph`/
 *  `withActiveGraph` all defer to, so mask editing works identically whether
 *  `layerId` names a leaf `ShaderLayer` or a `LayerGroup` (both carry an
 *  optional `maskGraph`, see `document.ts`). Deliberately NOT tied to
 *  `activeLayerId` — a group can never be "the active layer" (it has no main
 *  `graph` of its own), so mask editing must resolve independently of it. */
function maskEditingNode(
  doc: ShaderDocument,
  editingTarget: EditingTarget,
): (ShaderLayer | LayerGroup) | undefined {
  if (editingTarget.kind !== 'mask') return undefined;
  const node = findStackNode(doc.layerStack.layers, editingTarget.layerId);
  return node?.maskGraph ? node : undefined;
}

/** Whether the canvas is currently showing a mask graph, a subgraph's own
 *  graph, or the active layer's main graph. The one place that decides this,
 *  so `activeGraph`, `withActiveGraph` and the UI (breadcrumb, layer-stack
 *  mask control) can never disagree. */
export function activeGraphKind(doc: ShaderDocument, editingTarget: EditingTarget): 'layer' | 'mask' | 'subgraph' {
  if (editingTarget.kind === 'subgraph') {
    return doc.subGraphs.some((sg) => sg.id === editingTarget.subGraphId) ? 'subgraph' : 'layer';
  }
  return maskEditingNode(doc, editingTarget) ? 'mask' : 'layer';
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
  const maskNode = maskEditingNode(doc, editingTarget);
  if (maskNode) return maskNode.maskGraph as ShaderGraph;
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

/** Replace the currently EDITED graph immutably — a `SubGraph`'s own `graph`
 *  while `editingTarget` names one (mutating `doc.subGraphs`, never
 *  `layerStack`), a leaf layer's OR group's `maskGraph` while it names that
 *  instead (per `maskEditingNode`/`activeGraphKind`), otherwise the active
 *  layer's main `graph`. `fn` returns `null` to abort. */
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
  const maskNode = maskEditingNode(doc, editingTarget);
  const id = maskNode ? maskNode.id : activeLayerId(doc);
  const currentGraph = maskNode ? (maskNode.maskGraph as ShaderGraph) : activeLayer(doc).graph;
  if (!maskNode && !findLayer(doc.layerStack.layers, id)) return null;
  const nextGraph = fn(currentGraph);
  if (!nextGraph || nextGraph === currentGraph) return null;
  const { nodes: layers } = updateStackNode(doc.layerStack.layers, id, (node) =>
    maskNode ? { ...node, maskGraph: nextGraph } : { ...(node as ShaderLayer), graph: nextGraph },
  );
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

/** Layer fields the UI may edit directly. `id`, `graph`, and the `kind`
 *  discriminant are not among them — `setLayerProp` also applies this same
 *  patch shape to a `LayerGroup` (every other field here doubles as a valid
 *  group field too), so `kind` must never be spreadable. */
export type LayerPatch = Partial<Omit<ShaderLayer, 'id' | 'graph' | 'kind'>>;

export interface EditorStore {
  /** The one durable artifact. */
  doc: ShaderDocument;
  /** Editor-only: currently selected node ids. */
  selectedNodeIds: string[];
  /** Editor-only: currently selected LAYER/GROUP ids in the Layers panel —
   *  a `StackNode` id, either a leaf `ShaderLayer` or a `LayerGroup` (unlike
   *  `activeLayerId`, which can only ever name a leaf). Distinct from
   *  `selectedNodeIds` (canvas node selection inside a graph) so the two
   *  panels' selections never collide; the Inspector (`Inspector.tsx`) keys
   *  its "layer controls" section off this, falling back to whichever ids
   *  still resolve (`findStackNode`) if a selected layer/group was since
   *  deleted elsewhere. Multiple entries only matter to the Layers panel's
   *  own multi-select-then-Group action — the Inspector only renders
   *  controls for a single resolved selection. */
  selectedLayerIds: string[];
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
  /** Adds a new leaf layer. Named `opts.insertBeneath` (a `StackNode` id,
   *  leaf or group) places it directly BELOW that node in its own sibling
   *  array (screen order — see `insertStackNode`); omitted or unresolved
   *  falls back to appending at the document root's end, the original
   *  simpler default every pre-existing caller still gets unchanged. The
   *  Layers panel passes its current `selectedLayerIds` primary selection
   *  here; every other caller (tests, etc.) is unaffected. */
  addLayer: (name?: string, opts?: { insertBeneath?: string }) => string | null;
  /** The group counterpart of `addLayer`: an empty new `LayerGroup` (no
   *  children yet — drag leaves into it, or use `groupLayers` to wrap an
   *  existing multi-selection instead of starting empty). Same
   *  `opts.insertBeneath` placement contract as `addLayer`. */
  addGroup: (name?: string, opts?: { insertBeneath?: string }) => string | null;
  removeLayer: (id: string) => void;
  setLayerProp: (id: string, patch: LayerPatch) => void;
  /** Move one layer a single step in SCREEN direction (see `./layers/reorder`),
   *  within whichever sibling array it actually lives in (the document root,
   *  or its parent group's `children`) — a reorder never crosses a group
   *  boundary. No-op at either end of that sibling array. Never touches
   *  `selectedNodeIds`. */
  reorderLayer: (id: string, direction: StackDirection) => void;
  /** Drag-and-drop's general repositioning primitive: splices `id` to an
   *  arbitrary destination anywhere in the tree (`StackMoveTarget` —
   *  before/after a sibling in ARRAY order, or appended into a group),
   *  unlike `reorderLayer`'s single same-array step. The Layers panel is the
   *  only caller; see `src/ui/layers/reorder.ts`'s `screenDropTarget` for the
   *  SCREEN-order → this ARRAY-order translation. No-op (with `lastError`)
   *  for every rejection `moveStackNode` (the model helper) reports — unknown
   *  id, dropping a group inside itself/its own descendant, unknown `refId`. */
  moveStackNode: (id: string, target: StackMoveTarget) => void;
  /** Wrap `ids` (must all be SIBLINGS — resolve to the same parent array,
   *  root or another group's `children`) in one new `LayerGroup`, preserving
   *  their relative stack order and inserting the group at the position of
   *  the earliest-indexed member. Returns the new group's id, or `null` (with
   *  `lastError`) if `ids` is empty or its members are not all siblings.
   *  Selects the new group afterward (`selectedLayerIds`). */
  groupLayers: (ids: string[]) => string | null;
  /** Splice `groupId`'s `children` back into its parent at the group's former
   *  position, then delete the now-empty group — the inverse of `groupLayers`
   *  for a contiguous selection. No-op (with `lastError`) if `groupId` does
   *  not name a group anywhere in the tree. If the group was selected, its
   *  former children replace it in `selectedLayerIds`. */
  ungroupLayer: (groupId: string) => void;

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
  /** Replace the Layers panel's selection (`selectedLayerIds`) — layer AND
   *  group ids both valid, any mix. Clears `selectedNodeIds`: a canvas-node
   *  selection and a layer-tree selection are mutually exclusive in the
   *  Inspector, same convention `selectNodes` uses in the other direction. */
  selectLayers: (ids: string[]) => void;
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
  selectedLayerIds: [],
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
    if (!findLayer(doc.layerStack.layers, id)) {
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

  addLayer(name, opts) {
    const doc = get().doc;
    const layer = emptyLayer(name ?? `Layer ${flattenLayers(doc.layerStack.layers).length + 1}`);
    const layers = insertStackNode(doc.layerStack.layers, layer, opts?.insertBeneath);
    set({
      doc: touch({
        ...doc,
        layerStack: { ...doc.layerStack, layers, activeLayerId: layer.id },
      }),
      editingTarget: { kind: 'layer' },
      selectedNodeIds: [],
      selectedLayerIds: [layer.id],
      lastError: null,
    });
    return layer.id;
  },

  addGroup(name, opts) {
    const doc = get().doc;
    const group: LayerGroup = {
      kind: 'group',
      id: makeLayerGroupId(),
      name: name?.trim() || 'Group',
      blend: 'normal',
      opacity: 1,
      enabled: true,
      visible: true,
      children: [],
    };
    const layers = insertStackNode(doc.layerStack.layers, group, opts?.insertBeneath);
    set({
      doc: touch({ ...doc, layerStack: { ...doc.layerStack, layers } }),
      selectedNodeIds: [],
      selectedLayerIds: [group.id],
      lastError: null,
    });
    return group.id;
  },

  removeLayer(id) {
    const doc = get().doc;
    const layers = doc.layerStack.layers;
    const siblingInfo = findSiblingArray(layers, id);
    if (!siblingInfo) {
      set({ lastError: `No layer "${id}".` });
      return;
    }
    // Removing a group takes its whole subtree with it — count every LEAF
    // inside it (1 for a plain layer), and refuse if that would empty the
    // document of layers entirely.
    const target = siblingInfo.siblings[siblingInfo.index];
    const removedLeaves = flattenLayers([target]);
    const totalLeaves = flattenLayers(layers).length;
    if (totalLeaves - removedLeaves.length < 1) {
      set({ lastError: 'A document needs at least one layer.' });
      return;
    }
    const removedLeafIds = new Set(removedLeaves.map((l) => l.id));
    // Every id that disappears with this removal — the target itself, plus
    // every nested group inside it, not just its leaves — is what
    // `selectedLayerIds` must drop (a leaf-only check would leave a removed
    // GROUP's own id dangling in the selection).
    const removedIds = subtreeIds(target);
    const currentActiveId = activeLayerId(doc);
    const wasActive = removedLeafIds.has(currentActiveId);
    const { nodes: nextLayers } = updateStackNode(layers, id, () => null);
    let fallback: string | undefined;
    if (wasActive) {
      const remainingSiblings = siblingInfo.siblings.filter((n) => n.id !== id);
      const fallbackNode = remainingSiblings[Math.min(siblingInfo.index, remainingSiblings.length - 1)];
      if (fallbackNode) fallback = firstLayerId([fallbackNode]);
      fallback = fallback ?? firstLayerId(nextLayers);
    }
    const editingTarget = get().editingTarget;
    // A mask target pointing at a layer OR GROUP inside the removed subtree
    // (`removedIds`, not the leaf-only `removedLeafIds` — a group's own
    // `maskGraph` can be the thing being edited) is now meaningless even if
    // that node was not the active leaf layer (shouldn't normally happen for
    // a leaf, since entering mask editing also activates its layer, but stay
    // defensive; a group is never "active" at all, so this is the ONLY check
    // that catches removing a group mid-edit of its mask).
    const staleTarget = wasActive || (editingTarget.kind === 'mask' && removedIds.has(editingTarget.layerId));
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
      selectedLayerIds: get().selectedLayerIds.filter((sid) => !removedIds.has(sid)),
      lastError: null,
    });
  },

  setLayerProp(id, patch) {
    const doc = get().doc;
    const { nodes: layers, changed } = updateStackNode(doc.layerStack.layers, id, (node) => ({
      ...node,
      ...patch,
      id: node.id,
    }));
    if (!changed) {
      set({ lastError: `No layer "${id}".` });
      return;
    }
    set({
      doc: touch({ ...doc, layerStack: { ...doc.layerStack, layers } }),
      lastError: null,
    });
  },

  reorderLayer(id, direction) {
    const doc = get().doc;
    const info = findSiblingArray(doc.layerStack.layers, id);
    if (!info) {
      set({ lastError: `No layer "${id}".` });
      return;
    }
    const moved = moveLayer(info.siblings, id, direction);
    if (!moved) return;
    const layers = replaceSiblingArray(doc.layerStack.layers, id, moved);
    set({
      doc: touch({ ...doc, layerStack: { ...doc.layerStack, layers } }),
      lastError: null,
    });
  },

  moveStackNode(id, target) {
    const doc = get().doc;
    const result = moveStackNodeInTree(doc.layerStack.layers, id, target);
    if (result.error) {
      set({ lastError: result.error });
      return;
    }
    set({
      doc: touch({ ...doc, layerStack: { ...doc.layerStack, layers: result.nodes } }),
      lastError: null,
    });
  },

  groupLayers(ids) {
    if (ids.length === 0) {
      set({ lastError: 'Select at least one layer to group.' });
      return null;
    }
    const doc = get().doc;
    const info = findSiblingArray(doc.layerStack.layers, ids[0]);
    if (!info) {
      set({ lastError: `No layer "${ids[0]}".` });
      return null;
    }
    const idSet = new Set(ids);
    const members = info.siblings.filter((n) => idSet.has(n.id));
    if (members.length !== ids.length) {
      set({ lastError: 'All selected layers must be siblings in the same group.' });
      return null;
    }
    const firstIndex = info.siblings.findIndex((n) => idSet.has(n.id));
    const remaining = info.siblings.filter((n) => !idSet.has(n.id));
    const insertAt = info.siblings.slice(0, firstIndex).filter((n) => !idSet.has(n.id)).length;
    const newGroup: LayerGroup = {
      kind: 'group',
      id: makeLayerGroupId(),
      name: 'Group',
      blend: 'normal',
      opacity: 1,
      enabled: true,
      visible: true,
      children: members,
    };
    const nextSiblings = [...remaining.slice(0, insertAt), newGroup, ...remaining.slice(insertAt)];
    const layers = replaceSiblingArray(doc.layerStack.layers, ids[0], nextSiblings);
    set({
      doc: touch({ ...doc, layerStack: { ...doc.layerStack, layers } }),
      selectedNodeIds: [],
      selectedLayerIds: [newGroup.id],
      lastError: null,
    });
    return newGroup.id;
  },

  ungroupLayer(groupId) {
    const doc = get().doc;
    const info = findSiblingArray(doc.layerStack.layers, groupId);
    if (!info) {
      set({ lastError: `No group "${groupId}".` });
      return;
    }
    const node = info.siblings[info.index];
    if (!isGroupNode(node)) {
      set({ lastError: `"${groupId}" is not a group.` });
      return;
    }
    const nextSiblings = [
      ...info.siblings.slice(0, info.index),
      ...node.children,
      ...info.siblings.slice(info.index + 1),
    ];
    const layers = replaceSiblingArray(doc.layerStack.layers, groupId, nextSiblings);
    const wasSelected = get().selectedLayerIds.includes(groupId);
    set({
      doc: touch({ ...doc, layerStack: { ...doc.layerStack, layers } }),
      selectedLayerIds: wasSelected
        ? [...get().selectedLayerIds.filter((sid) => sid !== groupId), ...node.children.map((c) => c.id)]
        : get().selectedLayerIds,
      lastError: null,
    });
  },

  addMaskToLayer(id) {
    const doc = get().doc;
    // Resolves a leaf `ShaderLayer` OR a `LayerGroup` (`findStackNode`, not
    // the leaf-only `findLayer`) — both carry an optional `maskGraph`
    // (`document.ts`), and the Inspector's "+ mask" control targets either.
    const node = findStackNode(doc.layerStack.layers, id);
    if (!node) {
      set({ lastError: `No layer "${id}".` });
      return;
    }
    if (node.maskGraph) {
      // Already has one — treat as "go edit it" rather than an error.
      get().enterMaskEditing(id);
      return;
    }
    const { nodes: layers } = updateStackNode(doc.layerStack.layers, id, (n) => ({
      ...n,
      maskGraph: emptyMaskGraph(),
    }));
    set({
      doc: touch({
        ...doc,
        layerStack: {
          ...doc.layerStack,
          layers,
          // A group can never be "the active layer" (`activeLayerId`'s own
          // contract) — only steer it there for a leaf layer.
          activeLayerId: isLayerNode(node) ? id : doc.layerStack.activeLayerId,
        },
      }),
      editingTarget: { kind: 'mask', layerId: id },
      selectedNodeIds: [],
      lastError: null,
    });
  },

  removeMaskFromLayer(id) {
    const doc = get().doc;
    const node = findStackNode(doc.layerStack.layers, id);
    if (!node) {
      set({ lastError: `No layer "${id}".` });
      return;
    }
    if (!node.maskGraph) return;
    const { nodes: layers } = updateStackNode(doc.layerStack.layers, id, (n) => {
      const { maskGraph: _removed, ...withoutMask } = n;
      return withoutMask as StackNode;
    });
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
    const node = findStackNode(doc.layerStack.layers, layerId);
    if (!node) {
      set({ lastError: `No layer "${layerId}".` });
      return;
    }
    if (!node.maskGraph) {
      set({ lastError: `Layer "${node.name}" has no mask yet.` });
      return;
    }
    // Only a leaf layer can be "the active layer" — entering a group's mask
    // leaves `activeLayerId` (and therefore the main-graph canvas beneath the
    // mask breadcrumb) exactly as it was.
    const alreadyActive = !isLayerNode(node) || activeLayerId(doc) === layerId;
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
    set({ selectedNodeIds: [...ids], selectedLayerIds: [] });
  },

  selectLayers(ids) {
    // Drop ids that resolve to neither a layer nor a group — same "never
    // point at nothing" discipline `editingTarget` uses, so the Inspector
    // never has to guess whether a ghost id means "empty selection".
    const layers = get().doc.layerStack.layers;
    const resolved = ids.filter((id) => !!findStackNode(layers, id));
    set({ selectedLayerIds: resolved, selectedNodeIds: [] });
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
