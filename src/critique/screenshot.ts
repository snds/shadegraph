// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique: main-viewer render capture
// ───────────────────────────────────────────────────────────────────────────
// Captures whatever is CURRENTLY on the main viewer's canvas via
// `canvas.toDataURL()` — no new rendering path, per the task's explicit
// requirement. This module never imports `src/preview/renderer.ts` or
// touches `PreviewRenderer`/`PreviewScheduler` internals; it only reads back
// pixels already drawn to the one `<canvas className="sg-viewer__canvas">`
// `MainViewer.tsx` renders (see that file — untouched by this task).
//
// `MainViewer`/`renderer.ts`'s dual-backend GLSL⇄WGSL switch (see
// `createDualBackendGpuBinding` in `renderer.ts`) keeps BOTH canvases
// mounted side by side under that same class name and toggles which one is
// `display: none` — so "the current render" means whichever one of them is
// NOT hidden, not simply "the first element with this class name".
// `pickVisibleCanvas` below is the pure piece of that logic, split out so
// it is unit-testable without a real DOM.
// ═══════════════════════════════════════════════════════════════════════════

import { CritiqueError } from './errors';
import type { StillImage } from './types';

export const MAIN_VIEWER_CANVAS_SELECTOR = '.sg-viewer__canvas';

/** The minimal `HTMLCanvasElement` slice this module needs — narrow enough
 *  that a plain test fixture can satisfy it without a real DOM `Canvas`. */
export interface CanvasLike {
  toDataURL(type?: string): string;
}

/** Of several candidate canvases sharing the main-viewer's class name,
 *  returns the one that is actually visible (`style.display !== 'none'`) —
 *  `undefined` if every candidate is hidden or the list is empty. Picks the
 *  FIRST visible one; `renderer.ts` never shows more than one at a time, so
 *  in practice there is only ever zero or one match. */
export function pickVisibleCanvas<T extends { style: { display: string } }>(candidates: T[]): T | undefined {
  return candidates.find((candidate) => candidate.style.display !== 'none');
}

/** Reads back whatever is currently drawn to `canvas` as a `StillImage`.
 *  Throws `invalid-still` if the canvas refuses to encode (e.g. a tainted
 *  canvas from a cross-origin draw, or zero-size backing store) rather than
 *  returning a useless empty/garbage data URL silently. */
export function captureCanvasStill(canvas: CanvasLike, label: string, mimeType = 'image/png'): StillImage {
  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL(mimeType);
  } catch {
    throw new CritiqueError('invalid-still', 'Could not read back the canvas — it may be tainted or empty.');
  }
  if (!dataUrl.startsWith('data:')) {
    throw new CritiqueError('invalid-still', 'Could not read back the canvas — it may be tainted or empty.');
  }
  return { dataUrl, label };
}

/** The glue this module exists for: find the currently-visible main-viewer
 *  canvas in `root` and capture it. Thin by design — the two functions above
 *  hold all the logic worth testing without a DOM; this just wires them to
 *  `document`. */
export function captureMainViewerStill(root: ParentNode = document): StillImage {
  const candidates = Array.from(root.querySelectorAll<HTMLCanvasElement>(MAIN_VIEWER_CANVAS_SELECTOR));
  const canvas = pickVisibleCanvas(candidates);
  if (!canvas) {
    throw new CritiqueError(
      'missing-render',
      'No visible main-viewer canvas found — is the app currently rendering a document?',
    );
  }
  return captureCanvasStill(canvas, 'Current render');
}
