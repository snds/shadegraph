// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Statistical performance budget: public surface
// ───────────────────────────────────────────────────────────────────────────
// Barrel for the whole `src/perf/` pipeline (generate → measure → aggregate),
// so `src/ui/perf/` (and any future consumer) imports one module instead of
// reaching into each file individually.
// ═══════════════════════════════════════════════════════════════════════════

export { applyVariantValues, generateVariants, type RandomFn, type VariantSample } from './variants';
export { aggregateSamples, type PercentileStats, type PerfSample, type PerformanceBudgetReport } from './aggregate';
export { runPerformanceBudget, type MeasureFn, type RunPerformanceBudgetOptions } from './runBudget';
export { createGpuMeasureFn, type GpuMeasureFn, type GpuMeasureOptions } from './measure';
