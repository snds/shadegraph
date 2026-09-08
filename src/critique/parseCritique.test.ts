import { describe, expect, it } from 'vitest';

import { parseCritiqueResponse } from './parseCritique';

describe('parseCritiqueResponse', () => {
  it('parses verdict and reasoning from a fenced json block', () => {
    const raw = [
      'The render matches the reference closely in color and composition.',
      '',
      '```json',
      '{"verdict": "pass", "reasoning": "Color and composition match closely."}',
      '```',
    ].join('\n');
    const result = parseCritiqueResponse(raw);
    expect(result.verdict).toBe('pass');
    expect(result.reasoning).toBe('Color and composition match closely.');
    expect(result.raw).toBe(raw);
  });

  it('normalizes verdict case and whitespace', () => {
    const raw = '```json\n{"verdict": " FAIL ", "reasoning": "Wrong hue."}\n```';
    expect(parseCritiqueResponse(raw).verdict).toBe('fail');
  });

  it('falls back to "unclear" for an unrecognized verdict string', () => {
    const raw = '```json\n{"verdict": "maybe", "reasoning": "Hard to tell."}\n```';
    expect(parseCritiqueResponse(raw).verdict).toBe('unclear');
  });

  it('parses a bare JSON object with no fence at all', () => {
    const raw = '{"verdict": "pass", "reasoning": "Good match."}';
    const result = parseCritiqueResponse(raw);
    expect(result.verdict).toBe('pass');
    expect(result.reasoning).toBe('Good match.');
  });

  it('uses the last fenced block when the model included one earlier as an example', () => {
    const raw = ['Example: ```json\n{"verdict": "fail", "reasoning": "not this one"}\n```', 'My actual answer:', '```json', '{"verdict": "pass", "reasoning": "this one"}', '```'].join('\n');
    expect(parseCritiqueResponse(raw).reasoning).toBe('this one');
  });

  it('degrades to unclear + raw text as reasoning when there is no parseable JSON at all', () => {
    const raw = 'The render looks close enough, I think it passes.';
    const result = parseCritiqueResponse(raw);
    expect(result.verdict).toBe('unclear');
    expect(result.reasoning).toBe(raw);
  });

  it('degrades gracefully for malformed JSON inside a fence', () => {
    const raw = '```json\n{verdict: pass, not valid json}\n```';
    const result = parseCritiqueResponse(raw);
    expect(result.verdict).toBe('unclear');
    expect(result.reasoning).toBe(raw.trim());
  });

  it('falls back to the raw text when reasoning is missing from the JSON', () => {
    const raw = '```json\n{"verdict": "pass"}\n```';
    const result = parseCritiqueResponse(raw);
    expect(result.verdict).toBe('pass');
    expect(result.reasoning).toBe(raw.trim());
  });
});
