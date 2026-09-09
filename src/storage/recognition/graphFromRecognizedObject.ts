// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: selective graphing
// ───────────────────────────────────────────────────────────────────────────
// The one, deliberately singular, path from "the user picked ONE recognized
// shader object" to "a real `ShaderNode` in the active document" (Phase 5
// sketch: "Graphing is selective, not bulk. ... The user picks one; that
// action is what produces a real graph"). Never iterated over a whole
// recognized-object list by a caller — that would be the bulk action the
// sketch explicitly rules out.
//
// Pure and framework-free, same discipline as `src/storage/recognition/
// recognize.ts`: takes already-recognized data (a `RecognizedShaderObject`
// plus its raw source text, read by the caller — this module never touches
// the file system) and returns a plain `ShaderNode`, or a structured refusal.
// No document, no store, no manifest write happens here; callers (a store
// action, a test) decide what to do with the result.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeParam, ShaderNode } from '../../model/document';
import { CHUNK_RAW_NODE_TYPE } from '../../nodes/definitions/chunk';
import type { RecognizedShaderObject } from './types';

export interface GraphFromRecognizedObjectOptions {
  /** Where to place the new node in the graph. Defaults to the origin —
   *  purely cosmetic, never affects `chunkSource`/`params`. */
  position?: { x: number; y: number };
  /** Names (`RecognizedShaderObject.name`) of chunks already graphed —
   *  i.e. whose project-manifest `DiscoveredObject.state.status` is `'draft'`
   *  or `'saved'`, or that already have a `chunk.raw` node somewhere in the
   *  active document. `object.requires` is checked against exactly this set.
   *
   *  Tradeoff (documented per the task's own request): this function BLOCKS
   *  on any unmet `requires` rather than warning-and-proceeding or
   *  auto-pulling the missing chunk in too. Auto-pull-in would need to
   *  recursively resolve and graph an unbounded chain of dependencies from
   *  inside what is supposed to be a single, selective, user-initiated
   *  action — a materially bigger and more surprising side effect than "one
   *  object in, one node out". Warn-and-proceed would silently hand back a
   *  node whose raw text likely calls functions/uses uniforms that don't
   *  exist yet in this graph, deferring the failure to a much harder-to-read
   *  compile diagnostic later (see `checkChunkRequires` in
   *  `src/compiler/lower.ts`, which *does* only warn — but that check runs
   *  after the fact, on a graph the user already committed to). Blocking
   *  up front, with the exact missing names, is the least-surprising choice
   *  available without building real recursive resolution. */
  graphedChunkNames?: Iterable<string>;
  /** Node id generator. Defaults to `crypto.randomUUID()`; overridable so
   *  tests (and any deterministic-id caller) don't depend on it. */
  makeId?: () => string;
}

export type GraphFromRecognizedObjectResult =
  | { ok: true; node: ShaderNode }
  | { ok: false; reason: 'missing-requires'; missing: string[] };

/** Detected uniform NAMES are all `recognizeShaderObjects` extracts (GLSL's
 *  `uniform <type> <name>;` syntax is parsed for the name only — see
 *  `recognize.ts`'s `UNIFORM_DECLARATION`), so the real GLSL type of any one
 *  uniform is unknown here. Defaulting every detected uniform to a `float`
 *  number dial (rather than guessing, or leaving `params` empty) keeps every
 *  uniform visible and renameable/retypeable in the inspector immediately,
 *  at the cost of a wrong default type for anything that isn't actually a
 *  float — an explicit, visible starting point the user corrects, not a
 *  silent one. Never `exposed` by default: promoting a possibly-mistyped
 *  param straight to the document blackboard would be a worse default. */
function paramFromUniformName(name: string): NodeParam {
  return { id: name, label: name, type: 'float', value: 0, ui: 'number' };
}

/** Turns ONE recognized shader object into a real, coarse-grained `chunk.raw`
 *  `ShaderNode` — `params` mirror its detected uniforms, `chunkSource.text`
 *  is `sourceText` passed through verbatim (never reconstructed/reparsed),
 *  and `chunkSource.requires` carries its declared ordering dependencies
 *  forward for `src/compiler/lower.ts`'s `checkChunkRequires` to check inside
 *  whatever graph the node ends up in.
 *
 *  Refuses (rather than producing a half-usable node) when `object.requires`
 *  names a chunk not yet in `options.graphedChunkNames` — see that option's
 *  doc comment for the block-vs-warn-vs-auto-pull-in tradeoff. */
export function graphFromRecognizedObject(
  object: RecognizedShaderObject,
  sourceText: string,
  options: GraphFromRecognizedObjectOptions = {},
): GraphFromRecognizedObjectResult {
  const graphed = new Set(options.graphedChunkNames ?? []);
  const missing = object.requires.filter((name) => !graphed.has(name));
  if (missing.length > 0) {
    return { ok: false, reason: 'missing-requires', missing };
  }

  const makeId = options.makeId ?? (() => crypto.randomUUID());
  const node: ShaderNode = {
    id: makeId(),
    type: CHUNK_RAW_NODE_TYPE,
    title: object.name,
    position: options.position ?? { x: 0, y: 0 },
    params: object.uniforms.map(paramFromUniformName),
    previewEnabled: false,
    chunkSource: {
      name: object.name,
      text: sourceText,
      requires: object.requires,
    },
  };
  return { ok: true, node };
}
