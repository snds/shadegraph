// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Imported chunk node (Phase 5: selective graphing)
// `chunk.raw`
// ───────────────────────────────────────────────────────────────────────────
// ONE generic registry entry, not one per recognized object: a `chunk.raw`
// node's per-instance identity lives entirely in `ShaderNode.chunkSource`
// (populated by `graphFromRecognizedObject`, `src/storage/recognition/`),
// never in this shared definition. This is what lets a single recognizer +
// single node type cover any number of discovered shader objects, generic
// across sources (Legion is a configured consumer, never baked in here).
//
// Deliberately no typed inputs/outputs: the Phase 5 sketch's own reality
// check is that a real-world "chunk" is commonly a bundled multi-function
// utility library (several functions + their own uniforms), not a single
// expression a socket could carry — wiring individual functions from an
// imported chunk into the rest of a graph is left to a follow-on task, not
// guessed at here. The emitter's only job is a byte-for-byte passthrough.
//
// GLSL's `uniform` declarations and function definitions are top-level
// (outside `main()`), so the raw text is handed to `EmitContext.prelude`
// (Phase 5 fidelity-verification fix), not `emit` — the backend renders every
// node's prelude contribution ahead of `main()` (see `assembleFragment` in
// `backends/glsl-es.ts`), deduped verbatim, so a `chunk.raw` node's text
// lands exactly once, at the right scope, regardless of dispatch order.
// Having no sockets also means a `chunk.raw` node is never edge-reachable
// from the graph's output node; `resolveOrder` (`../../compiler/lower.ts`)
// forces every `chunkSource`-bearing node in as an extra root for exactly
// this reason, so a graphed chunk is never silently pruned.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeDefinition } from '../registry';

export const CHUNK_RAW_NODE_TYPE = 'chunk.raw';

export const chunkRaw: NodeDefinition = {
  type: CHUNK_RAW_NODE_TYPE,
  category: 'imported',
  title: 'Imported Chunk (raw)',
  description:
    'A recognized external shader-source object, passed through verbatim. ' +
    'Created via the asset browser\'s "graph this" action on a recognized ' +
    'object, not usefully created by hand from this palette entry (a freshly ' +
    'added one has no `chunkSource` yet).',
  inputs: [],
  outputs: [],
  params: [],
  previewable: false,
  emit: {
    'glsl-es': (node, ctx) => {
      if (!node.chunkSource) {
        ctx.diag({
          level: 'error',
          message: `"${node.id}" is a ${CHUNK_RAW_NODE_TYPE} node with no chunkSource; nothing emitted.`,
          nodeId: node.id,
        });
        return '';
      }
      // Verbatim passthrough — never reconstructed/reparsed, per the Phase 5
      // sketch's "coarse-grained chunk nodes" decision. `prelude`, not
      // `emit`: this text is top-level GLSL (uniforms/functions), not a
      // `main()` body statement.
      ctx.prelude(node.chunkSource.text);
      return '';
    },
  },
};
