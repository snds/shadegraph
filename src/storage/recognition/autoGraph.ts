// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: background auto-graph for cached thumbnails
// ───────────────────────────────────────────────────────────────────────────
// The "confirmed direction" from this task's own brief: a real graph CAN be
// generated from what `recognizeShaderObjects` already found, by calling the
// exact same `graphFromRecognizedObject()` the "graph this" button
// (`src/ui/assets/graphThis.ts`) uses — just against a throwaway, in-memory
// `emptyDocument()` instead of the user's real active document/layer. This
// module is the pure, framework-free "throwaway document" half of that:
// never touches the store, the manifest, or the file system, and never
// mutates anything the caller passes in.
//
// Deliberately mirrors `graphThis.ts`'s own `graphedChunkNames` treatment,
// scoped down to just THIS file's own recognized objects (there is no
// document/manifest to consult here — an auto-graph preview is a per-file,
// isolated affair): objects are added in order, each becoming eligible as a
// `requires` target for the next one in the SAME file, so a bundled-chunk
// config where one export requires another earlier export in the same file
// still auto-graphs. A `requires` naming anything else (another file
// entirely, not yet recognized/visible) legitimately refuses — that refusal
// IS the fallback trigger `AssetRow`'s single-generic-icon case is for, not
// a bug to work around.
// ═══════════════════════════════════════════════════════════════════════════

import { emptyDocument, type ShaderDocument, type ShaderLayer } from '../../model/document';
import { makeNodeId } from '../../model/ids';
import { CHUNK_RAW_NODE_TYPE } from '../../nodes/definitions/chunk';
import { graphFromRecognizedObject } from './graphFromRecognizedObject';
import type { RecognizedShaderObject } from './types';

/** Human-readable, never-persisted document name — this document is compiled
 *  + rendered in memory only and is never handed to `setContent`/the
 *  manifest/the editor store. */
const AUTO_GRAPH_DOC_NAME = '__asset-auto-graph-preview__';

export type AutoGraphResult =
  | { ok: true; doc: ShaderDocument }
  | { ok: false; reason: 'missing-requires'; missing: string[] };

/** Turns every recognized object for ONE file into a throwaway `ShaderDocument`
 *  — a fresh `emptyDocument()` whose base layer gets one `chunk.raw` node per
 *  object, via `graphFromRecognizedObject` — never the app's real document.
 *  Refuses (mirroring `graphFromRecognizedObject`'s own refusal) the moment
 *  any object's declared `requires` names something not already graphed
 *  earlier in this SAME call; callers (`AssetRow`'s thumbnail) treat that as
 *  "fall back to the generic node icon for this whole row", per this task's
 *  Definition of Done — never a partially-built document. */
export function buildAutoGraphDocument(
  objects: readonly RecognizedShaderObject[],
  sourceText: string,
): AutoGraphResult {
  const doc = emptyDocument(AUTO_GRAPH_DOC_NAME);
  const layer = doc.layerStack.layers[0] as ShaderLayer;
  const graphedSoFar = new Set<string>();

  for (const object of objects) {
    const result = graphFromRecognizedObject(object, sourceText, {
      graphedChunkNames: graphedSoFar,
      makeId: () => makeNodeId(CHUNK_RAW_NODE_TYPE),
    });
    if (!result.ok) return result;
    layer.graph.nodes.push(result.node);
    graphedSoFar.add(object.name);
  }

  return { ok: true, doc };
}

/** Cheap, non-cryptographic (FNV-1a) content fingerprint of a file's source
 *  text — the "content signature" this task's cache key needs. Never used
 *  for anything security-sensitive, only to decide "does a cached thumbnail
 *  still match this file's current text", so collision resistance beyond
 *  "good enough for one session's worth of asset rows" is unnecessary; a
 *  full source-text string comparison would work identically but costs more
 *  to store/compare across every cached row. */
export function autoGraphContentSignature(sourceText: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < sourceText.length; i++) {
    hash ^= sourceText.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
