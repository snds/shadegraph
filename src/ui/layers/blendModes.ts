// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Blend-mode presentation
// ───────────────────────────────────────────────────────────────────────────
// The blend-mode picker must never drift from `BlendMode` in the model. A
// hand-copied string array would silently go stale the day a mode is added, so
// the options are DERIVED from the union instead: `Record<BlendMode, string>`
// is exhaustive by construction, and `BLEND_MODES` reads its keys back. Add a
// mode to the union and this file stops compiling until it is labelled.
//
// Pure data — no React, no DOM. The model stays unaware that the UI labels its
// modes at all.
// ═══════════════════════════════════════════════════════════════════════════

import type { BlendMode } from '../../model/document';

/** Human label for every blend mode. Exhaustive: TypeScript enforces it. */
export const BLEND_MODE_LABELS: Record<BlendMode, string> = {
  normal: 'Normal',
  add: 'Add',
  multiply: 'Multiply',
  screen: 'Screen',
  overlay: 'Overlay',
  softLight: 'Soft Light',
  subtract: 'Subtract',
  mix: 'Mix',
  height: 'Height',
  custom: 'Custom',
};

/**
 * Every blend mode, in picker order. Read off the exhaustive label record
 * rather than re-listed, so it cannot fall out of sync with the union.
 */
export const BLEND_MODES = Object.keys(BLEND_MODE_LABELS) as BlendMode[];

/** Label for a mode, tolerating a value from a newer/older document. */
export function blendModeLabel(mode: BlendMode | undefined): string {
  return (mode && BLEND_MODE_LABELS[mode]) || String(mode ?? 'normal');
}

/** Narrowing guard for the `<select>`'s untyped `value`. */
export function isBlendMode(value: string): value is BlendMode {
  return Object.prototype.hasOwnProperty.call(BLEND_MODE_LABELS, value);
}
