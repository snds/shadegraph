// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Input nodes
// `input.uv` · `input.time`
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeDefinition } from '../registry';
import { out } from '../registry';
import { param, paramUniform } from './helpers';

export const inputUv: NodeDefinition = {
  type: 'input.uv',
  category: 'input',
  title: 'UV',
  description: 'Surface texture coordinates, with optional tiling and offset.',
  guidance:
    'Start here for anything pattern-based. Feed the UV output into noise, ramps, or math nodes; raise Tiling to repeat a pattern, or animate Offset for scrolling effects.',
  inputs: [],
  outputs: [out('uv', 'UV', 'vec2')],
  params: [
    param('tiling', 'Tiling', 'vec2', [1, 1], 'vector', { step: 0.01 }),
    param('offset', 'Offset', 'vec2', [0, 0], 'vector', { step: 0.01 }),
  ],
  previewable: true,
  emit: {
    'glsl-es': (node, ctx) => {
      const tiling = paramUniform(ctx, node, 'tiling', 'vec2', [1, 1]);
      const offset = paramUniform(ctx, node, 'offset', 'vec2', [0, 0]);
      const v = ctx.temp('uv');
      ctx.emit(`vec2 ${v} = vUv * ${tiling} + ${offset};`);
      return v;
    },
    'wgsl': (node, ctx) => {
      const tiling = paramUniform(ctx, node, 'tiling', 'vec2', [1, 1]);
      const offset = paramUniform(ctx, node, 'offset', 'vec2', [0, 0]);
      const v = ctx.temp('uv');
      ctx.emit(`let ${v}: vec2<f32> = vUv * ${tiling} + ${offset};`);
      return v;
    },
  },
};

export const inputTime: NodeDefinition = {
  type: 'input.time',
  category: 'input',
  title: 'Time',
  description: 'Seconds since start, scaled by speed. Drives animated shaders.',
  guidance:
    'Wire into a UV offset, noise seed, or math node to animate it. Speed scales the clock — 0 freezes it, negative runs it backwards.',
  inputs: [],
  outputs: [out('time', 'Time', 'float')],
  params: [param('speed', 'Speed', 'float', 1, 'slider', { min: 0, max: 10, step: 0.01 })],
  previewable: false,
  emit: {
    'glsl-es': (node, ctx) => {
      const speed = paramUniform(ctx, node, 'speed', 'float', 1);
      const time = ctx.uniform({ name: 'uTime', type: 'float', default: 0 });
      const v = ctx.temp('time');
      ctx.emit(`float ${v} = ${time} * ${speed};`);
      return v;
    },
    'wgsl': (node, ctx) => {
      const speed = paramUniform(ctx, node, 'speed', 'float', 1);
      const time = ctx.uniform({ name: 'uTime', type: 'float', default: 0 });
      const v = ctx.temp('time');
      ctx.emit(`let ${v}: f32 = ${time} * ${speed};`);
      return v;
    },
  },
};
