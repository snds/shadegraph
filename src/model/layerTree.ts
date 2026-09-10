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
