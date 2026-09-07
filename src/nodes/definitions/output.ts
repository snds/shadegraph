// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Output nodes
// `output.surface`
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeDefinition } from '../registry';
import { inp } from '../registry';

export const outputSurface: NodeDefinition = {
  type: 'output.surface',
  category: 'output',
  title: 'Surface Output',
  description: 'Terminal node: the shaded surface this layer contributes.',
  inputs: [
    inp('baseColor', 'Base Color', 'color', [0.5, 0.5, 0.5]),
    inp('roughness', 'Roughness', 'float', 0.5),
    inp('metallic', 'Metallic', 'float', 0),
    inp('normal', 'Normal', 'normal', [0, 0, 1]),
    inp('emissive', 'Emissive', 'color', [0, 0, 0]),
    inp('opacity', 'Opacity', 'float', 1),
  ],
  outputs: [],
  params: [],
  previewable: true,
  emit: {
    'glsl-es': (node, ctx) => {
      const baseColor = ctx.input(node.id, 'baseColor');
      const emissive = ctx.input(node.id, 'emissive');
      const opacity = ctx.input(node.id, 'opacity');
      const v = ctx.temp('surface');
      ctx.emit(`vec4 ${v} = vec4(${baseColor} + ${emissive}, ${opacity});`);
      ctx.emit(`gl_FragColor = ${v};`);
      return v;
    },
    // No `gl_FragColor`-equivalent side effect here (unlike glsl-es): this
    // node's emitter runs once per layer inside `wgsl.ts`'s `compileDocument`
    // composite loop, all sharing ONE `sg_main` body — an actual WGSL
    // `return` statement here would exit the function after the first layer
    // instead of falling through to compositing. The wgsl backend adds the
    // real final `return` itself (single-graph compile: this expression
    // directly; composite: the blended result). See the wgsl backend's task
    // report for the full reconciliation notes.
    'wgsl': (node, ctx) => {
      const baseColor = ctx.input(node.id, 'baseColor');
      const emissive = ctx.input(node.id, 'emissive');
      const opacity = ctx.input(node.id, 'opacity');
      const v = ctx.temp('surface');
      ctx.emit(`let ${v}: vec4<f32> = vec4<f32>(${baseColor} + ${emissive}, ${opacity});`);
      return v;
    },
  },
};

/** The terminal node type every layer graph ends on (`ShaderGraph.outputNodeId`). */
export const OUTPUT_NODE_TYPE = outputSurface.type;
