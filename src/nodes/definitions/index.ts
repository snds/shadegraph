// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Starter node definitions (Phase 1)
// ───────────────────────────────────────────────────────────────────────────
// Importing this module registers the Phase 1 (+ Phase 3 mask, + Phase 5's
// generic imported-chunk node) node set into the `nodes` registry singleton,
// so the palette, connection validation, and the inspector all have real
// definitions to work with:
//
//   input.uv · input.time · math.add · math.mul · math.mix · noise.fbm ·
//   color.ramp · output.surface · output.mask · chunk.raw
//
// Pure data + emitters. No React, no DOM, no GPU.
// ═══════════════════════════════════════════════════════════════════════════

import { nodes, type NodeDefinition, type NodeRegistry } from '../registry';
import { inputTime, inputUv } from './input';
import { mathAdd, mathMix, mathMul } from './math';
import { noiseFbm } from './noise';
import { colorRamp } from './color';
import { outputSurface } from './output';
import { outputMask } from './mask';
import { chunkRaw } from './chunk';

/** The Phase 1 starter set (+ Phase 3's `output.mask`, + Phase 5's
 *  `chunk.raw`), in palette order. */
export const starterDefinitions: NodeDefinition[] = [
  inputUv,
  inputTime,
  mathAdd,
  mathMul,
  mathMix,
  noiseFbm,
  colorRamp,
  outputSurface,
  outputMask,
  chunkRaw,
];

/** Idempotent: safe to call more than once, and against a throwaway registry
 *  in tests. Registering an already-present type is a no-op rather than the
 *  duplicate-type throw, so repeated imports cannot break the app. */
export function registerStarterNodes(registry: NodeRegistry = nodes): NodeRegistry {
  for (const def of starterDefinitions) {
    if (!registry.get(def.type)) registry.register(def);
  }
  return registry;
}

// Side-effect: populate the shared singleton on import.
registerStarterNodes();

export { inputUv, inputTime, mathAdd, mathMul, mathMix, noiseFbm, colorRamp, outputSurface, outputMask, chunkRaw };
export { OUTPUT_NODE_TYPE } from './output';
export { OUTPUT_MASK_NODE_TYPE } from './mask';
export { CHUNK_RAW_NODE_TYPE } from './chunk';
export { ident, param, paramUniform, paramValue } from './helpers';
