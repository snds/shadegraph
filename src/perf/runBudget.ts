// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Statistical performance budget: orchestration
// ───────────────────────────────────────────────────────────────────────────
// Wires the three pipeline steps together: `generateVariants` (variants.ts)
// → an injected `MeasureFn` → `aggregateSamples` (aggregate.ts). The
// measurement step is a plain injected function, never imported directly by
// this module — that is what makes `runPerformanceBudget` fully
// unit-testable without a real renderer (Definition of Done): tests pass a
// synchronous/fake `MeasureFn`, the real app wires `measure.ts`'s real
// GPU-backed one.
//
// Samples are measured SEQUENTIALLY (`await` in a loop, never
// `Promise.all`), deliberately: the real measurement function drives ONE
// shared preview renderer/canvas per run (see `measure.ts`), and overlapping
// two variants' render+sync windows would corrupt both measurements.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShaderDocument } from '../model/document';
import type { PerformanceBudgetConfig } from '../model/settings';
import { aggregateSamples, type PerfSample, type PerformanceBudgetReport } from './aggregate';
import { generateVariants, type RandomFn, type VariantSample } from './variants';

/** Measures ONE document's real render cost, in milliseconds. Called once
 *  per generated variant (plus an optional warm-up call — see below). The
 *  real implementation (`measure.ts`'s `createGpuMeasureFn`) brackets the
 *  actual render call with `performance.now()` and a forced GPU sync point;
 *  tests inject a fake that never touches a renderer at all. */
export type MeasureFn = (
  document: ShaderDocument,
  sample: Pick<VariantSample, 'index' | 'values'>,
) => Promise<number>;

export interface RunPerformanceBudgetOptions {
  /** Injected for deterministic variant generation in tests; real runs use
   *  `Math.random` (variants.ts's default). */
  random?: RandomFn;
  /** Fires after each variant is measured: `(completed, total)`. */
  onProgress?: (completed: number, total: number) => void;
  /** Measure the UNCHANGED base document once first and discard the result,
   *  before any reported sample. A document's FIRST real render triggers a
   *  one-time shader compile (`PreviewRenderer.recompile`) that has nothing
   *  to do with steady-state per-frame cost; without this, sample 0 would be
   *  skewed high by a cost every other sample never pays. Defaults to
   *  `true`; population.size === 0 or empty variation ranges still benefit
   *  from a real, non-fake `measure`. */
  warmup?: boolean;
}

/** Runs the full generate → measure → aggregate pipeline for one budget
 *  check and returns the resulting report. */
export async function runPerformanceBudget(
  baseDoc: ShaderDocument,
  config: PerformanceBudgetConfig,
  measure: MeasureFn,
  options: RunPerformanceBudgetOptions = {},
): Promise<PerformanceBudgetReport> {
  const population = config.population ?? { size: 1, variationRanges: {} };
  const variants = generateVariants(baseDoc, population, options.random);

  if (options.warmup ?? true) {
    await measure(baseDoc, { index: -1, values: {} });
  }

  const samples: PerfSample[] = [];
  for (const variant of variants) {
    const ms = await measure(variant.document, { index: variant.index, values: variant.values });
    samples.push({ index: variant.index, ms });
    options.onProgress?.(samples.length, variants.length);
  }

  return aggregateSamples(samples, config.targetMsPerFrame);
}
