// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: default recognition config
// ───────────────────────────────────────────────────────────────────────────
// The generic, source-agnostic `RecognitionConfig` the running app wires
// `assetStore.ts`'s `recognizeNode` up with — just enough to prove the
// browse → recognize → surface path end to end (standalone `.glsl`/`.wgsl`
// files). Deliberately not Legion-shaped: a bundled-chunk config for any one
// real source tree is that caller's own config, built at its own call site
// (see `src/adapters/legion/README.md`), never hardcoded here.
// ═══════════════════════════════════════════════════════════════════════════

import type { RecognitionConfig } from './recognition';

export const defaultRecognitionConfig: RecognitionConfig = {
  fileExtensions: ['.glsl', '.wgsl'],
};
