// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: named recognition config registry
// ───────────────────────────────────────────────────────────────────────────
// A plain, generic list of named `RecognitionConfig`s the running app can
// switch `recognizeNode` between at runtime (see `assetStore.ts`'s
// `setRecognitionConfig`). Deliberately NOT a Legion-specific mechanism: this
// module only knows about named entries in an array. `legionRecognitionConfig`
// is included as the first real, non-hypothetical consumer (see
// `src/adapters/legion/README.md`'s Boundary section — this still only
// imports Legion's *config value* from within this same repo, never the
// Legion package/repo itself).
// ═══════════════════════════════════════════════════════════════════════════

import { legionRecognitionConfig } from '../adapters/legion/recognitionConfig';
import { defaultRecognitionConfig } from './recognitionConfig';
import type { RecognitionConfig } from './recognition';

export interface RecognitionConfigOption {
  /** Stable identifier — persisted (see `ProjectSettings.activeRecognitionConfigId`),
   *  so this must never change for an existing entry. */
  id: string;
  /** Human-readable label for the selector UI. */
  label: string;
  config: RecognitionConfig;
}

/** The list a selector UI renders. A caller adds its own config here (or to
 *  a copy) rather than this module growing source-specific knowledge beyond
 *  "here is a named list". */
export const recognitionConfigOptions: RecognitionConfigOption[] = [
  { id: 'generic', label: 'Generic (.glsl / .wgsl files)', config: defaultRecognitionConfig },
  { id: 'legion', label: 'Legion (bundled GLSL_* chunks)', config: legionRecognitionConfig },
];

export const defaultRecognitionConfigId: string = recognitionConfigOptions[0].id;

/** Looks up an option by id, falling back to the first (generic) entry for
 *  an unknown/undefined id — e.g. a persisted id from a since-removed entry. */
export function getRecognitionConfigOption(id: string | undefined): RecognitionConfigOption {
  return recognitionConfigOptions.find((option) => option.id === id) ?? recognitionConfigOptions[0];
}
