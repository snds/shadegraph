import { describe, expect, it, vi } from 'vitest';

import { emptyDocument, type NodeParam, type ShaderDocument, type ShaderLayer } from '../model/document';
import type { MeasureFn } from './runBudget';
import { runPerformanceBudget } from './runBudget';

function withParam(doc: ShaderDocument, param: NodeParam): ShaderDocument {
  const [layer] = doc.layerStack.layers as ShaderLayer[];
  const [node] = layer.graph.nodes;
  return {
    ...doc,
    layerStack: {
      ...doc.layerStack,
      layers: [{ ...layer, graph: { ...layer.graph, nodes: [{ ...node, params: [...node.params, param] }] } }],
    },
  };
}

function docWithExposedFloat(id: string): ShaderDocument {
  return withParam(emptyDocument(), { id, label: id, type: 'float', value: 0, ui: 'slider', exposed: true });
}

describe('runPerformanceBudget', () => {
  it('exercises the full generate -> measure -> aggregate pipeline with an injected fake measurer', async () => {
    const doc = docWithExposedFloat('seed');
    // A fake `MeasureFn` that never touches a renderer at all — the pipeline
    // never knows the difference, proving it is unit-testable without a real
    // GPU (the Definition of Done's explicit requirement).
    const measure: MeasureFn = vi.fn(async (_document, sample) => 5 + sample.values.seed! * 10);

    const report = await runPerformanceBudget(
      doc,
      { targetMsPerFrame: 16.67, population: { size: 4, variationRanges: { seed: [0, 1] } } },
      measure,
      { random: () => 0.5, warmup: false },
    );

    expect(report.sampleCount).toBe(4);
    // random fixed at 0.5 => every variant's seed == 0.5 => every ms == 10
    expect(report.samples.map((s) => s.ms)).toEqual([10, 10, 10, 10]);
    expect(report.stats.worst).toBe(10);
    expect(report.pass).toBe(true);
    expect(measure).toHaveBeenCalledTimes(4);
  });

  it('produces genuinely varying measurements from varying sampled values (not a constant)', async () => {
    const doc = docWithExposedFloat('load');
    const measure: MeasureFn = vi.fn(async (_document, sample) => sample.values.load! * 20);
    let call = 0;
    const random = () => [0, 0.3, 0.6, 0.9][call++];

    const report = await runPerformanceBudget(
      doc,
      { targetMsPerFrame: 100, population: { size: 4, variationRanges: { load: [0, 10] } } },
      measure,
      { random, warmup: false },
    );

    const ms = report.samples.map((s) => s.ms);
    expect(new Set(ms).size).toBeGreaterThan(1);
    expect(ms).toEqual([0, 60, 120, 180]);
    expect(report.stats.worst).toBe(180);
  });

  it('measures the base document once as a discarded warm-up by default', async () => {
    const doc = docWithExposedFloat('seed');
    const calls: ShaderDocument[] = [];
    const measure: MeasureFn = vi.fn(async (document) => {
      calls.push(document);
      return 1;
    });

    const report = await runPerformanceBudget(
      doc,
      { targetMsPerFrame: 16.67, population: { size: 2, variationRanges: { seed: [0, 1] } } },
      measure,
    );

    expect(measure).toHaveBeenCalledTimes(3); // 1 warm-up + 2 reported
    expect(calls[0]).toBe(doc); // warm-up measures the unmodified base doc
    expect(report.sampleCount).toBe(2); // warm-up result never enters the report
  });

  it('skips the warm-up call when explicitly disabled', async () => {
    const doc = docWithExposedFloat('seed');
    const measure: MeasureFn = vi.fn(async () => 1);

    await runPerformanceBudget(
      doc,
      { targetMsPerFrame: 16.67, population: { size: 3, variationRanges: { seed: [0, 1] } } },
      measure,
      { warmup: false },
    );

    expect(measure).toHaveBeenCalledTimes(3);
  });

  it('reports progress after each measured (non-warm-up) sample', async () => {
    const doc = docWithExposedFloat('seed');
    const measure: MeasureFn = vi.fn(async () => 1);
    const progress: Array<[number, number]> = [];

    await runPerformanceBudget(
      doc,
      { targetMsPerFrame: 16.67, population: { size: 3, variationRanges: { seed: [0, 1] } } },
      measure,
      { warmup: false, onProgress: (completed, total) => progress.push([completed, total]) },
    );

    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('falls back to a single-sample population when config.population is omitted', async () => {
    const doc = emptyDocument();
    const measure: MeasureFn = vi.fn(async () => 7);

    const report = await runPerformanceBudget(doc, { targetMsPerFrame: 16.67 }, measure, { warmup: false });

    expect(report.sampleCount).toBe(1);
    expect(report.samples[0].ms).toBe(7);
  });

  it('measures variants sequentially, never overlapping two in-flight calls', async () => {
    const doc = docWithExposedFloat('seed');
    let inFlight = 0;
    let maxInFlight = 0;
    const measure: MeasureFn = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight--;
      return 1;
    };

    await runPerformanceBudget(
      doc,
      { targetMsPerFrame: 16.67, population: { size: 5, variationRanges: { seed: [0, 1] } } },
      measure,
      { warmup: false },
    );

    expect(maxInFlight).toBe(1);
  });
});
