// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Node graph canvas
// ───────────────────────────────────────────────────────────────────────────
// React Flow bound to the editor store, editing whichever graph the store's
// `editingTarget` currently names — the active layer's main graph, or (while
// dived into one) its mask graph, via `activeGraph`/`activeGraphKind`. When
// showing a mask, a breadcrumb (`GraphBreadcrumb`) offers a one-click way
// back. The canvas holds no graph state of its own: `nodes`/`edges` are
// projected from the document on every render, and every gesture is
// translated back into a store action. The exceptions are edge *selection*
// and group/frame *selection*, view-only state the document has no field for.
//
// Connection legality is never decided here. `isValidConnection` and the
// post-drop message both call the model's `validateConnection`, so the canvas
// and the store can never disagree about what is legal, and the user sees the
// model's own reason ("Cannot connect vec2 to float.") rather than a guess.
//
// Groups/frames (`NodeGroup`) are a SECOND React Flow node type
// (`GROUP_NODE_TYPE`, id-namespaced via `frameNodeId` so it can never collide
// with a `ShaderNode` id — see `project.ts`) merged into the same `nodes`
// array ahead of the shader nodes, so with no explicit `zIndex` on either
// type React Flow's array-order stacking renders them behind their members.
// `onNodesChange` demultiplexes by id: frame changes update `NodeGroup`
// bounds/selection/removal, shader-node changes behave exactly as before,
// and a shader node's drag-end additionally re-tests its center point against
// every frame's bounds (`groupContaining`) to update its `groupId`.
// ═══════════════════════════════════════════════════════════════════════════

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type NodeTypes,
  type OnConnect,
  type OnConnectEnd,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { validateConnection } from '../../model/connect';
import { activeGraph, activeGraphKind, activeLayer, activeLayerId, useEditorStore } from '../store';
import { notify } from '../notice';
import { AddNodePalette } from './AddNodePalette';
import { boundsForNodes, groupContaining, FALLBACK_NODE_SIZE, type NodeRect } from './groupBounds';
import { GraphBreadcrumb } from './GraphBreadcrumb';
import { GroupFrameNode } from './GroupFrameNode';
import { cascadeOffset } from './paletteCascade';
import { ShaderNodeCard } from './ShaderNodeCard';
import { SocketLegend } from './SocketLegend';
import { registrySocketLookup } from './socketLookup';
import {
  endpointsFrom,
  findGroup,
  GROUP_NODE_TYPE,
  groupIdFromFrameNodeId,
  SHADER_NODE_TYPE,
  toFlowEdges,
  toFlowGroups,
  toFlowNodes,
  type GroupFlowNode,
  type ShaderFlowEdge,
  type ShaderFlowNode,
} from './project';

/** Stable across renders — React Flow warns (and remounts nodes) otherwise. */
const nodeTypes: NodeTypes = { [SHADER_NODE_TYPE]: ShaderNodeCard, [GROUP_NODE_TYPE]: GroupFrameNode };

/** Shared by the initial fit and the Controls button, so both frame the graph
 *  the same way. Without the zoom cap, a fresh document's single output node
 *  fills the entire canvas. */
const FIT_VIEW = { maxZoom: 1, padding: 0.25 };

/** A partial update to a `NodeGroup`'s bounds, as gathered from a frame's
 *  `position`/`dimensions` NodeChanges in `onNodesChange` below. */
export interface GroupBoundsPatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** Whether `patch` actually moves any of `bounds`' fields. Exported so the
 *  fix for the "every node stuck at visibility:hidden once a group exists"
 *  bug is unit-testable without a browser: React Flow's own node-adoption
 *  cycle resets every node's measured dimensions on any store update
 *  (`toFlowGroups`/`toFlowNodes` build fresh node objects every render, so
 *  React Flow's identity-based `checkEquality` always misses), which makes
 *  the frame's ResizeObserver report a "dimensions changed" NodeChange whose
 *  values are IDENTICAL to what is already stored. Committing that
 *  unconditionally re-triggers the very store update that caused the reset —
 *  an infinite measure -> write -> reset -> measure loop that never lets
 *  React Flow settle any node (shared `nodes` array, one `<ReactFlow>`
 *  instance) at `visibility: visible`. Gating the write on an actual
 *  difference breaks the loop while leaving genuine drags/resizes (which do
 *  produce a real diff) untouched. */
export function groupBoundsChanged(
  bounds: { x: number; y: number; w: number; h: number },
  patch: GroupBoundsPatch,
): boolean {
  return (
    (patch.x !== undefined && patch.x !== bounds.x) ||
    (patch.y !== undefined && patch.y !== bounds.y) ||
    (patch.w !== undefined && patch.w !== bounds.w) ||
    (patch.h !== undefined && patch.h !== bounds.h)
  );
}

interface PalettePosition {
  /** Client coords, for placing the panel. */
  client: { x: number; y: number };
}

function GraphCanvasInner() {
  const doc = useEditorStore((s) => s.doc);
  const selectedNodeIds = useEditorStore((s) => s.selectedNodeIds);
  const addNode = useEditorStore((s) => s.addNode);
  const removeNodes = useEditorStore((s) => s.removeNodes);
  const moveNode = useEditorStore((s) => s.moveNode);
  const connect = useEditorStore((s) => s.connect);
  const disconnect = useEditorStore((s) => s.disconnect);
  const selectNodes = useEditorStore((s) => s.selectNodes);
  const editingTarget = useEditorStore((s) => s.editingTarget);
  const exitMaskEditing = useEditorStore((s) => s.exitMaskEditing);
  const createGroup = useEditorStore((s) => s.createGroup);
  const setGroupBounds = useEditorStore((s) => s.setGroupBounds);
  const removeGroup = useEditorStore((s) => s.removeGroup);
  const setNodeGroup = useEditorStore((s) => s.setNodeGroup);
  const extractSubGraph = useEditorStore((s) => s.extractSubGraph);
  const enterSubGraphEditing = useEditorStore((s) => s.enterSubGraphEditing);
  const exitSubGraphEditing = useEditorStore((s) => s.exitSubGraphEditing);

  const graph = activeGraph(doc, editingTarget);
  const layerId = activeLayerId(doc);
  const viewingMask = activeGraphKind(doc, editingTarget) === 'mask';
  const layer = activeLayer(doc);
  const activeSubGraph =
    editingTarget.kind === 'subgraph' ? doc.subGraphs.find((sg) => sg.id === editingTarget.subGraphId) : undefined;
  const lookup = useMemo(() => registrySocketLookup(graph, doc.subGraphs), [graph, doc.subGraphs]);

  // Edge and group/frame selection are editor-only: the document has no place
  // for either. Reset on any switch of WHICH graph is showing — a new active
  // layer, or diving into / out of that layer's mask or a subgraph (same
  // layerId, different graph either way). `editingTarget` is a fresh object
  // on every such switch (see `store.ts`), so it alone is a sufficient dep;
  // `layerId` stays for belt-and-suspenders clarity.
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  useEffect(() => {
    setSelectedEdgeIds([]);
    setSelectedGroupIds([]);
  }, [layerId, editingTarget]);

  const [palette, setPalette] = useState<PalettePosition | null>(null);
  const { screenToFlowPosition, getInternalNode } = useReactFlow();
  const wrapper = useRef<HTMLElement>(null);
  // Counts toolbar opens so far, so successive "+ Add node" clicks fan out
  // from the pane center instead of landing on the exact same spot. Pointer-
  // anchored opens (double-click / right-click) never touch this.
  const toolbarOpenCount = useRef(0);

  // React Flow calls isValidConnection on every pointer move during a drag, and
  // onConnectEnd fires outside React's render pass; refs keep both reading the
  // live graph without re-registering handlers.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;

  // Frames listed FIRST — see the file header on why that renders them behind
  // their member shader nodes.
  const rfNodes = useMemo(
    () => [...toFlowGroups(graph, selectedGroupIds), ...toFlowNodes(graph, selectedNodeIds)],
    [graph, selectedGroupIds, selectedNodeIds],
  );
  const rfEdges = useMemo(
    () => toFlowEdges(graph, selectedEdgeIds, lookup),
    [graph, selectedEdgeIds, lookup],
  );

  // ── Gestures → store ────────────────────────────────────────────────────

  /** After a shader node's drag ends, re-test its center point against every
   *  frame's bounds and update its `groupId` if membership changed — "drag a
   *  node into/out of a frame" from the DoD. Reads the freshest position/size
   *  React Flow measured for it (`getInternalNode`), not the (possibly
   *  stale-until-next-render) document position. */
  const reassignDraggedGroups = useCallback(
    (ids: Iterable<string>) => {
      const current = graphRef.current;
      const groups = current.groups ?? [];
      for (const id of ids) {
        const node = current.nodes.find((n) => n.id === id);
        const internal = getInternalNode(id);
        if (!node || !internal) continue;
        const rect: NodeRect = {
          id,
          x: internal.internals.positionAbsolute.x,
          y: internal.internals.positionAbsolute.y,
          width: internal.measured?.width ?? FALLBACK_NODE_SIZE.width,
          height: internal.measured?.height ?? FALLBACK_NODE_SIZE.height,
        };
        const nextGroupId = groupContaining(rect, groups);
        if (nextGroupId !== node.groupId) setNodeGroup(id, nextGroupId);
      }
    },
    [getInternalNode, setNodeGroup],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<ShaderFlowNode | GroupFlowNode>[]) => {
      const removed: string[] = [];
      let selection: Set<string> | null = null;
      const draggedEnded = new Set<string>();

      const groupPatches = new Map<string, { x?: number; y?: number; w?: number; h?: number }>();
      const removedGroupIds: string[] = [];
      let groupSelection: Set<string> | null = null;

      for (const change of changes) {
        // Never actually emitted by this canvas (nodes only ever arrive via
        // store-driven re-renders, not `addNodes`), but `NodeAddChange` has no
        // `id` — narrow it away before any `change.id` access below.
        if (change.type === 'add') continue;
        const groupId = groupIdFromFrameNodeId(change.id);
        if (groupId) {
          if (change.type === 'position' && change.position) {
            groupPatches.set(groupId, {
              ...groupPatches.get(groupId),
              x: change.position.x,
              y: change.position.y,
            });
          } else if (change.type === 'dimensions' && change.dimensions) {
            groupPatches.set(groupId, {
              ...groupPatches.get(groupId),
              w: change.dimensions.width,
              h: change.dimensions.height,
            });
          } else if (change.type === 'remove') {
            removedGroupIds.push(groupId);
          } else if (change.type === 'select') {
            groupSelection ??= new Set(selectedGroupIds);
            if (change.selected) groupSelection.add(groupId);
            else groupSelection.delete(groupId);
          }
          continue;
        }
        if (change.type === 'position' && change.position) {
          moveNode(change.id, change.position);
          if (change.dragging === false) draggedEnded.add(change.id);
        } else if (change.type === 'remove') {
          removed.push(change.id);
        } else if (change.type === 'select') {
          selection ??= new Set(useEditorStore.getState().selectedNodeIds);
          if (change.selected) selection.add(change.id);
          else selection.delete(change.id);
        }
      }

      // Only commit a patch that actually moves the needle — see
      // `groupBoundsChanged`'s doc comment for why an unconditional write
      // here used to hang the whole canvas at `visibility: hidden` as soon
      // as any group existed.
      for (const [groupId, patch] of groupPatches) {
        const bounds = findGroup(graphRef.current, groupId)?.bounds;
        if (bounds && groupBoundsChanged(bounds, patch)) setGroupBounds(groupId, { ...bounds, ...patch });
      }
      for (const groupId of removedGroupIds) removeGroup(groupId);
      if (groupSelection) setSelectedGroupIds([...groupSelection]);

      if (selection) selectNodes([...selection]);
      if (removed.length > 0) removeNodes(removed);
      if (draggedEnded.size > 0) reassignDraggedGroups(draggedEnded);
    },
    [moveNode, removeNodes, selectNodes, selectedGroupIds, setGroupBounds, removeGroup, reassignDraggedGroups],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<ShaderFlowEdge>[]) => {
      let selection: Set<string> | null = null;

      for (const change of changes) {
        if (change.type === 'remove') {
          disconnect(change.id);
        } else if (change.type === 'select') {
          selection ??= new Set(selectedEdgeIds);
          if (change.selected) selection.add(change.id);
          else selection.delete(change.id);
        }
      }

      if (selection) setSelectedEdgeIds([...selection]);
    },
    [disconnect, selectedEdgeIds],
  );

  const isValidConnection = useCallback<IsValidConnection<ShaderFlowEdge>>((candidate) => {
    const ends = endpointsFrom(candidate);
    if (!ends) return false;
    return validateConnection(graphRef.current, ends.source, ends.target, lookupRef.current).ok;
  }, []);

  const onConnect = useCallback<OnConnect>(
    (connection) => {
      const ends = endpointsFrom(connection);
      // A rejection here surfaces through the store's `lastError` → toast.
      if (ends) connect(ends.source, ends.target);
    },
    [connect],
  );

  // React Flow silently drops an invalid link. Re-ask the model why, so the
  // refusal is *visible* rather than a mystery non-event.
  const onConnectEnd = useCallback<OnConnectEnd>((_event, state) => {
    if (state.isValid || !state.fromHandle || !state.toHandle) return;

    const from = state.fromHandle;
    const to = state.toHandle;
    const source = from.type === 'source' ? from : to;
    const target = from.type === 'source' ? to : from;

    if (source.type !== 'source' || target.type !== 'target') {
      notify('Connect an output socket to an input socket.');
      return;
    }

    const verdict = validateConnection(
      graphRef.current,
      { node: source.nodeId, socket: source.id ?? '' },
      { node: target.nodeId, socket: target.id ?? '' },
      lookupRef.current,
    );
    notify(verdict.ok ? 'That connection was not accepted.' : verdict.message);
  }, []);

  // ── Palette ─────────────────────────────────────────────────────────────

  const openPaletteAt = useCallback((x: number, y: number) => {
    setPalette({ client: { x, y } });
  }, []);

  const onPaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      event.preventDefault();
      openPaletteAt(event.clientX, event.clientY);
    },
    [openPaletteAt],
  );

  // React Flow has no `onPaneDoubleClick`; catch it on the wrapper and ignore
  // double-clicks that landed on a node, edge, or control.
  const onDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.classList.contains('react-flow__pane')) return;
      openPaletteAt(event.clientX, event.clientY);
    },
    [openPaletteAt],
  );

  const pickNode = useCallback(
    (type: string) => {
      const at = palette?.client;
      if (!at) return;
      const position = screenToFlowPosition({ x: at.x, y: at.y });
      const id = addNode(type, position);
      setPalette(null);
      if (id) selectNodes([id]);
    },
    [addNode, palette, screenToFlowPosition, selectNodes],
  );

  const openPaletteFromToolbar = useCallback(() => {
    const box = wrapper.current?.getBoundingClientRect();
    const centerX = (box?.left ?? 0) + (box?.width ?? 0) / 2;
    const centerY = (box?.top ?? 0) + (box?.height ?? 0) / 2;
    const offset = cascadeOffset(toolbarOpenCount.current);
    toolbarOpenCount.current += 1;
    openPaletteAt(centerX + offset.dx, centerY + offset.dy);
  }, [openPaletteAt]);

  // ── Groups / frames ─────────────────────────────────────────────────────

  /** Toolbar action + Cmd/Ctrl+G: frame the current multi-selection. Reads
   *  live positions/sizes via `getInternalNode` rather than the (layout-free)
   *  document position, so the frame tightly wraps what is actually on
   *  screen. No-op under two selected nodes — see `createGroup`. */
  const groupSelectedNodes = useCallback(() => {
    const ids = useEditorStore.getState().selectedNodeIds;
    if (ids.length < 2) return;
    const rects: NodeRect[] = ids.map((id) => {
      const internal = getInternalNode(id);
      return {
        id,
        x: internal?.internals.positionAbsolute.x ?? 0,
        y: internal?.internals.positionAbsolute.y ?? 0,
        width: internal?.measured?.width ?? FALLBACK_NODE_SIZE.width,
        height: internal?.measured?.height ?? FALLBACK_NODE_SIZE.height,
      };
    });
    const bounds = boundsForNodes(rects);
    if (!bounds) return;
    const groupId = createGroup(ids, bounds);
    if (groupId) setSelectedGroupIds([groupId]);
  }, [createGroup, getInternalNode]);

  // ── Subgraphs ────────────────────────────────────────────────────────────

  /** Toolbar action: move the current selection (+ its internal edges) into a
   *  new `SubGraph`, replacing it with one instance node — see
   *  `store.extractSubGraph`. Disabled when nothing (or the output node) is
   *  selected, same spirit as the Group button above. */
  const extractSelectedToSubGraph = useCallback(() => {
    const ids = useEditorStore.getState().selectedNodeIds;
    if (ids.length === 0) return;
    extractSubGraph(ids);
  }, [extractSubGraph]);

  /** Double-clicking a subgraph-instance node dives in to edit its internals
   *  — the same affordance as the "Edit subgraph →" button on the card
   *  itself (`ShaderNodeCard.tsx`), for parity with Houdini/Unreal-style
   *  dive-in gestures. Every OTHER node type ignores this (`onDoubleClick`
   *  above already owns plain-canvas double-clicks for the add-node palette). */
  const onNodeDoubleClick = useCallback(
    (_event: ReactMouseEvent, node: ShaderFlowNode | GroupFlowNode) => {
      if (node.type === SHADER_NODE_TYPE && node.data.subGraphId !== undefined) {
        enterSubGraphEditing(node.data.subGraphId);
      }
    },
    [enterSubGraphEditing],
  );

  // The output node is not deletable, so React Flow never proposes removing it
  // and never cascade-deletes its edges. Say why instead of failing silently.
  // Also handles Cmd/Ctrl+G to group the selection, mirroring the toolbar
  // button. Window-level, because both gestures can originate from the pane,
  // a node, or the minimap — but never from a field the user is typing into.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (useEditorStore.getState().selectedNodeIds.includes(graphRef.current.outputNodeId)) {
          notify('The output node cannot be deleted.');
        }
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        groupSelectedNodes();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [groupSelectedNodes]);

  return (
    <section className="sg-graph" aria-label="Node graph" ref={wrapper} onDoubleClick={onDoubleClick}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onNodeDoubleClick={onNodeDoubleClick}
        isValidConnection={isValidConnection}
        onPaneContextMenu={onPaneContextMenu}
        deleteKeyCode={['Delete', 'Backspace']}
        multiSelectionKeyCode={['Meta', 'Shift', 'Control']}
        colorMode="dark"
        proOptions={{ hideAttribution: true }}
        connectionLineStyle={{ stroke: 'var(--sg-accent)', strokeWidth: 2 }}
        fitView
        fitViewOptions={FIT_VIEW}
        minZoom={0.2}
        maxZoom={2.5}
        zoomOnDoubleClick={false}
        // Off-screen node cards fully unmount instead of just scrolling out
        // of the viewport — `ShaderNodeCard`'s thumbnail effect relies on its
        // own mount/unmount to report node visibility to the shared preview
        // renderer (`setVisibleNodes`), so a node's thumbnail genuinely stops
        // costing GPU work once it leaves the viewport.
        onlyRenderVisibleElements
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#2b313b" />
        <Controls showInteractive={false} fitViewOptions={FIT_VIEW} />
        <MiniMap pannable zoomable nodeColor="#2a313c" maskColor="rgba(14,16,19,0.7)" />
        <Panel position="top-left" className="sg-graph__toolbar">
          <button type="button" className="sg-btn" onClick={openPaletteFromToolbar}>
            + Add node
          </button>
          <button
            type="button"
            className="sg-btn"
            onClick={groupSelectedNodes}
            disabled={selectedNodeIds.length < 2}
            title="Frame the selected nodes into a group (Cmd/Ctrl+G)"
          >
            Group
          </button>
          <button
            type="button"
            className="sg-btn"
            onClick={extractSelectedToSubGraph}
            disabled={selectedNodeIds.length === 0 || selectedNodeIds.includes(graph.outputNodeId)}
            title="Move the selected nodes into a new reusable subgraph"
          >
            Extract to Subgraph
          </button>
          <span className="sg-graph__meta">
            {graph.nodes.length} nodes · {graph.edges.length} links
          </span>
        </Panel>
        <Panel position="top-right">
          <SocketLegend />
        </Panel>
        {viewingMask ? (
          <Panel position="top-center">
            <GraphBreadcrumb parentLabel={layer.name} currentLabel="Mask" onExit={exitMaskEditing} />
          </Panel>
        ) : activeSubGraph ? (
          <Panel position="top-center">
            <GraphBreadcrumb
              parentLabel={layer.name}
              currentLabel={`Subgraph: ${activeSubGraph.name}`}
              onExit={exitSubGraphEditing}
            />
          </Panel>
        ) : null}
      </ReactFlow>

      {/* The output node is mandatory and undeletable (`emptyGraph()`), so a
          layer's graph never truly reaches zero nodes — "empty" here means
          nothing but that placeholder output has been added yet. */}
      {graph.nodes.length <= 1 ? (
        <div className="sg-graph__hint" aria-hidden="true">
          double-click or right-click the canvas to add a node
        </div>
      ) : null}

      {palette ? (
        <AddNodePalette at={palette.client} onPick={pickNode} onClose={() => setPalette(null)} />
      ) : null}
    </section>
  );
}

export function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner />
    </ReactFlowProvider>
  );
}
