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
// Known limitation, intentionally not solved by this task: GLSL's `uniform`
// declarations and function definitions are top-level (outside `main()`), but
// `EmitContext.emit` only appends statements INSIDE the composed `main()`
// body (see `assembleFragment` in `backends/glsl-es.ts`) — there is no
// per-node "prelude" injection point yet. A `chunk.raw` node's raw text is
// still emitted verbatim (this task's actual scope: model + registry +
// verbatim passthrough + `requires` bookkeeping, unit-tested via a literal
// fixture), but a full document containing one will not compile to valid
// GLSL until a prelude mechanism exists — a separate, compiler-level task.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeDefinition } from '../registry';

export const CHUNK_RAW_NODE_TYPE = 'chunk.raw';

export const chunkRaw: NodeDefinition = {
  type: CHUNK_RAW_NODE_TYPE,
  category: 'legion',
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
      // sketch's "coarse-grained chunk nodes" decision.
      ctx.emit(node.chunkSource.text);
      return '';
    },
  },
};
