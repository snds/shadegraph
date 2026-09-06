import { describe, expect, it } from 'vitest';

import { SOCKET_COMPATIBILITY, type SocketType } from '../model/document';
import type { ShaderGraph } from '../model/document';
import { registerStarterNodes } from '../nodes/definitions';
import { NodeRegistry } from '../nodes/registry';
import { createEmitSink, lowerGraph, resolveOrder } from './lower';
import { coerceGlsl, glslLiteral } from './backends/glsl-es';

// Pure-topology fixtures. No node registry needed for `resolveOrder`.
function node(id: string) {
  return { id, type: 'noop', position: { x: 0, y: 0 }, params: [] };
}

describe('resolveOrder', () => {
  it('orders a simple diamond dependency-first', () => {
    const graph: ShaderGraph = {
      nodes: [node('a'), node('b'), node('c'), node('out')],
      edges: [
        { id: 'a->b', source: { node: 'a', socket: 'o' }, target: { node: 'b', socket: 'i' } },
        { id: 'a->c', source: { node: 'a', socket: 'o' }, target: { node: 'c', socket: 'i' } },
        { id: 'b->out', source: { node: 'b', socket: 'o' }, target: { node: 'out', socket: 'i' } },
        { id: 'c->out', source: { node: 'c', socket: 'o' }, target: { node: 'out', socket: 'i2' } },
      ],
      outputNodeId: 'out',
    };
    const result = resolveOrder(graph);
    expect(result.diagnostics).toEqual([]);
    expect(result.pruned).toEqual([]);
    expect(result.cyclic).toEqual([]);
    expect(result.order.indexOf('a')).toBeLessThan(result.order.indexOf('b'));
    expect(result.order.indexOf('a')).toBeLessThan(result.order.indexOf('c'));
    expect(result.order.indexOf('b')).toBeLessThan(result.order.indexOf('out'));
    expect(result.order.indexOf('c')).toBeLessThan(result.order.indexOf('out'));
  });

  it('prunes nodes not reachable from the output', () => {
    const graph: ShaderGraph = {
      nodes: [node('live'), node('dead'), node('out')],
      edges: [
        { id: 'live->out', source: { node: 'live', socket: 'o' }, target: { node: 'out', socket: 'i' } },
      ],
      outputNodeId: 'out',
    };
    const result = resolveOrder(graph);
    expect(result.order).toEqual(['live', 'out']);
    expect(result.pruned).toEqual(['dead']);
    expect(result.diagnostics).toEqual([]);
  });

  it('detects a cycle and reports a diagnostic for every node that can never resolve, without throwing', () => {
    const graph: ShaderGraph = {
      nodes: [node('a'), node('b'), node('out')],
      edges: [
        { id: 'a->b', source: { node: 'a', socket: 'o' }, target: { node: 'b', socket: 'i' } },
        { id: 'b->a', source: { node: 'b', socket: 'o' }, target: { node: 'a', socket: 'i' } },
        { id: 'b->out', source: { node: 'b', socket: 'o' }, target: { node: 'out', socket: 'i' } },
      ],
      outputNodeId: 'out',
    };
    expect(() => resolveOrder(graph)).not.toThrow();
    const result = resolveOrder(graph);
    expect(result.order).toEqual([]);
    // `out` depends entirely on the a<->b cycle, so it can never be
    // topologically resolved either — it is honestly reported alongside the
    // cycle itself, not silently dropped or falsely ordered.
    expect(new Set(result.cyclic)).toEqual(new Set(['a', 'b', 'out']));
    expect(result.diagnostics).toHaveLength(3);
    for (const d of result.diagnostics) {
      expect(d.level).toBe('error');
      expect(d.nodeId).toBeDefined();
    }
  });

  it('a node feeding output alongside a cycle still resolves itself, even though output cannot', () => {
    // `out` takes one input from `c` (no dependency on the cycle) and another
    // from the a<->b cycle. `out` itself can never resolve (one of its inputs
    // never will), but `c` is fully independent and must still topo-sort.
    const graph: ShaderGraph = {
      nodes: [node('a'), node('b'), node('c'), node('out')],
      edges: [
        { id: 'a->b', source: { node: 'a', socket: 'o' }, target: { node: 'b', socket: 'i' } },
        { id: 'b->a', source: { node: 'b', socket: 'o' }, target: { node: 'a', socket: 'i' } },
        { id: 'b->out', source: { node: 'b', socket: 'o' }, target: { node: 'out', socket: 'i2' } },
        { id: 'c->out', source: { node: 'c', socket: 'o' }, target: { node: 'out', socket: 'i1' } },
      ],
      outputNodeId: 'out',
    };
    const result = resolveOrder(graph);
    expect(result.order).toEqual(['c']);
    expect(new Set(result.cyclic)).toEqual(new Set(['a', 'b', 'out']));
    expect(result.pruned).toEqual([]);
  });

  it('reports a diagnostic (not a throw) when the output node id does not exist', () => {
    const graph: ShaderGraph = { nodes: [node('a')], edges: [], outputNodeId: 'missing' };
    const result = resolveOrder(graph);
    expect(result.order).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].level).toBe('error');
  });

  it('is deterministic across ties (alphabetical node-id tie-break)', () => {
    const graph: ShaderGraph = {
      nodes: [node('z'), node('y'), node('x'), node('out')],
      edges: [
        { id: 'x->out', source: { node: 'x', socket: 'o' }, target: { node: 'out', socket: 'a' } },
        { id: 'y->out', source: { node: 'y', socket: 'o' }, target: { node: 'out', socket: 'b' } },
        { id: 'z->out', source: { node: 'z', socket: 'o' }, target: { node: 'out', socket: 'c' } },
      ],
      outputNodeId: 'out',
    };
    const first = resolveOrder(graph).order;
    const second = resolveOrder(graph).order;
    expect(first).toEqual(second);
    expect(first).toEqual(['x', 'y', 'z', 'out']);
  });
});

describe('GLSL_COERCIONS exhaustiveness against SOCKET_COMPATIBILITY', () => {
  const SOCKET_TYPES = Object.keys(SOCKET_COMPATIBILITY) as SocketType[];

  it('supplies a real conversion for every non-identity permitted (from, to) pair', () => {
    const missing: string[] = [];
    for (const to of SOCKET_TYPES) {
      for (const from of SOCKET_COMPATIBILITY[to]) {
        if (from === to) continue;
        if (coerceGlsl('x', from, to) === undefined) missing.push(`${from}->${to}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('lowerGraph dispatch', () => {
  const registry = registerStarterNodes(new NodeRegistry());
  const hooks = { target: 'glsl-es' as const, coerce: coerceGlsl, literal: glslLiteral };

  it('dispatches a two-node chain and resolves the unconnected default literal', () => {
    const graph: ShaderGraph = {
      nodes: [
        { id: 'uv1', type: 'input.uv', position: { x: 0, y: 0 }, params: [] },
        { id: 'mul1', type: 'math.mul', position: { x: 0, y: 0 }, params: [] },
      ],
      edges: [],
      outputNodeId: 'mul1',
    };
    const handle = createEmitSink();
    const result = lowerGraph(graph, registry, hooks, handle.sink);
    expect(result.outputExpr).toBeDefined();
    expect(handle.body.some((l) => l.includes('* 1.0'))).toBe(true);
    expect(handle.diagnostics).toEqual([]);
  });

  it('emits a diagnostic and a safe literal fallback for an unknown node type', () => {
    const graph: ShaderGraph = {
      nodes: [{ id: 'ghost', type: 'nope.doesnotexist', position: { x: 0, y: 0 }, params: [] }],
      edges: [],
      outputNodeId: 'ghost',
    };
    const handle = createEmitSink();
    const result = lowerGraph(graph, registry, hooks, handle.sink);
    expect(result.outputExpr).toBe('0.0');
    expect(handle.diagnostics).toHaveLength(1);
    expect(handle.diagnostics[0].level).toBe('error');
  });

  it('a bypassed node (math.mix) skips its emitter and passes A straight through', () => {
    const graph: ShaderGraph = {
      nodes: [
        {
          id: 'mix1',
          type: 'math.mix',
          position: { x: 0, y: 0 },
          params: [],
          bypassed: true,
        },
      ],
      edges: [],
      outputNodeId: 'mix1',
    };
    const handle = createEmitSink();
    const result = lowerGraph(graph, registry, hooks, handle.sink);
    // Bypass input 'a' (vec3, default [0,0,0]) === bypass output 'result'
    // (vec3): same type, so the pass-through is the literal itself, and no
    // `vec3 mix_... = mix(...)` statement is ever emitted.
    expect(result.outputExpr).toBe('vec3(0.0, 0.0, 0.0)');
    expect(handle.body).toEqual([]);
  });
});
