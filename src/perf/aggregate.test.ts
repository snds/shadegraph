import { describe, expect, it } from 'vitest';

import { aggregateSamples, type PerfSample } from './aggregate';

function samples(...ms: number[]): PerfSample[] {
  return ms.map((v, index) => ({ index, ms: v }));
}

describe('aggregateSamples', () => {
  it('reports empty stats and a fail verdict for zero samples', () => {
    const report = aggregateSamples([], 16.67);
    expect(report.sampleCount).toBe(0);
    expect(report.pass).toBe(false);
    expect(report.stats).toEqual({ best: 0, p50: 0, p95: 0, worst: 0, mean: 0 });
  });

  it('computes best/worst/mean for a single sample', () => {
    const report = aggregateSamples(samples(12), 16.67);
    expect(report.stats).toEqual({ best: 12, p50: 12, p95: 12, worst: 12, mean: 12 });
    expect(report.pass).toBe(true);
  });

  it('computes worst-case and mean over an unsorted sample set', () => {
    const report = aggregateSamples(samples(10, 30, 20), 16.67);
    expect(report.stats.best).toBe(10);
    expect(report.stats.worst).toBe(30);
    expect(report.stats.mean).toBeCloseTo(20, 5);
    expect(report.sampleCount).toBe(3);
  });

  it('preserves samples in original (unsorted) order for the report', () => {
    const report = aggregateSamples(samples(30, 10, 20), 16.67);
    expect(report.samples.map((s) => s.ms)).toEqual([30, 10, 20]);
  });

  it('interpolates p50/p95 linearly across a larger set', () => {
    // 0..99 ms, ascending — p50 should land near the middle, p95 near the top.
    const ms = Array.from({ length: 100 }, (_, i) => i);
    const report = aggregateSamples(samples(...ms), 1000);
    expect(report.stats.p50).toBeCloseTo(49.5, 5);
    expect(report.stats.p95).toBeCloseTo(94.05, 5);
    expect(report.stats.worst).toBe(99);
  });

  it('fails when the worst sample exceeds the target even if most pass', () => {
    const report = aggregateSamples(samples(5, 5, 5, 5, 40), 16.67);
    expect(report.pass).toBe(false);
    expect(report.stats.worst).toBe(40);
  });

  it('passes when the worst sample is exactly at the target (inclusive boundary)', () => {
    const report = aggregateSamples(samples(16.67, 10), 16.67);
    expect(report.pass).toBe(true);
  });

  it('passes when every sample is comfortably under the target', () => {
    const report = aggregateSamples(samples(4, 6, 8), 16.67);
    expect(report.pass).toBe(true);
  });
});
