// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Document persistence (file + localStorage autosave)
// ───────────────────────────────────────────────────────────────────────────
// Everything here is a THIN SHELL over `src/model/serialize.ts`. The lossless
// JSON round-trip is a model-layer promise; a second encoder living in the UI
// is how the two silently diverge, so this file never touches `JSON.stringify`
// on a document — only `serialize`/`deserialize`/`validateDocument`.
//
// Two durable surfaces:
//   • FILE   — `<name>.shadegraph.json`, downloaded / opened via a file input.
//   • AUTOSAVE — a debounced localStorage mirror of the live document, restored
//     on boot so a refresh is not data loss.
//
// The autosave entry wraps the document's *serialized text* in an envelope
// (`{ savedAt, doc }`) rather than re-encoding the document object, which keeps
// the model's encoder as the one and only document JSON path.
//
// Failure policy: a malformed file or a corrupt autosave NEVER reaches the
// store. Everything is parsed and validated into a complete `ShaderDocument`
// before `loadDocument` is called, so a bad load leaves the current document
// untouched and only raises a notice.
//
// DOM/browser APIs are touched inside functions only — this module must stay
// importable from the (node-environment) test runner.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShaderDocument } from '../model/document';
import { DocumentParseError, deserialize, serialize } from '../model/serialize';
import { notify } from './notice';
import { useEditorStore } from './store';

/** localStorage key for the autosaved document. Versioned: a future schema
 *  break can ship a new key instead of trying to migrate a half-written blob. */
export const AUTOSAVE_KEY = 'shadegraph.autosave.v1';

/** Quiet period after the last edit before the document is mirrored to
 *  localStorage. Long enough that dragging a node is one write, not sixty. */
export const AUTOSAVE_DEBOUNCE_MS = 600;

/** Saved documents are `<name>.shadegraph.json` — the double extension keeps
 *  them recognisable while staying openable by any JSON tool. */
export const FILE_SUFFIX = '.shadegraph.json';

/** The slice of the `Storage` interface this module needs. Injectable so the
 *  autosave logic is testable without a DOM. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Result of any attempt to turn untrusted text into a document. */
export type LoadResult =
  | { ok: true; doc: ShaderDocument }
  | { ok: false; message: string };

/** Result of reading the autosave slot. `null` = nothing was stored. */
export type AutosaveResult =
  | { ok: true; doc: ShaderDocument; savedAt: string }
  | { ok: false; message: string };

// ── Text → document ────────────────────────────────────────────────────────

/**
 * Parse untrusted JSON text into a document. Never throws: a rejection comes
 * back as a message fit to show the user, so callers can decide what to do
 * without a try/catch around every load path.
 */
export function parseDocumentText(text: string): LoadResult {
  try {
    return { ok: true, doc: deserialize(text) };
  } catch (err) {
    if (err instanceof DocumentParseError) return { ok: false, message: err.message };
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ── File naming ────────────────────────────────────────────────────────────

/** Document name → a safe download filename. Anything a filesystem might choke
 *  on collapses to a dash; an empty result falls back to `untitled`. */
export function documentFileName(name: string): string {
  const safe = name
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return `${safe || 'untitled'}${FILE_SUFFIX}`;
}

// ── Autosave envelope ──────────────────────────────────────────────────────

interface AutosaveEnvelope {
  /** ISO timestamp of the write, so the restore affordance can say *when*. */
  savedAt: string;
  /** The document as produced by `serialize` — a string, deliberately. */
  doc: string;
}

/** Document → the exact string stored under `AUTOSAVE_KEY`. */
export function encodeAutosave(doc: ShaderDocument, savedAt = new Date().toISOString()): string {
  const envelope: AutosaveEnvelope = { savedAt, doc: serialize(doc, false) };
  return JSON.stringify(envelope);
}

/** Stored string → document, or a reason it cannot be trusted. `null` when
 *  there is simply nothing stored. */
export function decodeAutosave(raw: string | null): AutosaveResult | null {
  if (raw === null || raw === '') return null;

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { ok: false, message: 'The autosaved document is not valid JSON.' };
  }
  if (typeof envelope !== 'object' || envelope === null) {
    return { ok: false, message: 'The autosave entry is not in a recognised format.' };
  }
  const { savedAt, doc } = envelope as Partial<AutosaveEnvelope>;
  if (typeof doc !== 'string') {
    return { ok: false, message: 'The autosave entry is not in a recognised format.' };
  }

  const parsed = parseDocumentText(doc);
  if (!parsed.ok) return parsed;
  return { ok: true, doc: parsed.doc, savedAt: typeof savedAt === 'string' ? savedAt : '' };
}

// ── Storage access ─────────────────────────────────────────────────────────

/** `localStorage` when it exists and is usable — Safari private mode and
 *  sandboxed iframes throw on mere access, so this is defensive. */
export function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** Read + validate the autosave slot. `null` when empty or unavailable. */
export function readAutosave(storage: StorageLike | null = defaultStorage()): AutosaveResult | null {
  if (!storage) return null;
  try {
    return decodeAutosave(storage.getItem(AUTOSAVE_KEY));
  } catch {
    return null;
  }
}

/** Mirror a document into the autosave slot. Returns false when storage is
 *  unavailable or full — autosave is a convenience, never a hard failure. */
export function writeAutosave(
  doc: ShaderDocument,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(AUTOSAVE_KEY, encodeAutosave(doc));
    return true;
  } catch {
    return false;
  }
}

/** Drop the autosave slot (the "discard" affordance). */
export function clearAutosave(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(AUTOSAVE_KEY);
  } catch {
    /* nothing to do — the slot is already unusable */
  }
}

// ── Debounced autosaver ────────────────────────────────────────────────────

export interface Autosaver {
  /** Queue a write; repeated calls inside the debounce window coalesce. */
  schedule: (doc: ShaderDocument) => void;
  /** Write any queued document immediately (page unload, explicit save). */
  flush: () => void;
  /** Forget any queued document without writing it. */
  cancel: () => void;
}

/** A debounced writer around `writeAutosave`. Pure enough to unit-test with
 *  fake timers and an in-memory storage. */
export function createAutosaver(options: {
  storage?: StorageLike | null;
  delayMs?: number;
} = {}): Autosaver {
  const { storage = defaultStorage(), delayMs = AUTOSAVE_DEBOUNCE_MS } = options;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: ShaderDocument | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    clear();
    if (!pending) return;
    const doc = pending;
    pending = null;
    writeAutosave(doc, storage);
  };

  return {
    schedule(doc) {
      pending = doc;
      clear();
      timer = setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      clear();
      pending = null;
    },
  };
}

// ── App wiring (browser only) ──────────────────────────────────────────────

let autosaveStarted = false;

/**
 * Subscribe the autosaver to the editor store. Idempotent, and deliberately
 * never unsubscribes: the toolbar that starts it lives as long as the app, and
 * a StrictMode remount must not silently switch autosave off.
 */
export function startAutosave(): void {
  if (autosaveStarted) return;
  autosaveStarted = true;

  const autosaver = createAutosaver();
  useEditorStore.subscribe((state, prev) => {
    if (state.doc !== prev.doc) autosaver.schedule(state.doc);
  });
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => autosaver.flush());
  }
}

let bootRestoreDone = false;

/**
 * Load the autosaved document into the store, once per page load. Returns the
 * ISO timestamp of the restored autosave so the toolbar can offer to discard
 * it, or `null` when there was nothing to restore.
 *
 * A corrupt entry is reported and dropped rather than left to fail on every
 * boot; either way the live document is untouched until a *complete* document
 * has been validated.
 */
export function restoreAutosave(): { savedAt: string } | null {
  if (bootRestoreDone) return null;
  bootRestoreDone = true;

  const result = readAutosave();
  if (!result) return null;
  if (!result.ok) {
    clearAutosave();
    notify(`Discarded an unreadable autosave: ${result.message}`);
    return null;
  }
  useEditorStore.getState().loadDocument(result.doc);
  return { savedAt: result.savedAt };
}

// ── File download / open ───────────────────────────────────────────────────

/**
 * Download the document as `<name>.shadegraph.json`. Returns the filename used
 * so the caller can report it. No-op outside a browser.
 */
export function downloadDocument(doc: ShaderDocument): string {
  const fileName = documentFileName(doc.name);
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return fileName;
  }
  const blob = new Blob([serialize(doc)], { type: 'application/json' });
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
