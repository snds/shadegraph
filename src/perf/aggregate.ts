// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Statistical performance budget: aggregation
// ───────────────────────────────────────────────────────────────────────────
// Step 3 of the generate → measure → aggregate pipeline. Turns a flat list of
// per-variant frame-time samples (milliseconds, wall-clock, already
// GPU-sync-forced by whatever measured them — see `measure.ts`) into a
// worst-case + percentile distribution, and a pass/fail verdict against
// `PerformanceBudgetConfig.targetMsPerFrame`.
//
// The verdict is against WORST-CASE, not the mean/p50 — a budget exists to
// catch the "one nasty combination of dial values" case (Phase 4 sketch: "a
// cheap-looking chunk with an expensive loop... can cost far more than a
// uniform-heavy but trivial one"), so passing on average while spiking past
// the target on the worst sample is still a fail.
//
// Pure math, no renderer/DOM — unit-testable with hand-written sample arrays.
// ═══════════════════════════════════════════════════════════════════════════

/** One variant's measured frame time. `index` matches the originating
 *  `VariantSample.index` from `variants.ts`, for labelling in the UI. */
export interface PerfSample {
  index: number;
  ms: number;
}

export interface PercentileStats {
  best: number;
  p50: number;
  p95: number;
  worst: number;
  mean: number;
}

export interface PerformanceBudgetReport {
  targetMsPerFrame: number;
  sampleCount: number;
  stats: PercentileStats;
  /** `true` only when at least one sample exists AND the worst sample is
   *  within budget. An empty population never "passes" silently. */
  pass: boolean;
  /** Preserved in ORIGINAL (generation) order, not sorted, so the UI can
   *  still say "variant 3 was the worst one". */
  samples: PerfSample[];
}

const EMPTY_STATS: PercentileStats = { best: 0, p50: 0, p95: 0, worst: 0, mean: 0 };

/** Linear-interpolated percentile (the same "nearest-rank with interpolation"
 *  convention as numpy's default) over an ALREADY ascending-sorted array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedAsc[lower];
  const weight = rank - lower;
  return sortedAsc[lower] * (1 - weight) + sortedAsc[upper] * weight;
}

/** Given the measured samples for a run, computes the percentile distribution
 *  and the pass/fail verdict against `targetMsPerFrame`. */
export function aggregateSamples(samples: PerfSample[], targetMsPerFrame: number): PerformanceBudgetReport {
  if (samples.length === 0) {
    return { targetMsPerFrame, sampleCount: 0, stats: EMPTY_STATS, pass: false, samples: [] };
  }

  const sortedAsc = samples.map((s) => s.ms).sort((a, b) => a - b);
  const stats: PercentileStats = {
    best: sortedAsc[0],
    p50: percentile(sortedAsc, 50),
    p95: percentile(sortedAsc, 95),
    worst: sortedAsc[sortedAsc.length - 1],
    mean: sortedAsc.reduce((sum, v) => sum + v, 0) / sortedAsc.length,
  };

  return {
    targetMsPerFrame,
    sampleCount: samples.length,
    stats,
    pass: stats.worst <= targetMsPerFrame,
    samples,
  };
}
