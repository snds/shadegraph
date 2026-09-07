// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Noise nodes
// `noise.fbm`
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeDefinition } from '../registry';
import { inp, out } from '../registry';
import { param, paramUniform, paramValue } from './helpers';

export const noiseFbm: NodeDefinition = {
  type: 'noise.fbm',
  category: 'noise',
  title: 'FBM Noise',
  description: 'Fractal Brownian motion: summed octaves of value noise over a UV.',
  inputs: [inp('uv', 'UV', 'vec2', [0, 0])],
  outputs: [out('value', 'Value', 'float')],
  params: [
    param('frequency', 'Frequency', 'float', 2, 'slider', { min: 0.1, max: 32, step: 0.1 }),
    param('octaves', 'Octaves', 'int', 4, 'slider', { min: 1, max: 8, step: 1 }),
    param('lacunarity', 'Lacunarity', 'float', 2, 'slider', { min: 1, max: 4, step: 0.01 }),
    param('gain', 'Gain', 'float', 0.5, 'slider', { min: 0, max: 1, step: 0.01 }),
    param('seed', 'Seed', 'float', 0, 'number', { step: 1 }),
  ],
  previewable: true,
  emit: {
    'glsl-es': (node, ctx) => {
      const uv = ctx.input(node.id, 'uv');
      const frequency = paramUniform(ctx, node, 'frequency', 'float', 2);
      const lacunarity = paramUniform(ctx, node, 'lacunarity', 'float', 2);
      const gain = paramUniform(ctx, node, 'gain', 'float', 0.5);
      const seed = paramUniform(ctx, node, 'seed', 'float', 0);
      // Octave count must be a compile-time loop bound in GLSL ES 1.0, so it is
      // baked from the param rather than passed as a uniform.
      const octaves = Math.max(1, Math.round(Number(paramValue(node, 'octaves', 4))));
      const v = ctx.temp('fbm');
      // `sg_fbm` comes from the backend's shared prelude (Phase 2).
      ctx.emit(
        `float ${v} = sg_fbm(${uv} * ${frequency} + ${seed}, ${octaves}, ${lacunarity}, ${gain});`,
      );
      return v;
    },
    'wgsl': (node, ctx) => {
      const uv = ctx.input(node.id, 'uv');
      const frequency = paramUniform(ctx, node, 'frequency', 'float', 2);
      const lacunarity = paramUniform(ctx, node, 'lacunarity', 'float', 2);
      const gain = paramUniform(ctx, node, 'gain', 'float', 0.5);
      const seed = paramUniform(ctx, node, 'seed', 'float', 0);
      // WGSL for-loops allow a non-constant bound (see `sg_fbm` in the wgsl
      // backend's prelude), but `octaves` is still baked as a compile-time
      // literal here — same node-level tradeoff as glsl-es, kept for parity
      // (a live octave slider would need to become a uniform in BOTH
      // backends, which is out of this task's scope).
      const octaves = Math.max(1, Math.round(Number(paramValue(node, 'octaves', 4))));
      const v = ctx.temp('fbm');
      ctx.emit(
        `let ${v}: f32 = sg_fbm(${uv} * ${frequency} + vec2<f32>(${seed}), ${octaves}, ${lacunarity}, ${gain});`,
      );
      return v;
    },
  },
};
