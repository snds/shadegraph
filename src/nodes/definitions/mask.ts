// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Mask output node
// `output.mask`
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeDefinition } from '../registry';
import { inp } from '../registry';

/** Terminal node for a layer's `maskGraph` (see `ShaderLayer.maskGraph` in
 *  `model/document.ts`) — mirrors `output.surface`'s role as a graph terminal,
 *  but narrower: a mask's only job is a single grayscale value, multiplied
 *  per-pixel into its owning layer's contribution during compositing. */
export const outputMask: NodeDefinition = {
  type: 'output.mask',
  category: 'output',
  title: 'Mask Output',
  description:
    "Terminal node for a mask graph: the single grayscale value multiplied into this mask's layer, per-pixel.",
  guidance:
    "Only appears when editing a layer's mask (via the layer stack's mask affordance), never a main graph. Wire a noise/ramp chain into Value; the result multiplies that layer's opacity per-pixel.",
  inputs: [inp('value', 'Value', 'float', 1)],
  outputs: [],
  params: [],
  previewable: true,
  emit: {
    'glsl-es': (node, ctx) => {
      const value = ctx.input(node.id, 'value');
      const v = ctx.temp('mask');
      ctx.emit(`float ${v} = clamp(${value}, 0.0, 1.0);`);
      return v;
    },
  },
};

/** The terminal node type every mask graph ends on (`ShaderGraph.outputNodeId`
 *  when that graph is a `ShaderLayer.maskGraph`). */
export const OUTPUT_MASK_NODE_TYPE = outputMask.type;
