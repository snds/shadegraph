// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: shader-object recognition types
// ───────────────────────────────────────────────────────────────────────────
// Deliberately data-only and source-agnostic. `RecognitionConfig` is how
// any one project's source tree is *configured*, never *coded* into this
// module — see `src/storage/recognition/recognize.ts` header for the full
// rationale. This module knows nothing about any specific project.
// ═══════════════════════════════════════════════════════════════════════════

/** Config-declared ordering, keyed by recognized-object `name` (the file
 *  name for a standalone shader file, or the export name for a bundled
 *  chunk) → the names of objects that must be treated as coming before it.
 *  Never inferred from source text/doc comments — always explicit data. */
export type RequiresMap = Record<string, string[]>;

export interface RecognitionConfig {
  /** File extensions (with leading dot, case-insensitive) that make a whole
   *  file one recognized shader object, e.g. `['.glsl', '.wgsl']`. */
  fileExtensions?: string[];
  /** File extensions to scan for bundled string-constant chunks, e.g.
   *  `['.ts', '.js']`. Ignored unless `exportNamePattern` is also set. */
  bundledExtensions?: string[];
  /** Matches `export const <Name> = <quote>...<quote>` export names that
   *  hold bundled shader source, e.g. `/^GLSL_[A-Z0-9_]+$/`. One file may
   *  yield multiple recognized objects, one per matching export. */
  exportNamePattern?: RegExp;
  /** Explicit inter-object ordering declarations. Config-declared only —
   *  never parsed out of prose/doc comments. */
  requires?: RequiresMap;
}

/** One entry recognized as shader-object-shaped content, plus what was
 *  detected/declared about it. */
export interface RecognizedShaderObject {
  /** Stable identity: the owning node's id, plus `#<exportName>` for a
   *  bundled chunk (a single file can yield several objects). */
  id: string;
  /** File name (standalone file) or export name (bundled chunk) — also the
   *  key `RecognitionConfig.requires` and other objects' `requires` use to
   *  reference this object. */
  name: string;
  /** The `AssetTreeNode.id` this object was recognized from. */
  nodeId: string;
  /** The owning node's path, copied through for convenience. */
  path: string[];
  /** `uniform <type> <name>;` names parsed out of this object's own source
   *  text, in first-seen order, de-duplicated. */
  uniforms: string[];
  /** Names of other recognized objects this one declares it requires
   *  before it, per `RecognitionConfig.requires`. Not resolved against the
   *  actual discovered set — callers reconcile that. */
  requires: string[];
}
