import { describe, expect, it } from 'vitest';

import {
  applyHex,
  asScalarOrVector,
  clampToParam,
  componentLabels,
  decimalsFor,
  formatNumber,
  formatParamValue,
  hexToRgb,
  parseNumber,
  rgbToHex,
  setComponent,
  toBoolean,
  toNumber,
  toText,
  toVector,
  vectorArity,
} from './paramValues';

describe('vectorArity / componentLabels', () => {
  it('maps every param type to a field count', () => {
    expect(vectorArity('float')).toBe(1);
    expect(vectorArity('int')).toBe(1);
    expect(vectorArity('bool')).toBe(1);
    expect(vectorArity('vec2')).toBe(2);
    expect(vectorArity('vec3')).toBe(3);
    expect(vectorArity('color')).toBe(3);
    expect(vectorArity('normal')).toBe(3);
    expect(vectorArity('vec4')).toBe(4);
  });

  it('labels colours R/G/B and everything else X/Y/Z/W', () => {
    expect(componentLabels('color')).toEqual(['R', 'G', 'B']);
    expect(componentLabels('vec2')).toEqual(['X', 'Y']);
    expect(componentLabels('vec4')).toEqual(['X', 'Y', 'Z', 'W']);
  });
});

describe('coercion', () => {
  it('toNumber survives every value shape', () => {
    expect(toNumber(2.5)).toBe(2.5);
    expect(toNumber(true)).toBe(1);
    expect(toNumber(false)).toBe(0);
    expect(toNumber('3.5')).toBe(3.5);
    expect(toNumber('not a number', 7)).toBe(7);
    expect(toNumber('', 7)).toBe(7);
    expect(toNumber([4, 5], 0)).toBe(4);
    expect(toNumber(Number.NaN, 9)).toBe(9);
  });

  it('toBoolean treats 0 / "" / "false" as off', () => {
    expect(toBoolean(true)).toBe(true);
    expect(toBoolean(1)).toBe(true);
    expect(toBoolean(0)).toBe(false);
    expect(toBoolean('false')).toBe(false);
    expect(toBoolean('0')).toBe(false);
    expect(toBoolean('tex-1')).toBe(true);
    expect(toBoolean([1, 1])).toBe(false);
  });

  it('toText round-trips asset ids and prints tuples', () => {
    expect(toText('asset-42')).toBe('asset-42');
    expect(toText([1, 0.5])).toBe('1, 0.5');
    expect(toText(3)).toBe('3');
  });

  it('toVector pads, truncates and splats to the requested arity', () => {
    expect(toVector([1, 2, 3], 3)).toEqual([1, 2, 3]);
    expect(toVector([1, 2], 3)).toEqual([1, 2, 0]);
    expect(toVector([1, 2, 3, 4], 2)).toEqual([1, 2]);
    expect(toVector(0.5, 3)).toEqual([0.5, 0.5, 0.5]);
    expect(toVector('nope', 2)).toEqual([0, 0]);
    expect(toVector([1, Number.NaN, 3], 3)).toEqual([1, 0, 3]);
  });

  it('asScalarOrVector narrows back to the model tuples', () => {
    expect(asScalarOrVector([1])).toBe(1);
    expect(asScalarOrVector([1, 2])).toEqual([1, 2]);
    expect(asScalarOrVector([1, 2, 3])).toEqual([1, 2, 3]);
    expect(asScalarOrVector([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
  });

  it('setComponent is immutable and ignores out-of-range indexes', () => {
    const source = [1, 2, 3];
    expect(setComponent(source, 1, 9)).toEqual([1, 9, 3]);
    expect(source).toEqual([1, 2, 3]);
    expect(setComponent(source, 5, 9)).toBe(source);
    expect(setComponent(source, -1, 9)).toBe(source);
  });
});

describe('numeric entry', () => {
  it('clamps to the declared range', () => {
    const p = { type: 'float', min: 0, max: 1 } as const;
    expect(clampToParam(0.5, p)).toBe(0.5);
    expect(clampToParam(-3, p)).toBe(0);
    expect(clampToParam(42, p)).toBe(1);
  });

  it('rounds int params (octaves cannot be 3.7)', () => {
    const octaves = { type: 'int', min: 1, max: 8 } as const;
    expect(clampToParam(3.7, octaves)).toBe(4);
    expect(clampToParam(0.2, octaves)).toBe(1);
    expect(clampToParam(99, octaves)).toBe(8);
  });

  it('leaves an unbounded param alone', () => {
    expect(clampToParam(-1234.5, { type: 'float' })).toBe(-1234.5);
  });

  it('parseNumber rejects junk so the field can revert', () => {
    expect(parseNumber('1.25')).toBe(1.25);
    expect(parseNumber(' -3 ')).toBe(-3);
    expect(parseNumber('')).toBeNull();
    expect(parseNumber('   ')).toBeNull();
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('Infinity')).toBeNull();
  });

  it('derives display decimals from the step', () => {
    expect(decimalsFor(1)).toBe(0);
    expect(decimalsFor(0.01)).toBe(2);
    expect(decimalsFor(0.001)).toBe(3);
    expect(decimalsFor(undefined)).toBe(6);
  });

  it('formats without float noise or trailing zeros', () => {
    expect(formatNumber(0.1 + 0.2, 0.01)).toBe('0.3');
    expect(formatNumber(4, 1)).toBe('4');
    expect(formatNumber(3.7, 1)).toBe('4');
    expect(formatNumber(2.5, 0.001)).toBe('2.5');
    expect(formatNumber(Number.NaN)).toBe('0');
  });
});

describe('colour', () => {
  it('converts 0..1 channels to hex and back', () => {
    expect(rgbToHex([0, 0, 0])).toBe('#000000');
    expect(rgbToHex([1, 1, 1])).toBe('#ffffff');
    expect(rgbToHex([1, 0, 0])).toBe('#ff0000');
    expect(hexToRgb('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToRgb('#000')).toEqual([0, 0, 0]);
    expect(hexToRgb('ff0000')).toEqual([1, 0, 0]);
  });

  it('clamps out-of-gamut channels rather than emitting bad hex', () => {
    expect(rgbToHex([2, -1, 0.5])).toBe('#ff0080');
    expect(rgbToHex([])).toBe('#000000');
  });

  it('rejects malformed hex', () => {
    expect(hexToRgb('#gggggg')).toBeNull();
    expect(hexToRgb('#ff')).toBeNull();
    expect(hexToRgb('')).toBeNull();
  });

  it('preserves alpha when a vec4 colour is edited', () => {
    expect(applyHex([0, 0, 0, 0.25], '#ffffff')).toEqual([1, 1, 1, 0.25]);
    expect(applyHex([0, 0, 0], '#ff0000')).toEqual([1, 0, 0]);
    expect(applyHex([0, 0, 0], 'nope')).toBeNull();
  });
});

describe('formatParamValue', () => {
  it('renders each value shape for the read-only blackboard row', () => {
    expect(formatParamValue({ value: 0.5, step: 0.01 })).toBe('0.5');
    expect(formatParamValue({ value: [1, 0, 0] })).toBe('1, 0, 0');
    expect(formatParamValue({ value: true })).toBe('on');
    expect(formatParamValue({ value: false })).toBe('off');
    expect(formatParamValue({ value: 'asset-1' })).toBe('asset-1');
    expect(formatParamValue({ value: '' })).toBe('—');
  });
});
