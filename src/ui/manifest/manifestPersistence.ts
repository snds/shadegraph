// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Project-manifest persistence (portable file)
// ───────────────────────────────────────────────────────────────────────────
// The manifest's ONE durable, shareable surface: `<name>.shadegraph-manifest
// .json`, downloaded / opened via a file input — the same "download a Blob /
// open via <input type=file>" pattern `src/ui/persistence.ts` already uses
// for the document (no autosave slot here; the task brief scopes this to
// save/load only).
//
// Same discipline as `persistence.ts`: this file never calls `JSON.stringify`
// / `JSON.parse` on a manifest directly, only `serializeManifest`/
// `parseManifest` — the model layer's lossless-round-trip promise stays the
// one and only encoder. A malformed file never reaches the store: it is
// parsed and validated into a complete `ProjectManifest` here first, and the
// caller decides what to do with a rejection.
//
// DOM/browser APIs are touched inside `downloadManifest` only, guarded the
// same way `downloadDocument` is, so this module stays importable from the
// (node-environment) test runner.
// ═══════════════════════════════════════════════════════════════════════════

import { ManifestParseError, parseManifest, serializeManifest, type ProjectManifest } from '../../model/projectManifest';

/** Saved manifests are `<name>.shadegraph-manifest.json` — distinct from a
 *  single document's `.shadegraph.json` (`persistence.ts`'s `FILE_SUFFIX`)
 *  since the two are different artifacts (see `projectManifest.ts`'s header). */
export const MANIFEST_FILE_SUFFIX = '.shadegraph-manifest.json';

/** Result of any attempt to turn untrusted text into a manifest. */
export type ManifestLoadResult =
  | { ok: true; manifest: ProjectManifest }
  | { ok: false; message: string };

/**
 * Parse untrusted JSON text into a manifest. Never throws: a rejection comes
 * back as a message fit to show the user (the `ManifestParseError` message),
 * mirroring `persistence.ts`'s `parseDocumentText`.
 */
export function parseManifestText(text: string): ManifestLoadResult {
  try {
    return { ok: true, manifest: parseManifest(text) };
  } catch (err) {
    if (err instanceof ManifestParseError) return { ok: false, message: err.message };
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Manifest name → a safe download filename. Same collapsing rule as
 *  `persistence.ts`'s `documentFileName`. */
export function manifestFileName(name: string): string {
  const safe = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${safe || 'untitled'}${MANIFEST_FILE_SUFFIX}`;
}

/**
 * Download the manifest as `<name>.shadegraph-manifest.json`. Returns the
 * filename used so the caller can report it. No-op outside a browser.
 */
export function downloadManifest(manifest: ProjectManifest): string {
  const fileName = manifestFileName(manifest.name);
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return fileName;
  }
  const blob = new Blob([serializeManifest(manifest)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick: Safari cancels an in-flight download otherwise.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return fileName;
}
