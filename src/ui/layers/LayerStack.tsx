// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Layer stack
// ───────────────────────────────────────────────────────────────────────────
// The Photoshop-like surface: a recursive tree of leaf `ShaderLayer`s and
// `LayerGroup` folders, each leaf owning its own node graph. This pane picks
// WHICH graph the canvas edits (`setActiveLayer`, leaf only) and WHICH
// layer/group is selected (`selectLayers` — `store.ts`'s `selectedLayerIds`,
// leaf OR group), and drives adding/reordering/(un)grouping rows. It never
// touches nodes or edges — that is the graph surface's job — and it no
// longer owns any COMPOSITING controls (blend/opacity/enabled/visible/solo/
// mask/delete/ungroup): those relocated to the Inspector's `LayerControlsPane`
// (`Inspector.tsx`) once a row is selected here. This panel keeps only:
// thumbnail, name (+ inline rename), select-on-click, expand/collapse for
// groups, a drag handle, and the "+ Layer"/"+ Group" add affordances.
//
// Contract with `App.tsx` (unchanged from the placeholder): props-free, one
// root element `<aside className="sg-layers">`, named export `LayerStack`.
//
// Order: any sibling array in `StackNode[]` is BOTTOM-TO-TOP; every level of
// this tree renders TOP-FIRST. That inversion lives entirely in `./reorder`
// (`topFirst`, `screenDropTarget`), never inline here.
//
// Drag-and-drop is hand-rolled with pointer events (no DnD library in
// `package.json`, and this task's scope says not to add one): a row's drag
// handle starts a manual drag, `window` `pointermove`/`pointerup` hit-test via
// `document.elementFromPoint` against every row's `data-stack-id`, and the
// hovered row's vertical third decides before/after/into — `./reorder`'s
// `screenDropTarget` converts that into the store's `moveStackNode` call.
//
// Thumbnails reuse the SAME shared preview renderer every other thumbnail in
// this codebase does (`store.previewRenderer`, `src/preview/`) via the
// Layers-panel-specific `requestLayerThumbnail`/`setVisibleLayers` — never a
// second preview path. `CompileOptions.previewLayerId` (generalized to accept
// a group id, not just a leaf) is what makes a GROUP's thumbnail the exact
// composite `foldStack` folds its children into.
//
// Rejections (deleting the last layer via the Inspector, an invalid drag,
// unknown ids) are surfaced by the store's `lastError` → `NoticeToast`
// channel, so nothing here invents its own errors.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';

import type { LayerGroup, ShaderLayer, StackNode } from '../../model/document';
import { findStackNode, flattenLayers, isGroupNode, subtreeIds } from '../../model/layerTree';
import type { PreviewScheduler } from '../../preview/scheduler';
import { Icon } from '../shell/Icon';
import { activeLayerId, useEditorStore } from '../store';
import { screenDropTarget, topFirst, type ScreenDropZone } from './reorder';
import './layers.css';

/** Small square thumbnail, deliberately smaller than a graph-canvas node's
 *  (`ShaderNodeCard`'s 96px) — this panel is a narrow column of many rows,
 *  not one card at a time. */
const THUMBNAIL_SIZE = 32;
/** Same "how quickly does a live edit visibly update" knob as
 *  `ShaderNodeCard`'s `POLL_INTERVAL_MS`, just a little slower — a sidebar
 *  thumbnail updating within ~200ms of an edit is plenty, and it halves the
 *  poll traffic competing with the graph canvas's own per-node thumbnails. */
const POLL_INTERVAL_MS = 200;

export function LayerStack() {
  const layers = useEditorStore((s) => s.doc.layerStack.layers);
  const activeId = useEditorStore((s) => activeLayerId(s.doc));
  const selectedIds = useEditorStore((s) => s.selectedLayerIds);
  const selectLayers = useEditorStore((s) => s.selectLayers);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const setLayerProp = useEditorStore((s) => s.setLayerProp);
  const addLayer = useEditorStore((s) => s.addLayer);
  const addGroup = useEditorStore((s) => s.addGroup);
  const groupLayers = useEditorStore((s) => s.groupLayers);
  const moveStackNode = useEditorStore((s) => s.moveStackNode);

  // Expand/collapse is transient view state, same treatment as
  // `selectedNodeIds`/`selectedLayerIds` — never persisted, never touched by
  // save/load. Unlike those, it lives in this component (not the store):
  // nothing else in the app needs to know which folders are open.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  function toggleCollapsed(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // The row a plain click most recently landed on (the LAST entry of a
  // multi-select) — "+ Layer"/"+ Group" insert directly beneath this one.
  // `undefined` (nothing selected yet) falls back to appending at the
  // document root's end, `addLayer`/`addGroup`'s own original default.
  const insertBeneath = selectedIds[selectedIds.length - 1];

  function handleSelect(id: string, additive: boolean) {
    if (!additive) {
      selectLayers([id]);
      return;
    }
    selectLayers(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  }

  function handleActivateLeaf(id: string) {
    setActiveLayer(id);
    selectLayers([id]);
  }

  function handleAddLayer() {
    addLayer(undefined, { insertBeneath });
  }

  // "+ Group" doubles as the "Group" action the Inspector task's spec asks
  // for (multi-select here, then one trigger): 2+ selected siblings wrap via
  // `groupLayers` (siblinghood is validated there, surfaced via `lastError`
  // if the selection spans more than one parent); otherwise it behaves like
  // "+ Layer" but for an empty new group.
  function handleAddGroup() {
    if (selectedIds.length >= 2) groupLayers(selectedIds);
    else addGroup(undefined, { insertBeneath });
  }

  // ── Drag-and-drop ─────────────────────────────────────────────────────────
  // Refs (not state) drive the actual decision at drop time — `pointerup`'s
  // handler closes over these by reference, never a stale render's state.
  // `dragId`/`dropIndicator` (state) exist ONLY to drive the row highlight
  // classes below; nothing reads them for the move itself.
  const draggedSubtreeRef = useRef<ReadonlySet<string>>(new Set());
  const dropRef = useRef<{ id: string; zone: ScreenDropZone; parentId: string | null } | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<{ id: string; zone: ScreenDropZone } | null>(null);

  function beginDrag(id: string, event: React.PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const node = findStackNode(useEditorStore.getState().doc.layerStack.layers, id);
    if (!node) return;
    draggedSubtreeRef.current = subtreeIds(node);
    setDragId(id);

    function handleMove(ev: PointerEvent) {
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>(
        '[data-stack-id]',
      );
      const hoveredId = el?.dataset.stackId;
      if (!el || !hoveredId || draggedSubtreeRef.current.has(hoveredId)) {
        dropRef.current = null;
        setDropIndicator(null);
        return;
      }
      const hoveredParentId = el.dataset.parentId || null;
      // Hit-test against the row's OWN header (`.sg-layers__row`), never the
      // whole `<li>` — an EXPANDED group's `<li>` bounding rect also spans
      // its nested children (they render inside the same `<li>`, per
      // `TreeRow`), so using it directly would skew "before/after/into" by
      // however tall that subtree currently is. A collapsed group or a leaf
      // has no nested list, so this is a no-op fallback for those.
      const rowEl = el.querySelector<HTMLElement>(':scope > .sg-layers__row') ?? el;
      const rect = rowEl.getBoundingClientRect();
      const rel = rect.height > 0 ? (ev.clientY - rect.top) / rect.height : 0.5;
      const zone: ScreenDropZone =
        el.dataset.kind === 'group' ? (rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'into') : rel < 0.5 ? 'before' : 'after';
      dropRef.current = { id: hoveredId, zone, parentId: hoveredParentId };
      setDropIndicator({ id: hoveredId, zone });
    }

    function endDrag() {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
      const drop = dropRef.current;
      dropRef.current = null;
      setDragId(null);
      setDropIndicator(null);
      if (drop) moveStackNode(id, screenDropTarget(drop.zone, drop.id, drop.parentId));
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
  }

  return (
    <aside className="sg-layers" aria-label="Layer stack">
      <header className="sg-layers__head">
        <h2 className="sg-pane__title">Layers</h2>
        <div className="sg-layers__addRow">
          <button
            type="button"
            className="sg-btn sg-btn--mini"
            onClick={handleAddLayer}
            title={insertBeneath ? 'Add a layer beneath the current selection' : 'Add a layer at the top of the stack'}
          >
            + Layer
          </button>
          <button
            type="button"
            className="sg-btn sg-btn--mini"
            onClick={handleAddGroup}
            title={
              selectedIds.length >= 2
                ? 'Group the selected layers'
                : insertBeneath
                  ? 'Add an empty group beneath the current selection'
                  : 'Add an empty group at the top of the stack'
            }
          >
            + Group
          </button>
        </div>
      </header>

      <ul className="sg-layers__list">
        <TreeLevel
          nodes={layers}
          parentId={null}
          depth={0}
          activeId={activeId}
          selectedIds={selectedIds}
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          onSelect={handleSelect}
          onActivateLeaf={handleActivateLeaf}
          onRename={(id, name) => setLayerProp(id, { name })}
          dragId={dragId}
          dropIndicator={dropIndicator}
          onBeginDrag={beginDrag}
        />
      </ul>

      <p className="sg-layers__legend">
        Top of the stack composites last. Drag the handle to reorder or drop into/out of a group. Select a row to edit
        its blend/opacity/mask/delete controls in the Inspector.
      </p>
    </aside>
  );
}

// ── One nesting level ───────────────────────────────────────────────────────

interface SharedRowHandlers {
  activeId: string;
  selectedIds: string[];
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (id: string) => void;
  onSelect: (id: string, additive: boolean) => void;
  onActivateLeaf: (id: string) => void;
  onRename: (id: string, name: string) => void;
  dragId: string | null;
  dropIndicator: { id: string; zone: ScreenDropZone } | null;
  onBeginDrag: (id: string, event: React.PointerEvent<HTMLButtonElement>) => void;
}

interface TreeLevelProps extends SharedRowHandlers {
  nodes: StackNode[];
  parentId: string | null;
  depth: number;
}

/** One sibling array, TOP-FIRST (`topFirst`), each rendered as a `<TreeRow>` —
 *  recursion into a group's own `children` happens INSIDE that row, so a
 *  collapsed group's subtree is never even mounted (same "dirty + visible
 *  only" discipline the thumbnails below already follow). Solo is scoped per
 *  sibling array (`document.ts`'s own contract), so "is any row here dimmed"
 *  is computed fresh at each level rather than inherited from a parent. */
function TreeLevel({ nodes, parentId, depth, ...handlers }: TreeLevelProps) {
  const soloing = nodes.some((n) => n.soloed);
  return (
    <>
      {topFirst(nodes).map((node) => (
        <TreeRow key={node.id} node={node} parentId={parentId} depth={depth} dimmed={soloing && !node.soloed} {...handlers} />
      ))}
    </>
  );
}

interface TreeRowProps extends SharedRowHandlers {
  node: StackNode;
  parentId: string | null;
  depth: number;
  dimmed: boolean;
}

function TreeRow({
  node,
  parentId,
  depth,
  dimmed,
  activeId,
  selectedIds,
  collapsed,
  onToggleCollapsed,
  onSelect,
  onActivateLeaf,
  onRename,
  dragId,
  dropIndicator,
  onBeginDrag,
}: TreeRowProps) {
  const isGroup = isGroupNode(node);
  const isCollapsed = isGroup && collapsed.has(node.id);
  const selected = selectedIds.includes(node.id);
  const isActive = !isGroup && node.id === activeId;
  const dropZone = dropIndicator?.id === node.id ? dropIndicator.zone : undefined;

  // Buffered draft, same pattern the pre-tree `LayerStack.tsx` used for
  // renaming: the field only diverges from the store while it has focus, so
  // an external rename (undo, later multi-user edits) is never clobbered.
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(node.name);

  useEffect(() => {
    if (!renaming) setDraftName(node.name);
  }, [node.name, renaming]);

  function commitRename() {
    setRenaming(false);
    const next = draftName.trim();
    if (next && next !== node.name) onRename(node.id, next);
    else setDraftName(node.name);
  }

  function handleClick(event: React.MouseEvent) {
    const additive = event.metaKey || event.ctrlKey || event.shiftKey;
    if (additive) {
      onSelect(node.id, true);
      return;
    }
    if (isGroup) onSelect(node.id, false);
    else onActivateLeaf(node.id);
  }

  return (
    <li
      className="sg-layers__item"
      data-stack-id={node.id}
      data-parent-id={parentId ?? ''}
      data-kind={node.kind}
      data-active={isActive || undefined}
      data-selected={selected || undefined}
      data-dimmed={dimmed || undefined}
      data-disabled={!node.enabled || undefined}
      data-dragging={dragId === node.id || undefined}
      data-drop={dropZone}
      style={{ paddingLeft: depth * 14 }}
    >
      <div className="sg-layers__row">
        <button
          type="button"
          className="sg-layers__drag"
          aria-label={`Reorder ${node.name}`}
          title="Drag to reorder, or drop into/out of a group"
          onPointerDown={(e) => onBeginDrag(node.id, e)}
        >
          <Icon name="drag_indicator" />
        </button>

        {isGroup ? (
          <button
            type="button"
            className="sg-layers__chevron"
            onClick={() => onToggleCollapsed(node.id)}
            aria-label={isCollapsed ? `Expand ${node.name}` : `Collapse ${node.name}`}
            aria-expanded={!isCollapsed}
            title={isCollapsed ? 'Expand group' : 'Collapse group'}
          >
            <Icon name={isCollapsed ? 'chevron_right' : 'expand_more'} />
          </button>
        ) : (
          <span className="sg-layers__chevron sg-layers__chevron--spacer" aria-hidden="true" />
        )}

        <LayerThumbnail id={node.id} />

        {renaming ? (
          <input
            className="sg-layers__nameInput"
            value={draftName}
            autoFocus
            aria-label={`Rename ${node.name}`}
            onChange={(e) => setDraftName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setDraftName(node.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          // The row's name button doubles as select-on-click (and, for a
          // leaf, "edit this layer's graph") — double-click renames instead.
          <button
            type="button"
            className="sg-layers__name"
            onClick={handleClick}
            onDoubleClick={() => setRenaming(true)}
            aria-pressed={selected}
            title={
              isGroup
                ? `${node.name} (double-click to rename, ⌘/Ctrl/Shift-click to multi-select)`
                : `Edit ${node.name}'s graph (double-click to rename, ⌘/Ctrl/Shift-click to multi-select)`
            }
          >
            <span className="sg-layers__label">{node.name}</span>
            <span className="sg-layers__count">
              {isGroup
                ? `${flattenLayers((node as LayerGroup).children).length} layers`
                : `${(node as ShaderLayer).graph.nodes.length} nodes`}
            </span>
          </button>
        )}
      </div>

      {isGroup && !isCollapsed ? (
        <ul className="sg-layers__list sg-layers__list--nested">
          <TreeLevel
            nodes={(node as LayerGroup).children}
            parentId={node.id}
            depth={depth + 1}
            activeId={activeId}
            selectedIds={selectedIds}
            collapsed={collapsed}
            onToggleCollapsed={onToggleCollapsed}
            onSelect={onSelect}
            onActivateLeaf={onActivateLeaf}
            onRename={onRename}
            dragId={dragId}
            dropIndicator={dropIndicator}
            onBeginDrag={onBeginDrag}
          />
        </ul>
      ) : null}
    </li>
  );
}

// ── Per-row thumbnail ────────────────────────────────────────────────────────
// Mirrors `ShaderNodeCard.tsx`'s `useThumbnail`/`NodeThumbnail` pattern
// exactly, one level up: a STACK NODE (leaf or group) instead of a graph
// node, via `requestLayerThumbnail`/`setVisibleLayers` instead of
// `requestThumbnail`/`setVisibleNodes` — a disjoint id space and a disjoint
// dirty/visible/budget tracker on the SAME shared `ThumbnailScheduler`
// (`src/preview/thumbnails.ts`), never a second preview path.

/** Every currently-mounted row's thumbnail, so `setVisibleLayers` always
 *  reflects every on-screen row, not just whichever one most recently
 *  mounted/unmounted (collapsing a group unmounts its children's rows). */
const visibleStackIds = new Set<string>();

function useLayerThumbnail(id: string): HTMLCanvasElement | null {
  const renderer = useEditorStore((s) => s.previewRenderer);
  const [frame, setFrame] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!renderer) return;

    visibleStackIds.add(id);
    renderer.setVisibleLayers([...visibleStackIds]);

    let cancelled = false;
    let rafHandle = 0;
    let lastPoll = 0;

    function poll(ts: number): void {
      if (ts - lastPoll >= POLL_INTERVAL_MS) {
        lastPoll = ts;
        pollNow(renderer as PreviewScheduler);
      }
      rafHandle = requestAnimationFrame(poll);
    }

    function pollNow(scheduler: PreviewScheduler): void {
      scheduler
        .requestLayerThumbnail({ id, size: THUMBNAIL_SIZE, priority: 'visible' })
        .then((result) => {
          if (!cancelled && result instanceof HTMLCanvasElement) setFrame(result);
        })
        .catch(() => {
          // A transient compile error (e.g. mid-edit cycle) — keep showing
          // the last good frame rather than clearing it.
        });
    }

    rafHandle = requestAnimationFrame(poll);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafHandle);
      visibleStackIds.delete(id);
      renderer.setVisibleLayers([...visibleStackIds]);
    };
  }, [id, renderer]);

  return frame;
}

function LayerThumbnail({ id }: { id: string }) {
  const frame = useLayerThumbnail(id);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  }, [frame]);

  return (
    <div className="sg-layers__thumb" aria-hidden="true">
      <canvas ref={canvasRef} width={THUMBNAIL_SIZE} height={THUMBNAIL_SIZE} className="sg-layers__thumbCanvas" />
    </div>
  );
}
