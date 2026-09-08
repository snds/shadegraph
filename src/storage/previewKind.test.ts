import { describe, expect, it } from 'vitest';

import { previewKindForName } from './previewKind';

describe('previewKindForName', () => {
  it('recognizes common image extensions case-insensitively', () => {
    expect(previewKindForName('photo.PNG')).toBe('image');
    expect(previewKindForName('sprite.webp')).toBe('image');
  });

  it('recognizes common video extensions', () => {
    expect(previewKindForName('clip.mp4')).toBe('video');
    expect(previewKindForName('render.MOV')).toBe('video');
  });

  it('returns undefined for non-previewable or extensionless names', () => {
    expect(previewKindForName('notes.txt')).toBeUndefined();
    expect(previewKindForName('README')).toBeUndefined();
    expect(previewKindForName('trailing.')).toBeUndefined();
  });
});
