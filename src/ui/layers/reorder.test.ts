// The bottom-to-top array vs top-first panel inversion is the likeliest bug in
// the layer stack, and it hides completely in a two-layer document — every test
// here uses three or more layers so a flipped direction actually fails.

import { describe, expect, it } from 'vitest';

import { emptyDocument } from '../../model/document';
import { emptyLayer } from '../../model/factory';
import {
  arrayStep,
  canMoveLayer,
  indexOfLayer,
  moveLayer,
  reorderedDocument,
  topFirst,
} from './reorder';

/** Bottom-to-top: `a` is the base layer, `d` is the top of the stack. */
const stack = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];

const ids = (layers: readonly { id: string }[]) => layers.map((l) => l.id);

describe('topFirst', () => {
  it('renders the top of the stack first', () => {
    expect(ids(topFirst(stack))).toEqual(['d', 'c', 'b', 'a']);
  });

  it('does not mutate the model order', () => {
    const input = stack.slice();
    topFirst(input);
    expect(ids(input)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('handles empty and single-item lists', () => {
    expect(topFirst([])).toEqual([]);
    expect(ids(topFirst([{ id: 'only' }]))).toEqual(['only']);
  });
});

describe('arrayStep', () => {
  it('maps screen-up to later in the bottom-to-top array', () => {
    expect(arrayStep('up')).toBe(1);
  });

  it('maps screen-down to earlier in the bottom-to-top array', () => {
    expect(arrayStep('down')).toBe(-1);
  });
});

describe('indexOfLayer', () => {
  it('finds a layer', () => {
    expect(indexOfLayer(stack, 'c')).toBe(2);
  });

  it('returns -1 for an unknown id', () => {
    expect(indexOfLayer(stack, 'nope')).toBe(-1);
  });
});

describe('canMoveLayer', () => {
  it('refuses to move the top layer up', () => {
    expect(canMoveLayer(stack, 'd', 'up')).toBe(false);
  });

  it('refuses to move the bottom layer down', () => {
    expect(canMoveLayer(stack, 'a', 'down')).toBe(false);
  });

  it('allows the top layer down and the bottom layer up', () => {
    expect(canMoveLayer(stack, 'd', 'down')).toBe(true);
    expect(canMoveLayer(stack, 'a', 'up')).toBe(true);
  });

  it('refuses an unknown id in either direction', () => {
    expect(canMoveLayer(stack, 'nope', 'up')).toBe(false);
    expect(canMoveLayer(stack, 'nope', 'down')).toBe(false);
  });

  it('refuses both directions in a one-layer document', () => {
    expect(canMoveLayer([{ id: 'a' }], 'a', 'up')).toBe(false);
    expect(canMoveLayer([{ id: 'a' }], 'a', 'down')).toBe(false);
  });
});

describe('moveLayer', () => {
  it('moving up moves the layer toward the end of the array', () => {
    expect(ids(moveLayer(stack, 'b', 'up')!)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moving down moves the layer toward the start of the array', () => {
    expect(ids(moveLayer(stack, 'c', 'down')!)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moving up moves the row one slot nearer the top of the rendered list', () => {
    const before = ids(topFirst(stack));
    const after = ids(topFirst(moveLayer(stack, 'b', 'up')!));
    expect(before).toEqual(['d', 'c', 'b', 'a']);
    expect(after).toEqual(['d', 'b', 'c', 'a']);
    expect(after.indexOf('b')).toBe(before.indexOf('b') - 1);
  });

  it('moving down moves the row one slot nearer the bottom of the rendered list', () => {
    const before = ids(topFirst(stack));
    const after = ids(topFirst(moveLayer(stack, 'c', 'down')!));
    expect(after.indexOf('c')).toBe(before.indexOf('c') + 1);
  });

  it('is its own inverse', () => {
    const there = moveLayer(stack, 'b', 'up')!;
    expect(ids(moveLayer(there, 'b', 'down')!)).toEqual(ids(stack));
  });

  it('returns null instead of a no-op copy at either end', () => {
    expect(moveLayer(stack, 'd', 'up')).toBeNull();
    expect(moveLayer(stack, 'a', 'down')).toBeNull();
    expect(moveLayer(stack, 'nope', 'up')).toBeNull();
  });

  it('never mutates the input array', () => {
    const input = stack.slice();
    moveLayer(input, 'b', 'up');
    expect(ids(input)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('preserves every layer and its identity', () => {
    const moved = moveLayer(stack, 'b', 'up')!;
    expect(moved).toHaveLength(stack.length);
    expect([...ids(moved)].sort()).toEqual([...ids(stack)].sort());
    expect(moved.find((l) => l.id === 'b')).toBe(stack[1]);
  });

  it('walks a layer all the way from the bottom to the top', () => {
    let layers: { id: string }[] = stack;
    for (let i = 0; i < 3; i += 1) layers = moveLayer(layers, 'a', 'up')!;
    expect(ids(layers)).toEqual(['b', 'c', 'd', 'a']);
    expect(ids(topFirst(layers))[0]).toBe('a');
    expect(moveLayer(layers, 'a', 'up')).toBeNull();
  });
});

describe('reorderedDocument', () => {
  /** A three-layer document, bottom-to-top. */
  function doc3() {
    const doc = emptyDocument('reorder');
    return {
      ...doc,
      layerStack: {
        ...doc.layerStack,
        layers: [...doc.layerStack.layers, emptyLayer('Middle'), emptyLayer('Top')],
      },
    };
  }

  it('moves the layer and leaves every other field alone', () => {
    const before = doc3();
    const target = before.layerStack.layers[0].id;
    const after = reorderedDocument(before, target, 'up')!;
    expect(ids(after.layerStack.layers)).toEqual([
      before.layerStack.layers[1].id,
      target,
      before.layerStack.layers[2].id,
    ]);
    expect(after.id).toBe(before.id);
    expect(after.name).toBe(before.name);
    expect(after.layerStack.activeLayerId).toBe(before.layerStack.activeLayerId);
  });

  it('keeps each layer graph attached to its own layer', () => {
    const before = doc3();
    const target = before.layerStack.layers[2];
    const after = reorderedDocument(before, target.id, 'down')!;
    expect(after.layerStack.layers.find((l) => l.id === target.id)!.graph).toBe(target.graph);
  });

  it('stamps meta.updated, because a reorder is an edit', () => {
    const before = doc3();
    const after = reorderedDocument(before, before.layerStack.layers[0].id, 'up')!;
    expect(Date.parse(after.meta.updated)).toBeGreaterThanOrEqual(Date.parse(before.meta.updated));
    expect(after.meta.created).toBe(before.meta.created);
  });

  it('does not mutate the document it was given', () => {
    const before = doc3();
    const order = ids(before.layerStack.layers);
    reorderedDocument(before, before.layerStack.layers[0].id, 'up');
    expect(ids(before.layerStack.layers)).toEqual(order);
  });

  it('returns null at the ends of the stack and for unknown ids', () => {
    const doc = doc3();
    expect(reorderedDocument(doc, doc.layerStack.layers[0].id, 'down')).toBeNull();
    expect(reorderedDocument(doc, doc.layerStack.layers[2].id, 'up')).toBeNull();
    expect(reorderedDocument(doc, 'nope', 'up')).toBeNull();
  });

  it('survives a JSON round-trip after reordering', () => {
    const doc = doc3();
    const after = reorderedDocument(doc, doc.layerStack.layers[0].id, 'up')!;
    expect(JSON.parse(JSON.stringify(after))).toEqual(after);
  });
});
