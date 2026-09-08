// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Statistical performance budget panel
// ───────────────────────────────────────────────────────────────────────────
// Configures nothing itself (the target/population live in `ProjectSettings`,
// edited from the Settings panel — this pane only READS them via
// `useProjectSettings`) — it triggers one budget run against the CURRENT
// document and displays the resulting report.
//
// `doc` is read via the same stable `useEditorStore((s) => s.doc)` selector
// every other pane uses (`Inspector`/`GraphCanvas`/`MainViewer`): it returns
// the store's own document reference, unchanged unless the document actually
// changes, so this never re-renders on an unrelated store write and never
// trips the "unstable selector" class of bug (a derived/computed object
// returned fresh every call).
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useRef, useState } from 'react';

import { useEditorStore } from '../store';
import { useProjectSettings } from '../settings/useProjectSettings';
import { createGpuMeasureFn } from '../../perf/measure';
import { runPerformanceBudget } from '../../perf/runBudget';
import type { PerformanceBudgetReport } from '../../perf/aggregate';

type RunState =
  | { kind: 'idle' }
  | { kind: 'running'; completed: number; total: number }
  | { kind: 'done'; report: PerformanceBudgetReport }
  | { kind: 'error'; message: string };

function formatMs(ms: number): string {
  return `${ms.toFixed(2)} ms`;
}

function ReportView({ report }: { report: PerformanceBudgetReport }) {
  return (
    <div className="sg-perf__report">
      <p className={report.pass ? 'sg-perf__verdict sg-perf__verdict--pass' : 'sg-perf__verdict sg-perf__verdict--fail'}>
        {report.pass ? 'PASS' : 'FAIL'} — worst {formatMs(report.stats.worst)} vs target{' '}
        {formatMs(report.targetMsPerFrame)}
      </p>
      <dl className="sg-perf__stats">
        <dt>Samples</dt>
        <dd>{report.sampleCount}</dd>
        <dt>Best</dt>
        <dd>{formatMs(report.stats.best)}</dd>
        <dt>p50</dt>
        <dd>{formatMs(report.stats.p50)}</dd>
        <dt>p95</dt>
        <dd>{formatMs(report.stats.p95)}</dd>
        <dt>Worst</dt>
        <dd>{formatMs(report.stats.worst)}</dd>
        <dt>Mean</dt>
        <dd>{formatMs(report.stats.mean)}</dd>
      </dl>
      <details className="sg-perf__samples">
        <summary>Per-variant samples ({report.samples.length})</summary>
        <ul>
          {report.samples.map((s) => (
            <li key={s.index}>
              #{s.index}: {formatMs(s.ms)}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export function PerfPanel() {
  const doc = useEditorStore((s) => s.doc);
  const [settings] = useProjectSettings();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<RunState>({ kind: 'idle' });

  const budget = settings.performanceBudget;
  const running = state.kind === 'running';

  const run = useCallback(async () => {
    if (!budget) {
      setState({ kind: 'error', message: 'No performance budget configured — set a target in Project Settings.' });
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) {
      setState({ kind: 'error', message: 'Measurement canvas is not mounted.' });
      return;
    }

    const total = Math.max(1, budget.population?.size ?? 1);
    setState({ kind: 'running', completed: 0, total });

    const { measure, dispose } = createGpuMeasureFn(canvas);
    try {
      const report = await runPerformanceBudget(doc, budget, measure, {
        onProgress: (completed, totalCount) => setState({ kind: 'running', completed, total: totalCount }),
      });
      setState({ kind: 'done', report });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : 'Performance run failed.' });
    } finally {
      dispose();
    }
  }, [doc, budget]);

  return (
    <div className="sg-perf">
      <h2 className="sg-perf__title">Performance budget</h2>

      {!budget && (
        <p className="sg-perf__hint">
          No budget configured yet — set a target ms/frame and a population in Project Settings, then come back here.
        </p>
      )}
      {budget && (
        <dl className="sg-perf__config">
          <dt>Target</dt>
          <dd>{formatMs(budget.targetMsPerFrame)}</dd>
          <dt>Population</dt>
          <dd>
            {budget.population?.size ?? 0} variants ·{' '}
            {Object.keys(budget.population?.variationRanges ?? {}).length} varied param(s)
          </dd>
        </dl>
      )}

      {/* The one canvas this run's `PreviewRenderer` binds to — a real,
          document-attached (so its `requestAnimationFrame` loop actually
          runs), but visually tiny, off-viewer render target. Never the main
          viewer's canvas: a budget run must not disrupt what the user is
          looking at. */}
      <canvas ref={canvasRef} className="sg-perf__canvas" width={96} height={96} aria-hidden="true" />

      <button type="button" className="sg-perf__run" onClick={() => void run()} disabled={!budget || running}>
        {running ? `Running… ${state.completed}/${state.total}` : 'Run performance budget'}
      </button>

      {state.kind === 'error' && <p className="sg-perf__error">{state.message}</p>}
      {state.kind === 'done' && <ReportView report={state.report} />}
    </div>
  );
}
