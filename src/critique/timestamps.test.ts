import { describe, expect, it } from 'vitest';

import { parseTimestampSeconds } from './timestamps';

describe('parseTimestampSeconds', () => {
  it('parses a comma-separated list of seconds', () => {
    expect(parseTimestampSeconds('0, 1.5, 3')).toEqual([0, 1.5, 3]);
  });

  it('drops empty segments from trailing/stray commas', () => {
    expect(parseTimestampSeconds('0,1,,2,')).toEqual([0, 1, 2]);
  });

  it('drops non-numeric and negative entries', () => {
    expect(parseTimestampSeconds('0, abc, -1, 2')).toEqual([0, 2]);
  });

  it('deduplicates repeated timestamps, keeping first-seen order', () => {
    expect(parseTimestampSeconds('1, 2, 1, 3')).toEqual([1, 2, 3]);
  });

  it('returns an empty list for blank input', () => {
    expect(parseTimestampSeconds('   ')).toEqual([]);
  });
});
