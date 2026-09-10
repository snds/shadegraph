// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Layer stack tree helpers
// ───────────────────────────────────────────────────────────────────────────
// `LayerStack.layers` is a recursive tree of `StackNode`s (`ShaderLayer |
// LayerGroup`, see `src/model/document.ts`) since layer groups shipped. Every
// consumer that used to walk a flat `ShaderLayer[]` — the store, the
// compiler, the preview scheduler, the inspector — needs the SAME traversal
// rules (find a node by id at any depth, flatten every leaf, locate/replace
// the sibling array a node actually lives in). Centralising them here is what
// keeps that recursion from being re-derived (and subtly drifting) in five
// different files.
//
// Pure data in, pure data out: no React, no store, no compiler types.
// ═══════════════════════════════════════════════════════════════════════════

import type { LayerGroup, ShaderLayer, StackNode } from './document';

export function isLayerNode(node: StackNode): node is ShaderLayer {
  return node.kind === 'layer';
}

export function isGroupNode(node: StackNode): node is LayerGroup {
  return node.kind === 'group';
}

/** Every LEAF layer in the tree, depth-first, in stack order — group
 *  boundaries are transparent to this list (a group's children are inlined in
 *  place). This is what most consumers that predate groups actually want:
 *  "every graph that can be edited/compiled/thumbnailed", independent of how
 *  deeply nested it is. */
export function flattenLayers(nodes: readonly StackNode[]): ShaderLayer[] {
  const out: ShaderLayer[] = [];
  for (const n of nodes) {
    if (isLayerNode(n)) out.push(n);
    else out.push(...flattenLayers(n.children));
  }
  return out;
}

/** Every `StackNode` (both layers AND groups) anywhere in the tree,
 *  depth-first, PARENT BEFORE children — for callers that need to see group
 *  nodes themselves (e.g. collecting every `maskGraph`, which a group can
 *  have too), not just their leaves. */
export function allStackNodes(nodes: readonly StackNode[]): StackNode[] {
  const out: StackNode[] = [];
  for (const n of nodes) {
    out.push(n);
    if (isGroupNode(n)) out.push(...allStackNodes(n.children));
  }
  return out;
}

/** The first leaf layer's id in stack order — the tree equivalent of
 *  `layers[0].id`, used as the `activeLayerId` fallback when the stored id no
 *  longer resolves to a leaf anywhere in the tree. */
export function firstLayerId(nodes: readonly StackNode[]): string | undefined {
  return flattenLayers(nodes)[0]?.id;
}

/** Finds a LEAF layer by id anywhere in the tree. A group id never resolves
 *  here, even if it happens to collide (ids are unique across the whole tree
 *  in practice) — callers that want either kind should use `findStackNode`. */
export function findLayer(nodes: readonly StackNode[], id: string): ShaderLayer | undefined {
  for (const n of nodes) {
    if (isLayerNode(n)) {
      if (n.id === id) return n;
    } else if (n.id !== id) {
      const found = findLayer(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Finds any `StackNode` (layer or group) by id anywhere in the tree. */
export function findStackNode(nodes: readonly StackNode[], id: string): StackNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (isGroupNode(n)) {
      const found = findStackNode(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** The leaf layer whose OWN graph contains `nodeId` — the tree equivalent of
 *  `layers.find(l => l.graph.nodes.some(n => n.id === nodeId))`. Does not
 *  search mask graphs (a mask's nodes are not addressable node-canvas ids in
 *  the same namespace today) — matches every pre-existing call site's own
 *  behaviour. */
export function findLayerOwningNode(nodes: readonly StackNode[], nodeId: string): ShaderLayer | undefined {
  return flattenLayers(nodes).find((l) => l.graph.nodes.some((n) => n.id === nodeId));
}

/** Locates the sibling array a node lives in DIRECTLY (the root `layers`
 *  array, or a group's own `children`) plus its index there. This is the
 *  scope reordering/grouping must operate within: moving/grouping a node
 *  should only ever reshuffle its own siblings, never reach across a group
 *  boundary. Returns `undefined` if `id` is not found anywhere. */
export function findSiblingArray(
  nodes: readonly StackNode[],
  id: string,
): { siblings: StackNode[]; index: number } | undefined {
  const index = nodes.findIndex((n) => n.id === id);
  if (index >= 0) return { siblings: [...nodes], index };
  for (const n of nodes) {
    if (isGroupNode(n)) {
      const found = findSiblingArray(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

/** Replaces whichever sibling array directly contains `id` (root `layers`, or
 *  some group's `children`) with `nextSiblings`, anywhere in the tree —
 *  the write-back half of `findSiblingArray`. `id` need not still be present
 *  in `nextSiblings` (e.g. after `groupLayers` folds it into a new group
 *  living at that same slot). No-op (returns `nodes` unchanged) if `id` is
 *  not found in the ORIGINAL tree. */
export function replaceSiblingArray(
  nodes: StackNode[],
  id: string,
  nextSiblings: StackNode[],
): StackNode[] {
  if (nodes.some((n) => n.id === id)) return nextSiblings;
  let changed = false;
  const next = nodes.map((n) => {
    if (isGroupNode(n)) {
      const children = replaceSiblingArray(n.children, id, nextSiblings);
      if (children !== n.children) {
        changed = true;
        return { ...n, children };
      }
    }
    return n;
  });
  return changed ? next : nodes;
}

/** Immutably applies `fn` to the `StackNode` matching `id` anywhere in the
 *  tree; `fn` returning `null` removes that node (and, if it was a group,
 *  its whole subtree) from its parent array. Returns the new top-level
 *  `layers` array and whether anything actually changed, so a caller can
 *  cheaply no-op when `id` does not resolve. */
export function updateStackNode(
  nodes: readonly StackNode[],
  id: string,
  fn: (node: StackNode) => StackNode | null,
): { nodes: StackNode[]; changed: boolean } {
  let changed = false;
  const next: StackNode[] = [];
  for (const n of nodes) {
    if (n.id === id) {
      changed = true;
      const updated = fn(n);
      if (updated) next.push(updated);
      continue;
    }
    if (isGroupNode(n)) {
      const result = updateStackNode(n.children, id, fn);
      if (result.changed) {
        changed = true;
        next.push({ ...n, children: result.nodes });
        continue;
      }
    }
    next.push(n);
  }
  return { nodes: next, changed };
}

/** `id` plus every id nested (at any depth) inside it if it is a group — the
 *  "cannot drop a group inside its own descendant" check for drag-and-drop
 *  (`moveStackNode`, below) needs this, and it doubles as "everything that
 *  disappears if this node is removed" for `removeLayer`'s selection cleanup. */
export function subtreeIds(node: StackNode): Set<string> {
  const ids = new Set<string>([node.id]);
  if (isGroupNode(node)) {
    for (const child of node.children) for (const id of subtreeIds(child)) ids.add(id);
  }
  return ids;
}

/** Every group id that (transitively) CONTAINS `id`, in no particular order —
 *  not `id` itself. A leaf/group's own composited thumbnail always depends on
 *  more than just its own dirtiness: a change anywhere inside it must also
 *  invalidate every ancestor group's already-folded composite (see
 *  `LayerGroup`'s own doc comment on `foldStack`). `[]` if `id` is not found,
 *  or sits at the root (no enclosing group). */
export function ancestorGroupIds(nodes: readonly StackNode[], id: string): string[] {
  const path: string[] = [];
  function walk(list: readonly StackNode[]): boolean {
    for (const n of list) {
      if (n.id === id) return true;
      if (isGroupNode(n) && walk(n.children)) {
        path.push(n.id);
        return true;
      }
    }
    return false;
  }
  walk(nodes);
  return path;
}

/** Where to splice a node during a drag-and-drop move (`moveStackNode`,
 *  below): either immediately before/after an existing sibling (`refId`) in
 *  whichever sibling array `parentId` names (`null` = the document root), or
 *  appended as the LAST child of a group (`parentId` — required, since
 *  "append" only makes sense as "into a group"). `kind: 'before' | 'after'`
 *  is ARRAY order (bottom-to-top), not screen order — see
 *  `src/ui/layers/reorder.ts`'s `screenDropTarget` for the one place that
 *  inversion is allowed to happen, same convention as `topFirst`. */
export type StackMoveTarget =
  | { parentId: string | null; kind: 'before' | 'after'; refId: string }
  | { parentId: string; kind: 'append' };

/** Repositions `id` to `target`, anywhere in the tree — reorder within its
 *  current parent, or move across an arbitrary group boundary (including into
 *  a group it was not previously in, or out to the root), in one splice.
 *  Deliberately more general than `reorderLayer`'s single-step
 *  same-sibling-array move: drag-and-drop needs an arbitrary destination, not
 *  a sequence of one-step nudges. Pure — never mutates `nodes` — and returns
 *  `{ error }` instead of throwing for every rejection (unknown id, dropping a
 *  group inside itself or its own descendant, unknown `refId`), so the store
 *  can surface it via `lastError` exactly like every other tree action here. */
export function moveStackNode(
  nodes: readonly StackNode[],
  id: string,
  target: StackMoveTarget,
): { nodes: StackNode[]; error?: string } {
  const asIs = nodes as StackNode[];
  const node = findStackNode(nodes, id);
  if (!node) return { nodes: asIs, error: `No layer "${id}".` };

  if (target.parentId === id) return { nodes: asIs, error: 'Cannot drop a group inside itself.' };
  if (target.parentId) {
    const parentNode = findStackNode(nodes, target.parentId);
    if (!parentNode || !isGroupNode(parentNode)) {
      return { nodes: asIs, error: `"${target.parentId}" is not a group.` };
    }
    if (isGroupNode(node) && subtreeIds(node).has(target.parentId)) {
      return { nodes: asIs, error: 'Cannot drop a group inside its own descendant.' };
    }
  }
  if (target.kind !== 'append' && target.refId === id) return { nodes: asIs };

  const { nodes: withoutNode, changed } = updateStackNode(nodes, id, () => null);
  if (!changed) return { nodes: asIs, error: `No layer "${id}".` };

  const destSiblings = target.parentId
    ? ((findStackNode(withoutNode, target.parentId) as LayerGroup | undefined)?.children ?? [])
    : withoutNode;

  let nextDest: StackNode[];
  if (target.kind === 'append') {
    nextDest = [...destSiblings, node];
  } else {
    const refIndex = destSiblings.findIndex((n) => n.id === target.refId);
    if (refIndex < 0) return { nodes: asIs, error: `No layer "${target.refId}".` };
    const insertAt = target.kind === 'after' ? refIndex + 1 : refIndex;
    nextDest = [...destSiblings.slice(0, insertAt), node, ...destSiblings.slice(insertAt)];
  }

  const nextNodes = target.parentId
    ? updateStackNode(withoutNode, target.parentId, (g) => ({ ...(g as LayerGroup), children: nextDest })).nodes
    : nextDest;

  return { nodes: nextNodes };
}

/** Inserts `node` directly BELOW `insertBeneathId` in its own sibling array
 *  (same array-order convention as `moveStackNode`'s `'before'`/`'after'` —
 *  screen-below is array-index-of-the-reference, per `reorder.ts`'s header),
 *  or appends it at the document root's end (the original, simpler default)
 *  when `insertBeneathId` is `undefined` or does not resolve. Shared by
 *  `addLayer`/`addGroup` so both "new sibling" affordances place their result
 *  the same way relative to whatever the Layers panel currently has selected. */
export function insertStackNode(
  nodes: readonly StackNode[],
  node: StackNode,
  insertBeneathId?: string,
): StackNode[] {
  if (insertBeneathId) {
    const info = findSiblingArray(nodes, insertBeneathId);
    if (info) {
      const nextSiblings = [...info.siblings.slice(0, info.index), node, ...info.siblings.slice(info.index)];
      return replaceSiblingArray(nodes as StackNode[], insertBeneathId, nextSiblings);
    }
  }
  return [...nodes, node];
}

/** Maps every LEAF layer in the tree through `fn`, preserving group nesting
 *  and structural sharing: an unchanged subtree keeps its original array/
 *  object references (bottom-up, so a change deep in one branch never forces
 *  a fresh reference on an untouched sibling branch). `fn` returning the same
 *  reference back is treated as "unchanged". Mirrors `Array.prototype.map`'s
 *  ergonomics for the flat case this replaces. */
export function mapLeafLayers(
  nodes: StackNode[],
  fn: (layer: ShaderLayer) => ShaderLayer,
): StackNode[] {
  let changed = false;
  const next = nodes.map((n) => {
    if (isLayerNode(n)) {
      const updated = fn(n);
      if (updated !== n) changed = true;
      return updated;
    }
    const children = mapLeafLayers(n.children, fn);
    if (children !== n.children) {
      changed = true;
      return { ...n, children };
    }
    return n;
  });
  return changed ? next : nodes;
}
