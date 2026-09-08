import { describe, expect, it } from 'vitest';

import { captureCanvasStill, pickVisibleCanvas } from './screenshot';
import { CritiqueError } from './errors';

function fakeCanvas(display: string, dataUrl: string | (() => string)) {
  return {
    style: { display },
    toDataURL: (_type?: string) => (typeof dataUrl === 'function' ? dataUrl() : dataUrl),
  };
}

describe('pickVisibleCanvas', () => {
  it('returns undefined for an empty list', () => {
    expect(pickVisibleCanvas([])).toBeUndefined();
  });

  it('picks the one candidate whose display is not "none"', () => {
    const hidden = fakeCanvas('none', 'data:image/png;base64,AAAA');
    const visible = fakeCanvas('block', 'data:image/png;base64,BBBB');
    expect(pickVisibleCanvas([hidden, visible])).toBe(visible);
  });

  it('treats an unset (empty string) display as visible', () => {
    const unset = fakeCanvas('', 'data:image/png;base64,AAAA');
    expect(pickVisibleCanvas([unset])).toBe(unset);
  });

  it('returns undefined when every candidate is hidden', () => {
    const a = fakeCanvas('none', 'data:image/png;base64,AAAA');
    const b = fakeCanvas('none', 'data:image/png;base64,BBBB');
    expect(pickVisibleCanvas([a, b])).toBeUndefined();
  });
});

describe('captureCanvasStill', () => {
  it('wraps a canvas data URL into a StillImage with the given label', () => {
    const canvas = fakeCanvas('block', 'data:image/png;base64,AAAA');
    expect(captureCanvasStill(canvas, 'Current render')).toEqual({
      dataUrl: 'data:image/png;base64,AAAA',
      label: 'Current render',
    });
  });

  it('throws invalid-still when toDataURL returns something that is not a data URL', () => {
    const canvas = fakeCanvas('block', '');
    expect(() => captureCanvasStill(canvas, 'x')).toThrow(CritiqueError);
    try {
      captureCanvasStill(canvas, 'x');
    } catch (err) {
      expect((err as CritiqueError).kind).toBe('invalid-still');
    }
  });

  it('throws invalid-still (not the raw error) when toDataURL throws (tainted canvas)', () => {
    const canvas = fakeCanvas('block', () => {
      throw new DOMException('tainted', 'SecurityError');
    });
    expect(() => captureCanvasStill(canvas, 'x')).toThrow(CritiqueError);
  });
});
