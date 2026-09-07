// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Color nodes
// `color.ramp`
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeDefinition } from '../registry';
import { inp, out } from '../registry';
import { param, paramUniform } from './helpers';

export const colorRamp: NodeDefinition = {
  type: 'color.ramp',
  category: 'color',
  title: 'Color Ramp',
  description: 'Maps a scalar 0..1 through a two-stop gradient. Feeds noise into colour.',
  inputs: [inp('t', 'Factor', 'float', 0)],
  outputs: [out('color', 'Color', 'color')],
  params: [
    param('colorA', 'Start Color', 'color', [0, 0, 0], 'color'),
    param('posA', 'Start Position', 'float', 0, 'slider', { min: 0, max: 1, step: 0.001 }),
    param('colorB', 'End Color', 'color', [1, 1, 1], 'color'),
    param('posB', 'End Position', 'float', 1, 'slider', { min: 0, max: 1, step: 0.001 }),
  ],
  previewable: true,
  emit: {
    'glsl-es': (node, ctx) => {
      const t = ctx.input(node.id, 't');
      const colorA = paramUniform(ctx, node, 'colorA', 'color', [0, 0, 0]);
      const colorB = paramUniform(ctx, node, 'colorB', 'color', [1, 1, 1]);
      const posA = paramUniform(ctx, node, 'posA', 'float', 0);
      const posB = paramUniform(ctx, node, 'posB', 'float', 1);
      const k = ctx.temp('rampT');
      const v = ctx.temp('ramp');
      ctx.emit(`float ${k} = smoothstep(${posA}, ${posB}, ${t});`);
      ctx.emit(`vec3 ${v} = mix(${colorA}, ${colorB}, ${k});`);
      return v;
    },
    'wgsl': (node, ctx) => {
      const t = ctx.input(node.id, 't');
      const colorA = paramUniform(ctx, node, 'colorA', 'color', [0, 0, 0]);
      const colorB = paramUniform(ctx, node, 'colorB', 'color', [1, 1, 1]);
      const posA = paramUniform(ctx, node, 'posA', 'float', 0);
      const posB = paramUniform(ctx, node, 'posB', 'float', 1);
      const k = ctx.temp('rampT');
      const v = ctx.temp('ramp');
      ctx.emit(`let ${k}: f32 = smoothstep(${posA}, ${posB}, ${t});`);
      ctx.emit(`let ${v}: vec3<f32> = mix(${colorA}, ${colorB}, ${k});`);
      return v;
    },
  },
};
