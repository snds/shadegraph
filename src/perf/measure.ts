// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Statistical performance budget: real GPU measurement
// ───────────────────────────────────────────────────────────────────────────
// Step 2 of the generate → measure → aggregate pipeline, and the ONLY module
// in `src/perf/` that touches a renderer. Per the Phase 4 sketch's SETTLED
// decision: CPU-observed wall-clock timing with a forced sync point —
// `performance.now()` bracketing the render, plus a cheap pixel readback
// immediately after so the window reflects real GPU completion, not just
// draw-call submission. Explicitly NOT GPU timer-query extensions (unreliable
// across browsers/drivers) and NOT a uniform/pass-count proxy (too indirect).
//
// This WRAPS the existing preview renderer through its PUBLIC surface only
// (`createPreviewRenderer`, `PreviewRenderer.setDocument`/`setRig`, and the
// `<canvas>` element the caller already owns) — it never reaches into
// `PreviewRenderer`'s internals or touches its continuous requestAnimationFrame
// render loop directly. `variants.ts`/`runBudget.ts`/`aggregate.ts` never
// import this file; the real app wires it in (see `src/ui/perf/PerfPanel.tsx`)
// as the `MeasureFn` those modules only ever see as an injected function.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShaderDocument } from '../model/document';
import { createPreviewRenderer } from '../preview/renderer';
import type { TargetLang } from '../compiler/backend';
import type { MeasureFn } from './runBudget';

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** A cheap 1×1 `readPixels` (or, when no WebGL2 context exists on this
 *  canvas — the `wgsl`/WebGPU target's own stacked canvas — a `toDataURL`
 *  encode) forces the CPU to block until every GPU command submitted so far
 *  has actually completed. `canvas.getContext('webgl2')` returns the SAME
 *  context `createThreeRenderer` already created inside
 *  `createPreviewRenderer` (a canvas only ever hands out one context
 *  instance per type) — this never creates a second, competing context. */
function forceGpuSync(canvas: HTMLCanvasElement): void {
  const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
  if (gl) {
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    return;
  }
  canvas.toDataURL();
}

export interface GpuMeasureOptions {
  /** Which backend to measure against. Defaults to `'glsl-es'` — the
   *  `PreviewRenderer`'s own default target, and the one `forceGpuSync`'s
   *  `readPixels` path is written for. */
  target?: TargetLang;
  /** How many real animation frames to let elapse between binding a variant
   *  and forcing the sync point. `PreviewRenderer`'s bound `GpuBinding` runs
   *  a continuous `requestAnimationFrame` loop (see renderer.ts) that this
   *  module deliberately never calls into directly — waiting `settleFrames`
   *  real frames is the smallest public-surface guarantee that the
   *  just-bound program has actually been drawn. Defaults to 2. */
  settleFrames?: number;
}

export interface GpuMeasureFn {
  /** Injectable into `runPerformanceBudget` as its `MeasureFn`. */
  measure: MeasureFn;
  /** Disposes the one `PreviewRenderer`/GPU context this run created. Always
   *  call this when the run (successful or not) is done. */
  dispose: () => void;
}

/**
 * Builds a real, renderer-backed `MeasureFn` bound to `canvas` — a fresh
 * canvas the caller owns for the lifetime of one budget run (see
 * `src/ui/perf/PerfPanel.tsx`), never the main viewer's canvas: a budget run
 * must not visibly disrupt whatever the user is looking at.
 */
export function createGpuMeasureFn(canvas: HTMLCanvasElement, options: GpuMeasureOptions = {}): GpuMeasureFn {
  const settleFrames = Math.max(1, options.settleFrames ?? 2);
  const renderer = createPreviewRenderer(canvas);
  if (options.target) renderer.setTarget(options.target);

  const measure: MeasureFn = async (document: ShaderDocument) => {
    renderer.setRig(document.previewRig);
    const start = performance.now();
    // Real topology-changed variants recompile here; a value-only variant
    // (the common case — most `variationRanges` entries vary a dial, not a
    // node/edge) just pushes a bound uniform write instead. Either way this
    // is the SAME public entry point the main viewer itself drives edits
    // through — nothing renderer-internal is called directly.
    renderer.setDocument(document);
    for (let i = 0; i < settleFrames; i++) {
      await nextAnimationFrame();
    }
    forceGpuSync(canvas);
    return performance.now() - start;
  };

  return { measure, dispose: () => renderer.dispose() };
}
