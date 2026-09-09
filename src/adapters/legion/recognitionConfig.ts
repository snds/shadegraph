// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Legion adapter: real recognition config
// ───────────────────────────────────────────────────────────────────────────
// DATA, not code — the concrete proof of Phase 5's "a specific source is a
// configuration, not code" principle (see `src/storage/recognition/
// recognize.ts` header). This file imports only the `RecognitionConfig`
// *type* from `src/storage/recognition`; ShadeGraph never imports Legion as
// a package (see `README.md`'s Boundary section), so the shape below is
// hand-confirmed against Legion's real source (`~/Projects/Legion`) at the
// time this file was written, not read live at build or runtime.
//
// Legion bundles shader source as `export const GLSL_<NAME> = /* glsl */
// \`...\`` string constants across two real files:
//   - `src/render/planet/glsl.ts` — GLSL_SIMPLEX, GLSL_FBM, GLSL_CLOUDS,
//     GLSL_PLATES, GLSL_TERRAIN, GLSL_RAMP (6 chunks)
//   - `src/render/star/kelvin.ts` — GLSL_KELVIN (1 chunk)
// 7 chunks total. Two doc-comment-declared ordering dependencies exist:
// GLSL_CLOUDS and GLSL_TERRAIN each require GLSL_FBM and GLSL_PLATES to be
// included before them (glsl.ts's own prose: "Requires GLSL_FBM and
// GLSL_PLATES ... include BOTH before this chunk").
// ═══════════════════════════════════════════════════════════════════════════

import type { RecognitionConfig } from '../../storage/recognition';

export const legionRecognitionConfig: RecognitionConfig = {
  bundledExtensions: ['.ts'],
  exportNamePattern: /^GLSL_[A-Z0-9_]+$/,
  requires: {
    GLSL_CLOUDS: ['GLSL_FBM', 'GLSL_PLATES'],
    GLSL_TERRAIN: ['GLSL_FBM', 'GLSL_PLATES'],
  },
};
