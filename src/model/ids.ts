// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Id helpers
// ───────────────────────────────────────────────────────────────────────────
// Pure data. Ids must be stable, JSON-safe, and readable in a serialised doc
// so a human can diff two saved graphs. Node ids embed the type slug; edge ids
// are DERIVED from their endpoints, which makes duplicate-edge detection a
// string comparison and keeps round-trips byte-stable.
// ═══════════════════════════════════════════════════════════════════════════

import type { Edge } from './document';

/** Short, collision-resistant-enough suffix for editor-scoped ids. */
function suffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** "math.mix" → "math_mix". Keeps ids readable and selector-safe. */
export function slugifyType(type: string): string {
  return type.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'node';
}

/** Sanitises an arbitrary id into a GLSL-safe identifier fragment (used to
 *  build deterministic uniform names from node/layer ids). Deliberately the
 *  same transform as `nodes/definitions/helpers.ts`'s `ident()` — kept as a
 *  separate copy here so `src/preview/` can reconstruct the exact uniform name
 *  a compiled program used without importing from `src/nodes/definitions/`. */
export function sanitizeIdent(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '_');
}

/** Unique id for a new node of `type`, e.g. `math_mix_k3f9a1`. */
export function makeNodeId(type: string): string {
  return `${slugifyType(type)}_${suffix()}`;
}

/** Unique id for a new layer. */
export function makeLayerId(): string {
  return `layer_${suffix()}`;
}

/** Unique id for a new document. */
export function makeDocumentId(): string {
  return `doc_${suffix()}`;
}

/** Unique id for a new node group / frame. */
export function makeGroupId(): string {
  return `group_${suffix()}`;
}

/** Deterministic edge id from its endpoints — two identical links always
 *  produce the same id, so duplicates collapse instead of stacking. */
export function makeEdgeId(source: Edge['source'], target: Edge['target']): string {
  return `${source.node}:${source.socket}->${target.node}:${target.socket}`;
}
