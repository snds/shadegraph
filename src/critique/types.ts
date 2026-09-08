// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique: shared types
// ───────────────────────────────────────────────────────────────────────────
// `StillImage` is the ONE shape every image this feature ever sends over the
// network takes — whether it came from `canvas.toDataURL()` on the main
// viewer, a reference image file, or a frame extracted from a reference
// video. There is no separate "video" or "file" type anywhere downstream of
// extraction: by the time a video reference reaches `runCritique`/
// `anthropicClient.ts`, it has already been reduced to a handful of these,
// exactly like a still image reference would be. That collapse is what makes
// "the network call never receives raw video bytes" true by construction
// rather than by convention — there is no code path left that could smuggle
// raw video bytes into a request, since nothing downstream of extraction
// even has a type that could hold them.
// ═══════════════════════════════════════════════════════════════════════════

/** A minimum-viable structured critique: a machine-checkable verdict plus
 *  free-text reasoning. `'unclear'` is a real outcome (not an error) — the
 *  model may legitimately be unable to judge from what it was given. */
export type CritiqueVerdict = 'pass' | 'fail' | 'unclear';

export interface CritiqueResult {
  verdict: CritiqueVerdict;
  reasoning: string;
  /** The full, unparsed model response text, kept for debugging/inspection
   *  even when `reasoning` above is a trimmed subset of it. */
  raw: string;
}

/** One extracted still, ready to serialize into a request. `dataUrl` is a
 *  full `data:<mediaType>;base64,<data>` string — the browser-native shape
 *  `canvas.toDataURL()` already produces, so no separate encode step is
 *  needed for the render-capture path; `dataUrl.ts` peels it back apart only
 *  when a request actually needs `{ mediaType, base64 }` separately. */
export interface StillImage {
  dataUrl: string;
  /** Human-readable label surfaced to the model as this image's caption
   *  (e.g. a file name or "@ 1.50s") and to the UI as alt text. */
  label: string;
}
