import { describe, expect, it } from 'vitest';

import { emptyDocument, type NodeParam, type ShaderDocument } from '../model/document';
import { applyVariantValues, generateVariants } from './variants';

function withParam(doc: ShaderDocument, param: NodeParam): ShaderDocument {
  const [layer] = doc.layerStack.layers;
  const [node] = layer.graph.nodes;
  return {
    ...doc,
    layerStack: {
      ...doc.layerStack,
      layers: [{ ...layer, graph: { ...layer.graph, nodes: [{ ...node, params: [...node.params, param] }] } }],
    },
  };
}

function exposedFloat(id: string, value = 0): NodeParam {
  return { id, label: id, type: 'float', value, ui: 'slider', exposed: true };
}

/** A fixed sequence RNG so tests get exact, reproducible sample values
 *  instead of real noise — same contract `Math.random` has (`[0, 1)`). */
function fixedSequence(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe('applyVariantValues', () => {
  it('sets only the named exposed param, leaving every other field identical', () => {
    let doc = emptyDocument();
    doc = withParam(doc, exposedFloat('seed', 1));
    doc = withParam(doc, exposedFloat('untouched', 5));

    const variant = applyVariantValues(doc, { seed: 42 });
    const [node] = variant.layerStack.layers[0].graph.nodes;

    expect(node.params.find((p) => p.id === 'seed')?.value).toBe(42);
    expect(node.params.find((p) => p.id === 'untouched')?.value).toBe(5);
    // Structural sharing: the untouched param object itself is the same
    // reference, not just deep-equal.
    expect(node.params.find((p) => p.id === 'untouched')).toBe(
      doc.layerStack.layers[0].graph.nodes[0].params.find((p) => p.id === 'untouched'),
    );
  });

  it('ignores a non-exposed param even when its id matches', () => {
    let doc = emptyDocument();
    doc = withParam(doc, { id: 'hidden', label: 'hidden', type: 'float', value: 0, ui: 'slider', exposed: false });

    const variant = applyVariantValues(doc, { hidden: 99 });
    expect(variant.layerStack.layers[0].graph.nodes[0].params[0].value).toBe(0);
  });

  it('ignores a non-numeric exposed param rather than corrupting its value', () => {
    let doc = emptyDocument();
    doc = withParam(doc, {
      id: 'tint',
      label: 'tint',
      type: 'color',
      value: [1, 0, 0],
      ui: 'color',
      exposed: true,
    });

    const variant = applyVariantValues(doc, { tint: 0.5 });
    expect(variant.layerStack.layers[0].graph.nodes[0].params[0].value).toEqual([1, 0, 0]);
  });

  it('varies a document-level (global) blackboard param', () => {
    const doc = { ...emptyDocument(), blackboard: [exposedFloat('globalDial', 0.2)] };
    const variant = applyVariantValues(doc, { globalDial: 0.8 });
    expect(variant.blackboard[0].value).toBe(0.8);
    expect(doc.blackboard[0].value).toBe(0.2); // original untouched
  });

  it('returns the SAME document reference when nothing matches', () => {
    const doc = emptyDocument();
    expect(applyVariantValues(doc, {})).toBe(doc);
    expect(applyVariantValues(doc, { nonexistent: 1 })).toBe(doc);
  });
});

describe('generateVariants', () => {
  it('produces exactly `population.size` variants, each with sampled values in range', () => {
    let doc = emptyDocument();
    doc = withParam(doc, exposedFloat('seed', 0));

    const variants = generateVariants(
      doc,
      { size: 5, variationRanges: { seed: [0, 10] } },
      fixedSequence([0, 0.25, 0.5, 0.75, 1]),
    );

    expect(variants).toHaveLength(5);
    expect(variants.map((v) => v.values.seed)).toEqual([0, 2.5, 5, 7.5, 10]);
    variants.forEach((v, i) => {
      expect(v.index).toBe(i);
      expect(v.document.layerStack.layers[0].graph.nodes[0].params[0].value).toBe(v.values.seed);
    });
  });

  it('varies multiple configured params independently per variant', () => {
    let doc = emptyDocument();
    doc = withParam(doc, exposedFloat('a', 0));
    doc = withParam(doc, exposedFloat('b', 0));

    const variants = generateVariants(
      doc,
      { size: 2, variationRanges: { a: [0, 1], b: [10, 20] } },
      fixedSequence([0, 1, 0.5, 0.5]),
    );

    expect(variants[0].values).toEqual({ a: 0, b: 20 });
    expect(variants[1].values).toEqual({ a: 0.5, b: 15 });
  });

  it('returns an empty array for size 0 and never calls random', () => {
    const doc = emptyDocument();
    let called = false;
    const random = () => {
      called = true;
      return 0;
    };
    expect(generateVariants(doc, { size: 0, variationRanges: {} }, random)).toEqual([]);
    expect(called).toBe(false);
  });

  it('every variant equals the base document when variationRanges is empty', () => {
    let doc = emptyDocument();
    doc = withParam(doc, exposedFloat('seed', 3));

    const variants = generateVariants(doc, { size: 3, variationRanges: {} });
    expect(variants).toHaveLength(3);
    for (const v of variants) {
      expect(v.values).toEqual({});
      expect(v.document).toBe(doc);
    }
  });
});
