// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Layer stack ordering
// ───────────────────────────────────────────────────────────────────────────
// The one genuinely error-prone thing in the layer panel is that TWO opposite
// orders are in play:
//
//   • the MODEL order — `layerStack.layers` is BOTTOM-TO-TOP; index 0 is the
//     base layer that everything else composites over.
//   • the SCREEN order — like Photoshop, the panel lists the TOP of the stack
//     first, so the visual list is the array reversed.
//
// Therefore "move up" on screen means "later in the array", and "move down"
// means "earlier". Getting that inversion backwards is invisible in a two-layer
// document and wrong in every other one, so the mapping lives here as pure
// functions with no React and no store, and is unit-tested on its own.
//
// Everything is generic over `{ id }` — the panel passes `ShaderLayer[]`, the
// tests pass minimal stubs.
// ═══════════════════════════════════════════════════════════════════════════

import type { StackMoveTarget } from '../../model/layerTree';

/** A direction as the USER sees it in the panel, not as the array stores it. */
export type StackDirection = 'up' | 'down';

interface Identified {
  id: string;
}

/**
 * The list as the panel renders it: top of the stack first.
 * Never mutates the input.
 */
export function topFirst<T>(layers: readonly T[]): T[] {
  return layers.slice().reverse();
}

/**
 * The array step matching a screen direction. Screen-up is toward the top of
 * the stack, which is the END of the bottom-to-top array — hence `+1`.
 */
export function arrayStep(direction: StackDirection): 1 | -1 {
  return direction === 'up' ? 1 : -1;
}

/** Index of `id`, or -1. */
export function indexOfLayer(layers: readonly Identified[], id: string): number {
  return layers.findIndex((l) => l.id === id);
}

/**
 * Can this layer still move that way? False when it is missing, or already at
 * the top (last index) / bottom (index 0).
 */
export function canMoveLayer(
  layers: readonly Identified[],
  id: string,
  direction: StackDirection,
): boolean {
  const from = indexOfLayer(layers, id);
  if (from < 0) return false;
  const to = from + arrayStep(direction);
  return to >= 0 && to < layers.length;
}

/**
 * Move one layer a single step in SCREEN direction, returning a new array.
 * Returns `null` — never a mutated or same-order copy — when the move is
 * impossible, so callers can cheaply skip a no-op document update.
 */
export function moveLayer<T extends Identified>(
  layers: readonly T[],
  id: string,
  direction: StackDirection,
): T[] | null {
  if (!canMoveLayer(layers, id, direction)) return null;
  const from = indexOfLayer(layers, id);
  const to = from + arrayStep(direction);
  const next = layers.slice();
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

// ── Drag-and-drop: screen zone → store target ──────────────────────────────
// The tree's drag-and-drop (`LayerStack.tsx`) hit-tests in SCREEN terms — the
// pointer is above/below/on a hovered row, exactly what the user sees — but
// `useEditorStore.moveStackNode` (backed by `src/model/layerTree.ts`'s
// `moveStackNode`) takes ARRAY-order targets. This is the one place that
// screen→array inversion for DRAG happens, mirroring `topFirst`'s role for
// the up/down move buttons above.

/** Where, relative to a hovered row, a drop lands — as the user SEES it:
 *  above it (`'before'`), below it (`'after'`), or, only meaningful when the
 *  hovered row is a group, dropped ON it (`'into'`, appended as its last
 *  child). */
export type ScreenDropZone = 'before' | 'after' | 'into';

/** Converts one drag gesture (`zone`, expressed in screen terms relative to
 *  `hoveredId`) into the ARRAY-order `StackMoveTarget` the store expects.
 *  Screen-`'before'` (visually above, closer to the top of the stack) is
 *  LATER in the bottom-to-top array — hence the flip — screen-`'after'` is
 *  earlier; see this file's header comment on why `topFirst` reverses at
 *  all. `'into'` needs no such flip: appending as a group's last child has
 *  no separate screen/array sense to invert. */
export function screenDropTarget(
  zone: ScreenDropZone,
  hoveredId: string,
  hoveredParentId: string | null,
): StackMoveTarget {
  if (zone === 'into') return { parentId: hoveredId, kind: 'append' };
  return { parentId: hoveredParentId, kind: zone === 'before' ? 'after' : 'before', refId: hoveredId };
}
