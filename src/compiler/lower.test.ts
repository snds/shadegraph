import { describe, expect, it } from 'vitest';

import { SOCKET_COMPATIBILITY, type ShaderNode, type SocketType, type SubGraph } from '../model/document';
import type { ShaderGraph } from '../model/document';
import type { SocketTypeLookup } from '../model/connect';
import { SUBGRAPH_INSTANCE_NODE_TYPE, extractSubGraph } from '../model/subgraph';
import { registerStarterNodes } from '../nodes/definitions';
import { NodeRegistry } from '../nodes/registry';
import { checkChunkRequires, createEmitSink, lowerGraph, resolveOrder } from './lower';
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

describe('lowerGraph subgraph instance inlining', () => {
  const registry = registerStarterNodes(new NodeRegistry());
  const hooks = { target: 'glsl-es' as const, coerce: coerceGlsl, literal: glslLiteral };

  // Resolves a socket's declared type straight off the starter-node registry —
  // exactly what `extractSubGraph` needs, and enough for a fixture with no
  // subgraph instances of its own yet.
  function registryLookup(graph: ShaderGraph): SocketTypeLookup {
    return (nodeId, socketId, direction) => {
      const node = graph.nodes.find((n) => n.id === nodeId);
      const def = node ? registry.get(node.type) : undefined;
      const sockets = direction === 'out' ? def?.outputs : def?.inputs;
      return sockets?.find((s) => s.id === socketId)?.type;
    };
  }

  const mkEdge = (sn: string, ss: string, tn: string, ts: string) => ({
    id: `${sn}:${ss}->${tn}:${ts}`,
    source: { node: sn, socket: ss },
    target: { node: tn, socket: ts },
  });

  it('compiles a subgraph instance to the exact same program as the equivalent ungrouped graph', () => {
    // ext_in --b--> add1 --a--> mul1 --a--> ext_out   (add1, mul1 get extracted)
    const originalGraph: ShaderGraph = {
      nodes: [
        { id: 'ext_in', type: 'math.add', position: { x: 0, y: 0 }, params: [] },
        { id: 'add1', type: 'math.add', position: { x: 100, y: 0 }, params: [] },
        { id: 'mul1', type: 'math.mul', position: { x: 200, y: 0 }, params: [] },
        { id: 'ext_out', type: 'math.add', position: { x: 300, y: 0 }, params: [] },
      ],
      edges: [
        mkEdge('ext_in', 'result', 'add1', 'b'),
        mkEdge('add1', 'result', 'mul1', 'a'),
        mkEdge('mul1', 'result', 'ext_out', 'a'),
      ],
      outputNodeId: 'ext_out',
    };

    // Ground truth: compile the ungrouped graph directly, by hand.
    const directHandle = createEmitSink();
    const directResult = lowerGraph(originalGraph, registry, hooks, directHandle.sink);
    expect(directHandle.diagnostics).toEqual([]);

    // Now actually extract `add1`/`mul1` into a real SubGraph via the model's
    // own extraction logic, instance it, and compile THAT instead.
    const extraction = extractSubGraph(originalGraph, ['add1', 'mul1'], 'AddThenMul', registryLookup(originalGraph));
    if (!extraction.ok) throw new Error(extraction.message);
    expect(extraction.parentGraph.nodes.some((n) => n.type === SUBGRAPH_INSTANCE_NODE_TYPE)).toBe(true);

    const instancedHandle = createEmitSink();
    const instancedResult = lowerGraph(
      extraction.parentGraph,
      registry,
      hooks,
      instancedHandle.sink,
      [extraction.subGraph],
    );

    expect(instancedHandle.diagnostics).toEqual([]);
    // Inlining is exact: same statements, same output expression, same
    // temp-name counter progression as compiling the original graph by hand.
    expect(instancedHandle.body).toEqual(directHandle.body);
    expect(instancedResult.outputExpr).toBe(directResult.outputExpr);
    expect(instancedResult.outputExpr).toBeDefined();
  });

  it('an unresolvable subgraph reference (unknown id) is a diagnostic, not a crash', () => {
    const graph: ShaderGraph = {
      nodes: [
        {
          id: 'inst',
          type: SUBGRAPH_INSTANCE_NODE_TYPE,
          subGraphId: 'does-not-exist',
          position: { x: 0, y: 0 },
          params: [],
        },
        { id: 'sink', type: 'math.add', position: { x: 100, y: 0 }, params: [] },
      ],
      edges: [mkEdge('inst', 'whatever', 'sink', 'a')],
      outputNodeId: 'sink',
    };
    expect(() => lowerGraph(graph, registry, hooks, createEmitSink().sink, [])).not.toThrow();

    const handle = createEmitSink();
    const result = lowerGraph(graph, registry, hooks, handle.sink, []);
    expect(result.outputExpr).toBeDefined();
    expect(handle.diagnostics.some((d) => d.level === 'error')).toBe(true);
  });
});

describe('lowerGraph subgraph recursive cycle detection', () => {
  const registry = registerStarterNodes(new NodeRegistry());
  const hooks = { target: 'glsl-es' as const, coerce: coerceGlsl, literal: glslLiteral };

  function instanceNode(id: string, subGraphId: string): ShaderNode {
    return { id, type: SUBGRAPH_INSTANCE_NODE_TYPE, subGraphId, position: { x: 0, y: 0 }, params: [] };
  }

  it('a subgraph directly instancing itself is reported as a cycle, not an infinite loop / stack overflow', () => {
    const subGraphA: SubGraph = {
      id: 'sgA',
      name: 'A',
      inputs: [],
      outputs: [{ id: 'inner:result', label: 'Out', type: 'float', direction: 'out' }],
      graph: {
        nodes: [instanceNode('inner', 'sgA')], // A instances itself, directly
        edges: [],
        outputNodeId: 'inner',
      },
    };

    const outerGraph: ShaderGraph = {
      nodes: [
        instanceNode('outerInst', 'sgA'),
        { id: 'sink', type: 'math.add', position: { x: 100, y: 0 }, params: [] },
      ],
      edges: [{ id: 'e', source: { node: 'outerInst', socket: 'inner:result' }, target: { node: 'sink', socket: 'a' } }],
      outputNodeId: 'sink',
    };

    expect(() => lowerGraph(outerGraph, registry, hooks, createEmitSink().sink, [subGraphA])).not.toThrow();

    const handle = createEmitSink();
    const result = lowerGraph(outerGraph, registry, hooks, handle.sink, [subGraphA]);

    // Falls back to `sink`'s default input safely; never hangs or throws.
    expect(result.outputExpr).toBeDefined();
    const cycleDiags = handle.diagnostics.filter((d) => /references itself/i.test(d.message));
    expect(cycleDiags).toHaveLength(1);
    expect(cycleDiags[0].level).toBe('error');
    expect(cycleDiags[0].message).toContain('sgA');
  });

  it('two subgraphs that transitively reference each other (A -> B -> A) are also reported as a cycle, not a hang', () => {
    const subGraphA: SubGraph = {
      id: 'sgA',
      name: 'A',
      inputs: [],
      outputs: [{ id: 'toB:result', label: 'Out', type: 'float', direction: 'out' }],
      graph: {
        nodes: [instanceNode('toB', 'sgB')], // A instances B
        edges: [],
        outputNodeId: 'toB',
      },
    };
    const subGraphB: SubGraph = {
      id: 'sgB',
      name: 'B',
      inputs: [],
      outputs: [{ id: 'toA:result', label: 'Out', type: 'float', direction: 'out' }],
      graph: {
        nodes: [instanceNode('toA', 'sgA')], // B instances A back
        edges: [],
        outputNodeId: 'toA',
      },
    };

    const outerGraph: ShaderGraph = {
      nodes: [
        instanceNode('outerInst', 'sgA'),
        { id: 'sink', type: 'math.add', position: { x: 100, y: 0 }, params: [] },
      ],
      edges: [{ id: 'e', source: { node: 'outerInst', socket: 'toB:result' }, target: { node: 'sink', socket: 'a' } }],
      outputNodeId: 'sink',
    };

    expect(() =>
      lowerGraph(outerGraph, registry, hooks, createEmitSink().sink, [subGraphA, subGraphB]),
    ).not.toThrow();

    const handle = createEmitSink();
    const result = lowerGraph(outerGraph, registry, hooks, handle.sink, [subGraphA, subGraphB]);

    expect(result.outputExpr).toBeDefined();
    const cycleDiags = handle.diagnostics.filter((d) => /references itself/i.test(d.message));
    expect(cycleDiags).toHaveLength(1);
    expect(cycleDiags[0].level).toBe('error');
    // The reported chain names both subgraphs involved in the transitive cycle.
    expect(cycleDiags[0].message).toContain('sgA');
    expect(cycleDiags[0].message).toContain('sgB');
  });
});

describe('checkChunkRequires', () => {
  // `chunk.raw` nodes have no sockets (see `src/nodes/definitions/chunk.ts`),
  // so they can never actually appear in `resolveOrder`'s edge-reachable
  // subgraph together — exercised directly against a hand-built `order`
  // instead of round-tripping through `lowerGraph`/`resolveOrder`.
  function chunkNode(id: string, name: string, requires: string[] = []): ShaderNode {
    return {
      id,
      type: 'chunk.raw',
      position: { x: 0, y: 0 },
      params: [],
      chunkSource: { name, text: `/* ${name} */`, requires },
    };
  }

  it('is silent when every requires name is present and correctly ordered', () => {
    const graph: ShaderGraph = {
      nodes: [chunkNode('a', 'GLSL_FBM'), chunkNode('b', 'GLSL_CLOUDS', ['GLSL_FBM'])],
      edges: [],
      outputNodeId: 'b',
    };
    const handle = createEmitSink();

    checkChunkRequires(graph, ['a', 'b'], handle.sink);

    expect(handle.diagnostics).toEqual([]);
  });

  it('is silent for a graph with no chunk nodes at all', () => {
    const graph: ShaderGraph = {
      nodes: [{ id: 'a', type: 'input.uv', position: { x: 0, y: 0 }, params: [] }],
      edges: [],
      outputNodeId: 'a',
    };
    const handle = createEmitSink();

    checkChunkRequires(graph, ['a'], handle.sink);

    expect(handle.diagnostics).toEqual([]);
  });

  it('warns when a required chunk is absent from the graph', () => {
    const graph: ShaderGraph = {
      nodes: [chunkNode('b', 'GLSL_CLOUDS', ['GLSL_FBM', 'GLSL_PLATES'])],
      edges: [],
      outputNodeId: 'b',
    };
    const handle = createEmitSink();

    checkChunkRequires(graph, ['b'], handle.sink);

    expect(handle.diagnostics).toHaveLength(2);
    for (const d of handle.diagnostics) {
      expect(d.level).toBe('warning');
      expect(d.nodeId).toBe('b');
    }
    expect(handle.diagnostics[0].message).toContain('GLSL_FBM');
    expect(handle.diagnostics[1].message).toContain('GLSL_PLATES');
  });

  it('warns when a required chunk is present but emitted after it', () => {
    const graph: ShaderGraph = {
      nodes: [chunkNode('a', 'GLSL_CLOUDS', ['GLSL_FBM']), chunkNode('b', 'GLSL_FBM')],
      edges: [],
      outputNodeId: 'a',
    };
    const handle = createEmitSink();

    // 'a' (which requires 'GLSL_FBM') is emitted BEFORE 'b' (which IS
    // 'GLSL_FBM') in this order — the wrong way around.
    checkChunkRequires(graph, ['a', 'b'], handle.sink);

    expect(handle.diagnostics).toHaveLength(1);
    expect(handle.diagnostics[0].level).toBe('warning');
    expect(handle.diagnostics[0].nodeId).toBe('a');
    expect(handle.diagnostics[0].message).toContain('come before it');
  });

  it('does not flag a required chunk that is present but not part of the resolved order (e.g. pruned)', () => {
    const graph: ShaderGraph = {
      nodes: [chunkNode('a', 'GLSL_CLOUDS', ['GLSL_FBM']), chunkNode('b', 'GLSL_FBM')],
      edges: [],
      outputNodeId: 'a',
    };
    const handle = createEmitSink();

    // 'b' never made it into `order` at all (as if pruned/unreachable) —
    // absent-from-order is treated as "can't confirm ordering", not a
    // second, redundant "missing" diagnostic (it IS present in the graph).
    checkChunkRequires(graph, ['a'], handle.sink);

    expect(handle.diagnostics).toEqual([]);
  });
});
