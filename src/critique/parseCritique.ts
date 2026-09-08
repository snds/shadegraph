// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique: response parsing
// ───────────────────────────────────────────────────────────────────────────
// Turns the model's raw text reply (see `prompt.ts` for what it was asked
// to produce) into the structured `CritiqueResult` the UI renders. Pure
// string/JSON parsing — no network, no DOM — so it is trivially unit
// testable against fixed model-output strings.
// ═══════════════════════════════════════════════════════════════════════════

import type { CritiqueResult, CritiqueVerdict } from './types';

const VERDICTS: readonly CritiqueVerdict[] = ['pass', 'fail', 'unclear'];

function normalizeVerdict(value: unknown): CritiqueVerdict {
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    if ((VERDICTS as readonly string[]).includes(lower)) return lower as CritiqueVerdict;
  }
  return 'unclear';
}

/** Finds the LAST fenced code block (```json ... ``` or plain ``` ... ```)
 *  in `text` and parses its content as JSON, falling back to scanning the
 *  whole text for a `{...}` object if there is no fenced block at all.
 *  Returns `undefined` (never throws) for anything that doesn't parse — a
 *  malformed/missing JSON block degrades to "unclear + the raw text as
 *  reasoning", not a crash. */
function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const fencedMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidates = fencedMatches.length > 0 ? fencedMatches.map((m) => m[1]) : [text];

  for (const candidate of candidates.slice().reverse()) {
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    if (!objectMatch) continue;
    try {
      const parsed: unknown = JSON.parse(objectMatch[0]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function parseCritiqueResponse(raw: string): CritiqueResult {
  const parsed = extractJsonObject(raw);
  if (!parsed) {
    return { verdict: 'unclear', reasoning: raw.trim(), raw };
  }

  const verdict = normalizeVerdict(parsed.verdict);
  const reasoning = typeof parsed.reasoning === 'string' && parsed.reasoning.trim().length > 0 ? parsed.reasoning.trim() : raw.trim();
  return { verdict, reasoning, raw };
}
