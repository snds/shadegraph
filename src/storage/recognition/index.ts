// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: recognition module surface
// ───────────────────────────────────────────────────────────────────────────
// Additive — nothing in `src/storage/index.ts` changes or re-exports this.
// Callers who want recognition (each supplying its own `RecognitionConfig`)
// import from here directly.
// ═══════════════════════════════════════════════════════════════════════════

export { recognizeShaderObjects } from './recognize';
export type { RecognitionConfig, RecognizedShaderObject, RequiresMap } from './types';
export { graphFromRecognizedObject } from './graphFromRecognizedObject';
export type {
  GraphFromRecognizedObjectOptions,
  GraphFromRecognizedObjectResult,
} from './graphFromRecognizedObject';
