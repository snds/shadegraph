// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique: video sample-timestamp parsing
// ───────────────────────────────────────────────────────────────────────────
// The "N configurable timestamps" the task calls for — a plain comma-
// separated seconds string from the UI, parsed into the numeric list
// `extractVideoStills` seeks to. Pure so it is unit-testable without a DOM.
// ═══════════════════════════════════════════════════════════════════════════

/** Parses a free-typed "0, 1.5, 3" field into a deduplicated list of
 *  non-negative finite seconds, in the order first seen. Malformed entries
 *  (empty segments, `NaN`, negatives) are silently dropped rather than
 *  rejecting the whole input — a trailing comma or stray space is a normal
 *  thing to type, not a validation error worth surfacing. */
export function parseTimestampSeconds(input: string): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const segment of input.split(',')) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const value = Number(trimmed);
    if (!Number.isFinite(value) || value < 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
