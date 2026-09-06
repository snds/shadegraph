import { describe, expect, it } from 'vitest';

import { sanitizeIdent } from './ids';

describe('sanitizeIdent', () => {
  it('leaves an already-safe identifier untouched', () => {
    expect(sanitizeIdent('layer_abc123')).toBe('layer_abc123');
  });

  it('replaces every character invalid in a GLSL identifier with an underscore', () => {
    expect(sanitizeIdent('c310a58e-7543-481d-884c-89c9cd44fcd9')).toBe(
      'c310a58e_7543_481d_884c_89c9cd44fcd9',
    );
    expect(sanitizeIdent('math.mix#1')).toBe('math_mix_1');
  });
});
