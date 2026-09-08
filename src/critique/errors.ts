// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique: error taxonomy
// ───────────────────────────────────────────────────────────────────────────
// One typed error class for every failure mode this feature can hit, so the
// UI can render a specific, actionable message instead of a generic
// "something went wrong" — the task's explicit requirement for a missing/
// invalid API key.
//
// SECRET HYGIENE: every `CritiqueError` constructed anywhere in `src/critique/`
// carries only `kind` + a human-authored `message` string — never an
// interpolated `apiKeyRef`, request body, or raw server response body that
// might itself echo a key back. Grep for `apiKeyRef` across this directory
// to confirm it only ever flows INTO a request header, never into a thrown
// message.
// ═══════════════════════════════════════════════════════════════════════════

export type CritiqueErrorKind =
  | 'missing-api-key'
  | 'missing-render'
  | 'missing-reference'
  | 'invalid-still'
  | 'network'
  | 'api-error'
  | 'parse';

export class CritiqueError extends Error {
  readonly kind: CritiqueErrorKind;

  constructor(kind: CritiqueErrorKind, message: string) {
    super(message);
    this.name = 'CritiqueError';
    this.kind = kind;
  }
}
