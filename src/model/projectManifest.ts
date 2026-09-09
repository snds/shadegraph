// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Project manifest (Phase 5: connect, discover, browse)
// ───────────────────────────────────────────────────────────────────────────
// A third, distinct artifact alongside the per-document `.shadegraph.json`
// (`src/model/document.ts`) and the browser-local-only `ProjectSettings`
// (`src/model/settings.ts`):
//
//   • `.shadegraph.json`  — ONE shader's durable graph.
//   • `ProjectSettings`   — HOW the tool is configured (may hold secrets),
//                           localStorage-only, never exported.
//   • `ProjectManifest`   — WHAT is connected/discovered across a project:
//                           connected-folder references, per-object discovery
//                           metadata, and (once started) draft graphs. Meant
//                           to be saved, reloaded, and reasonably
//                           shareable/committable.
//
// Because this format is meant to be shared/committed, it must NEVER be able
// to hold a secret (an API key, a token, ...). That is enforced STRUCTURALLY
// here, not just by convention: every field below is shaped to hold only
// non-secret data (ids, names, tags, notes, paths, a `ShaderDocument` draft).
// There is no free-form config/credentials field anywhere in this file that
// a secret could be smuggled into — contrast `ProjectSettings.apiKeyRef`,
// which exists deliberately in that *other*, non-portable module.
//
// Same discipline as `document.ts`/`serialize.ts`: pure data, versioned for
// migrations, JSON round-trips losslessly, and `parseManifest` validates
// shape/version and hands back exactly what was parsed (no normalising).
// ═══════════════════════════════════════════════════════════════════════════

import { validateDocument } from './serialize';
import type { ShaderDocument } from './document';

/** Semver of the manifest schema itself, for migrations. Independent of
 *  `document.ts`'s `SCHEMA_VERSION` — the manifest and the documents it may
 *  embed as drafts evolve on their own schedules. */
export const MANIFEST_SCHEMA_VERSION = '0.1.0' as const;

// ── Connected folders ───────────────────────────────────────────────────────
// A reference to a folder connected via Phase 4's asset-folder-connection
// mechanism — never the folder's contents, and never the live
// `FileSystemDirectoryHandle` itself (that stays in IndexedDB via
// `src/storage/indexedDbHandleStore.ts`; it isn't JSON-serializable and has
// no place in a portable, committable file). `id` is the stable key a UI/
// storage layer can later use to look up the live handle; `name` is the
// display label (e.g. the folder's own name) shown while browsing.
export interface ConnectedFolderRef {
  id: string;
  name: string;
}

// ── Discovered objects ──────────────────────────────────────────────────────
// Free-form, user-editable metadata attached to a discovered object as soon
// as it is recognised — cheap, always present, independent of whether the
// user has ever opened it.
export interface DiscoveredObjectMetadata {
  tags: string[];
  notes?: string;
}

// The three states a discovered object moves through over time (Phase 5
// sketch, "Resolved" — tiered manifest design):
//   1. `discovered` — metadata only; nothing graphed yet.
//   2. `draft`      — the user has started graphing it; the in-progress
//                     `ShaderDocument` is embedded here, autosave-style.
//   3. `saved`      — formally saved out as its own standalone
//                     `.shadegraph.json`; the draft is cleared and this
//                     holds a reference/path to that file instead.
// A discriminated union (mirrors `ReferenceCritiqueConfig` in settings.ts)
// so each state can only carry the fields that make sense for it — a
// `discovered` entry cannot accidentally carry a stale draft, etc.
export type DiscoveredObjectState =
  | { status: 'discovered' }
  | { status: 'draft'; draft: ShaderDocument }
  | { status: 'saved'; documentPath: string };

export interface DiscoveredObject {
  id: string;
  /** `ConnectedFolderRef.id` of the folder this object was discovered in. */
  folderId: string;
  /** Path segments from that folder's root to the discovered object. */
  path: string[];
  /** Display name (e.g. the recognised chunk/export name). */
  name: string;
  metadata: DiscoveredObjectMetadata;
  state: DiscoveredObjectState;
}

// ── Manifest ─────────────────────────────────────────────────────────────────
export interface ProjectManifest {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  id: string;
  name: string;
  connectedFolders: ConnectedFolderRef[];
  discoveredObjects: DiscoveredObject[];
  meta: {
    created: string;
    updated: string;
  };
}

/** Create an empty, valid manifest — nothing connected, nothing discovered. */
export function emptyManifest(name = 'Untitled project'): ProjectManifest {
  const now = new Date().toISOString();
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name,
    connectedFolders: [],
    discoveredObjects: [],
    meta: { created: now, updated: now },
  };
}

// ── (De)serialisation ────────────────────────────────────────────────────────
// Same lossless-round-trip discipline as `serialize.ts`: `parseManifest`
// validates shape and schema version, then hands back exactly what was
// parsed. Any defaulting would silently mutate a user's file.

/** Thrown when a JSON blob is not a manifest this build can open. */
export class ManifestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestParseError';
  }
}

/** Manifest → JSON text. Pretty by default: a committable file should diff
 *  well. */
export function serializeManifest(manifest: ProjectManifest, pretty = true): string {
  return JSON.stringify(manifest, null, pretty ? 2 : 0);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(message: string): never {
  throw new ManifestParseError(message);
}

function validateConnectedFolder(value: unknown, i: number): void {
  if (!isObject(value)) fail(`Connected folder ${i} is not an object.`);
  if (typeof value.id !== 'string') fail(`Connected folder ${i} is missing a string "id".`);
  if (typeof value.name !== 'string') fail(`Connected folder ${i} is missing a string "name".`);
}

function validateDiscoveredObjectState(value: unknown, i: number): void {
  if (!isObject(value)) fail(`Discovered object ${i} is missing a "state" object.`);
  switch (value.status) {
    case 'discovered':
      return;
    case 'draft':
      try {
        validateDocument(value.draft);
      } catch (err) {
        fail(
          `Discovered object ${i} has an invalid draft document: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    case 'saved':
      if (typeof value.documentPath !== 'string') {
        fail(`Discovered object ${i} ("saved") is missing a string "documentPath".`);
      }
      return;
    default:
      fail(`Discovered object ${i} has an unrecognised state "status" (${String(value.status)}).`);
  }
}

function validateDiscoveredObject(value: unknown, i: number): void {
  if (!isObject(value)) fail(`Discovered object ${i} is not an object.`);
  if (typeof value.id !== 'string') fail(`Discovered object ${i} is missing a string "id".`);
  if (typeof value.folderId !== 'string') fail(`Discovered object ${i} is missing a string "folderId".`);
  if (!Array.isArray(value.path) || !value.path.every((seg) => typeof seg === 'string')) {
    fail(`Discovered object ${i} is missing a string-array "path".`);
  }
  if (typeof value.name !== 'string') fail(`Discovered object ${i} is missing a string "name".`);

  if (!isObject(value.metadata)) fail(`Discovered object ${i} is missing "metadata".`);
  const tags = value.metadata.tags;
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === 'string')) {
    fail(`Discovered object ${i} "metadata.tags" must be a string array.`);
  }
  if (value.metadata.notes !== undefined && typeof value.metadata.notes !== 'string') {
    fail(`Discovered object ${i} "metadata.notes" must be a string when present.`);
  }

  validateDiscoveredObjectState(value.state, i);
}

/** Structural validation of an already-parsed value. Exported so callers that
 *  already hold an object (e.g. a future storage/UI layer) can reuse the same
 *  gate, mirroring `validateDocument` in `serialize.ts`. */
export function validateManifest(value: unknown): ProjectManifest {
  if (!isObject(value)) fail('Not a ShadeGraph project manifest: expected a JSON object.');

  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    fail(
      `Unsupported manifest schema version "${String(value.schemaVersion)}" ` +
        `(this build reads "${MANIFEST_SCHEMA_VERSION}").`,
    );
  }
  if (typeof value.id !== 'string') fail('Manifest is missing a string "id".');
  if (typeof value.name !== 'string') fail('Manifest is missing a string "name".');

  if (!Array.isArray(value.connectedFolders)) fail('Manifest is missing a "connectedFolders" array.');
  value.connectedFolders.forEach(validateConnectedFolder);

  if (!Array.isArray(value.discoveredObjects)) fail('Manifest is missing a "discoveredObjects" array.');
  value.discoveredObjects.forEach(validateDiscoveredObject);

  if (!isObject(value.meta)) fail('Manifest is missing "meta".');
  if (typeof value.meta.created !== 'string' || typeof value.meta.updated !== 'string') {
    fail('Manifest "meta" needs string "created" and "updated" timestamps.');
  }

  return value as unknown as ProjectManifest;
}

/** JSON text → manifest. Throws `ManifestParseError` with a message fit to
 *  show a user; never returns a partially-valid manifest. */
export function parseManifest(json: string): ProjectManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    fail(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateManifest(parsed);
}
