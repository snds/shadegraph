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
  },
};

/** The terminal node type every layer graph ends on (`ShaderGraph.outputNodeId`). */
export const OUTPUT_NODE_TYPE = outputSurface.type;
