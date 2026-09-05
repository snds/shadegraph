// The picker's options must stay welded to the `BlendMode` union. Exhaustiveness
// is a compile-time guarantee (`Record<BlendMode, …>`); these tests cover the
// runtime half — the derived list, the guard, and unknown values.

import { describe, expect, it } from 'vitest';

import type { BlendMode } from '../../model/document';
import { BLEND_MODES, BLEND_MODE_LABELS, blendModeLabel, isBlendMode } from './blendModes';

describe('blend modes', () => {
  it('derives the picker list from the exhaustive label record', () => {
    expect(BLEND_MODES).toEqual(Object.keys(BLEND_MODE_LABELS));
  });

  it('lists every mode exactly once', () => {
    expect(new Set(BLEND_MODES).size).toBe(BLEND_MODES.length);
  });

  it('starts with the layer factory default so a new layer needs no scrolling', () => {
    expect(BLEND_MODES[0]).toBe('normal');
  });

  it('labels every mode with a non-empty string', () => {
    for (const mode of BLEND_MODES) expect(BLEND_MODE_LABELS[mode]).toMatch(/\S/);
  });

  it('never returns an empty label, even for an unknown mode', () => {
    expect(blendModeLabel('softLight')).toBe('Soft Light');
    expect(blendModeLabel(undefined)).toMatch(/\S/);
    expect(blendModeLabel('nope' as BlendMode)).toMatch(/\S/);
  });

  it('guards select values', () => {
    expect(isBlendMode('multiply')).toBe(true);
    expect(isBlendMode('nope')).toBe(false);
    expect(isBlendMode('toString')).toBe(false);
  });
});
