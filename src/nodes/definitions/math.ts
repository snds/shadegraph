// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Math nodes
// `math.add` · `math.mul` · `math.mix`
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeDefinition } from '../registry';
import { inp, out } from '../registry';

export const mathAdd: NodeDefinition = {
  type: 'math.add',
  category: 'math',
  title: 'Add',
  description: 'a + b.',
  inputs: [inp('a', 'A', 'float', 0), inp('b', 'B', 'float', 0)],
  outputs: [out('result', 'Result', 'float')],
  params: [],
  previewable: true,
  bypass: { input: 'a', output: 'result' },
  emit: {
    'glsl-es': (node, ctx) => {
      const a = ctx.input(node.id, 'a');
      const b = ctx.input(node.id, 'b');
      const v = ctx.temp('add');
      ctx.emit(`float ${v} = ${a} + ${b};`);
      return v;
    },
    'wgsl': (node, ctx) => {
      const a = ctx.input(node.id, 'a');
      const b = ctx.input(node.id, 'b');
      const v = ctx.temp('add');
      ctx.emit(`let ${v}: f32 = ${a} + ${b};`);
      return v;
    },
  },
};

export const mathMul: NodeDefinition = {
  type: 'math.mul',
  category: 'math',
  title: 'Multiply',
  description: 'a * b.',
  inputs: [inp('a', 'A', 'float', 1), inp('b', 'B', 'float', 1)],
  outputs: [out('result', 'Result', 'float')],
  params: [],
  previewable: true,
  bypass: { input: 'a', output: 'result' },
  emit: {
    'glsl-es': (node, ctx) => {
      const a = ctx.input(node.id, 'a');
      const b = ctx.input(node.id, 'b');
      const v = ctx.temp('mul');
      ctx.emit(`float ${v} = ${a} * ${b};`);
      return v;
    },
    'wgsl': (node, ctx) => {
      const a = ctx.input(node.id, 'a');
      const b = ctx.input(node.id, 'b');
      const v = ctx.temp('mul');
      ctx.emit(`let ${v}: f32 = ${a} * ${b};`);
      return v;
    },
  },
};

export const mathMix: NodeDefinition = {
  type: 'math.mix',
  category: 'math',
  title: 'Mix',
  description: 'Linear blend between A and B by a scalar factor.',
  inputs: [
    inp('a', 'A', 'vec3', [0, 0, 0]),
    inp('b', 'B', 'vec3', [1, 1, 1]),
    // Deliberately `float`: a vec2 (e.g. input.uv) must be refused here.
    inp('t', 'Factor', 'float', 0.5),
  ],
  outputs: [out('result', 'Result', 'vec3')],
  params: [],
  previewable: true,
  bypass: { input: 'a', output: 'result' },
  emit: {
    'glsl-es': (node, ctx) => {
      const a = ctx.input(node.id, 'a');
      const b = ctx.input(node.id, 'b');
      const t = ctx.input(node.id, 't');
      const v = ctx.temp('mix');
      ctx.emit(`vec3 ${v} = mix(${a}, ${b}, clamp(${t}, 0.0, 1.0));`);
      return v;
    },
    'wgsl': (node, ctx) => {
      const a = ctx.input(node.id, 'a');
      const b = ctx.input(node.id, 'b');
      const t = ctx.input(node.id, 't');
      const v = ctx.temp('mix');
      ctx.emit(`let ${v}: vec3<f32> = mix(${a}, ${b}, clamp(${t}, 0.0, 1.0));`);
      return v;
    },
  },
};
