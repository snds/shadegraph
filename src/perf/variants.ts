// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Statistical performance budget: variant generation
// ───────────────────────────────────────────────────────────────────────────
// Step 1 of the generate → measure → aggregate pipeline (Phase 4 sketch,
// "Statistical performance budget"). Given a base document and
// `PerformanceBudgetPopulationConfig.variationRanges` (keyed by an EXPOSED
// blackboard param id — see `src/ui/inspector/blackboard.ts`'s
// `collectExposedParams`), samples each range `population.size` times and
// returns that many document variants that differ from the base document
// ONLY in those params' values.
//
// Pure data in, pure data out — no renderer, no DOM, no randomness beyond an
// injectable `RandomFn` — so this is fully unit-testable without a real GPU
// (the Definition of Done's explicit requirement) and deterministic under a
// seeded random function in tests.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeParam, ShaderDocument } from '../model/document';
import { mapLeafLayers } from '../model/layerTree';
import type { PerformanceBudgetPopulationConfig, VariationRanges } from '../model/settings';

/** Uniform sample in `[0, 1)`, same contract as `Math.random`. Injectable so
 *  tests get deterministic, reproducible variants instead of real noise. */
export type RandomFn = () => number;

function isNumericParamType(type: NodeParam['type']): boolean {
  return type === 'float' || type === 'int';
}

function sampleRange([min, max]: [number, number], random: RandomFn): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return min;
  if (max <= min) return min;
  return min + (max - min) * random();
}

/**
 * Returns a NEW document with every EXPOSED param whose id appears in
 * `values` set to that value — every other param, node, layer, and the
 * blackboard's own non-matching entries are left byte-for-byte identical
 * (same references, not just equal-by-value), so a variant only diffs from
 * `doc` where the population config actually asked it to.
 *
 * Only numeric (`float`/`int`) params are ever written — a `variationRanges`
 * entry naming a vec3/color/bool param is silently ignored rather than
 * stuffing a raw number into a field the compiler expects to be a tuple or
 * boolean.
 */
export function applyVariantValues(doc: ShaderDocument, values: Record<string, number>): ShaderDocument {
  const ids = Object.keys(values);
  if (ids.length === 0) return doc;

  const layers = mapLeafLayers(doc.layerStack.layers, (layer) => {
    let layerChanged = false;
    const nodes = layer.graph.nodes.map((node) => {
      let nodeChanged = false;
      const params = node.params.map((param) => {
        if (!param.exposed || !(param.id in values) || !isNumericParamType(param.type)) return param;
        nodeChanged = true;
        return { ...param, value: values[param.id] };
      });
      if (!nodeChanged) return node;
      layerChanged = true;
      return { ...node, params };
    });
    if (!layerChanged) return layer;
    return { ...layer, graph: { ...layer.graph, nodes } };
  });
  const layersChanged = layers !== doc.layerStack.layers;

  let blackboardChanged = false;
  const blackboard = doc.blackboard.map((param) => {
    if (!(param.id in values) || !isNumericParamType(param.type)) return param;
    blackboardChanged = true;
    return { ...param, value: values[param.id] };
  });

  if (!layersChanged && !blackboardChanged) return doc;
  return {
    ...doc,
    layerStack: layersChanged ? { ...doc.layerStack, layers } : doc.layerStack,
    blackboard: blackboardChanged ? blackboard : doc.blackboard,
  };
}

/** One generated variant: which values were sampled (for the report/UI to
 *  label a sample by) plus the resulting document to actually measure. */
export interface VariantSample {
  /** 0-based position in the generated population. */
  index: number;
  /** The sampled value per varied param id — empty when `variationRanges` is
   *  empty (every variant is then just the base document, `size` times). */
  values: Record<string, number>;
  document: ShaderDocument;
}

function sampleValues(ranges: VariationRanges, random: RandomFn): Record<string, number> {
  const values: Record<string, number> = {};
  for (const [paramId, range] of Object.entries(ranges)) {
    values[paramId] = sampleRange(range, random);
  }
  return values;
}

/**
 * Samples `population.variationRanges` `population.size` times, producing
 * that many document variants. `random` defaults to `Math.random` for real
 * runs; tests inject a seeded/fixed function for reproducibility.
 */
export function generateVariants(
  baseDoc: ShaderDocument,
  population: PerformanceBudgetPopulationConfig,
  random: RandomFn = Math.random,
): VariantSample[] {
  const size = Math.max(0, Math.floor(population.size));
  const variants: VariantSample[] = [];
  for (let index = 0; index < size; index++) {
    const values = sampleValues(population.variationRanges, random);
    variants.push({ index, values, document: applyVariantValues(baseDoc, values) });
  }
  return variants;
}
