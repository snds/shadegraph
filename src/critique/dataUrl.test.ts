import { describe, expect, it } from 'vitest';

import { parseDataUrl } from './dataUrl';
import { CritiqueError } from './errors';

describe('parseDataUrl', () => {
  it('splits a data URL into media type and base64 payload', () => {
    expect(parseDataUrl('data:image/png;base64,AAAA')).toEqual({ mediaType: 'image/png', base64: 'AAAA' });
  });

  it('accepts media types with a subtype containing a plus (e.g. svg+xml)', () => {
    expect(parseDataUrl('data:image/svg+xml;base64,BBBB')).toEqual({ mediaType: 'image/svg+xml', base64: 'BBBB' });
  });

  it('throws a typed CritiqueError for a non-data URL', () => {
    expect(() => parseDataUrl('blob:http://localhost/abc-123')).toThrow(CritiqueError);
  });

  it('throws for a data URL that is not base64-encoded', () => {
    expect(() => parseDataUrl('data:text/plain,hello')).toThrow(CritiqueError);
  });

  it('the thrown error carries the invalid-still kind', () => {
    try {
      parseDataUrl('not a data url');
      throw new Error('expected parseDataUrl to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CritiqueError);
      expect((err as CritiqueError).kind).toBe('invalid-still');
    }
  });
});
