// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Node graph canvas
// ───────────────────────────────────────────────────────────────────────────
// React Flow bound to the editor store, editing whichever graph the store's
// `editingTarget` currently names — the active layer's main graph, or (while
// dived into one) its mask graph, via `activeGraph`/`activeGraphKind`. When
// showing a mask, a breadcrumb (`GraphBreadcrumb`) offers a one-click way
// back. The canvas holds no graph state of its own: `nodes`/`edges` are
// projected from the document on every render, and every gesture is
// translated back into a store action. The one exception is edge
// *selection*, which is view-only state the document has no field for.
//
// Connection legality is never decided here. `isValidConnection` and the
// post-drop message both call the model's `validateConnection`, so the canvas
// and the store can never disagree about what is legal, and the user sees the
// model's own reason ("Cannot connect vec2 to float.") rather than a guess.
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
import { GraphBreadcrumb } from './GraphBreadcrumb';
import { cascadeOffset } from './paletteCascade';
import { ShaderNodeCard } from './ShaderNodeCard';
import { SocketLegend } from './SocketLegend';
import { registrySocketLookup } from './socketLookup';
import {
  endpointsFrom,
  SHADER_NODE_TYPE,
  toFlowEdges,
  toFlowNodes,
  type ShaderFlowEdge,
  type ShaderFlowNode,
} from './project';

/** Stable across renders — React Flow warns (and remounts nodes) otherwise. */
const nodeTypes: NodeTypes = { [SHADER_NODE_TYPE]: ShaderNodeCard };

/** Shared by the initial fit and the Controls button, so both frame the graph
 *  the same way. Without the zoom cap, a fresh document's single output node
 *  fills the entire canvas. */
const FIT_VIEW = { maxZoom: 1, padding: 0.25 };

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

  const graph = activeGraph(doc, editingTarget);
  const layerId = activeLayerId(doc);
  const viewingMask = activeGraphKind(doc, editingTarget) === 'mask';
  const layer = activeLayer(doc);
  const lookup = useMemo(() => registrySocketLookup(graph), [graph]);

  // Edge selection is editor-only: the document has no place for it. Reset on
  // any switch of WHICH graph is showing — a new active layer, or diving into
  // / out of that layer's mask (same layerId, different graph).
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  useEffect(() => setSelectedEdgeIds([]), [layerId, viewingMask]);

  const [palette, setPalette] = useState<PalettePosition | null>(null);
  const { screenToFlowPosition } = useReactFlow();
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

  const rfNodes = useMemo(() => toFlowNodes(graph, selectedNodeIds), [graph, selectedNodeIds]);
  const rfEdges = useMemo(
    () => toFlowEdges(graph, selectedEdgeIds, lookup),
    [graph, selectedEdgeIds, lookup],
  );

  // ── Gestures → store ────────────────────────────────────────────────────

  const onNodesChange = useCallback(
    (changes: NodeChange<ShaderFlowNode>[]) => {
      const removed: string[] = [];
      let selection: Set<string> | null = null;

      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          moveNode(change.id, change.position);
        } else if (change.type === 'remove') {
          removed.push(change.id);
        } else if (change.type === 'select') {
          selection ??= new Set(useEditorStore.getState().selectedNodeIds);
          if (change.selected) selection.add(change.id);
          else selection.delete(change.id);
        }
      }

      if (selection) selectNodes([...selection]);
      if (removed.length > 0) removeNodes(removed);
    },
    [moveNode, removeNodes, selectNodes],
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

  // The output node is not deletable, so React Flow never proposes removing it
  // and never cascade-deletes its edges. Say why instead of failing silently.
  // Window-level, because the delete gesture can originate from the pane, a
  // node, or the minimap — but never from a field the user is typing into.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      if (useEditorStore.getState().selectedNodeIds.includes(graphRef.current.outputNodeId)) {
        notify('The output node cannot be deleted.');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
          <span className="sg-graph__meta">
            {graph.nodes.length} nodes · {graph.edges.length} links
          </span>
        </Panel>
        <Panel position="top-right">
          <SocketLegend />
        </Panel>
        {viewingMask ? (
          <Panel position="top-center">
            <GraphBreadcrumb layerName={layer.name} onExit={exitMaskEditing} />
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
