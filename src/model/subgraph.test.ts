import { describe, expect, it } from 'vitest';

import type { ShaderGraph, SocketType } from './document';
import type { SocketTypeLookup } from './connect';
import {
  SUBGRAPH_INSTANCE_NODE_TYPE,
  extractSubGraph,
  findSubGraph,
  instantiateSubGraph,
  isSubGraphInstanceNode,
  subGraphInstanceSocket,
} from './subgraph';

// A tiny fixture, same treatment as connect.test.ts: no node registry, no
// store, no React — a hand-rolled `SocketTypeLookup` is enough.
//
//   uv      out uv:vec2
//   a       in x:float   out y:float
//   b       in x:float   out y:float
//   surface in albedo:color   out out:color
const TYPES = new Map<string, SocketType>([
  ['uv|uv|out', 'vec2'],
  ['a|x|in', 'float'],
  ['a|y|out', 'float'],
  ['b|x|in', 'float'],
  ['b|y|out', 'float'],
  ['surface|albedo|in', 'color'],
]);

const lookup: SocketTypeLookup = (nodeId, socketId, direction) => TYPES.get(`${nodeId}|${socketId}|${direction}`);

const edge = (sn: string, ss: string, tn: string, ts: string) => ({
  id: `${sn}:${ss}->${tn}:${ts}`,
  source: { node: sn, socket: ss },
  target: { node: tn, socket: ts },
});

function graph(): ShaderGraph {
  return {
    nodes: [
      { id: 'uv', type: 'input.uv', position: { x: 0, y: 0 }, params: [] },
      { id: 'a', type: 'math.mix', position: { x: 100, y: 0 }, params: [] },
      { id: 'b', type: 'math.mix', position: { x: 300, y: 0 }, params: [] },
      { id: 'surface', type: 'output.surface', position: { x: 500, y: 0 }, params: [] },
    ],
    edges: [
      edge('uv', 'uv', 'a', 'x'), // crosses INTO the eventual selection
      edge('a', 'y', 'b', 'x'), // internal to the eventual selection
      edge('b', 'y', 'surface', 'albedo'), // crosses OUT of the eventual selection
    ],
    outputNodeId: 'surface',
  };
}

describe('extractSubGraph', () => {
  it('moves the selection + internal edges into a new SubGraph and replaces them with one instance', () => {
    const result = extractSubGraph(graph(), ['a', 'b'], 'Wobble', lookup);
    if (!result.ok) throw new Error(result.message);

    expect(result.subGraph.name).toBe('Wobble');
    expect(result.subGraph.graph.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
    expect(result.subGraph.graph.edges).toHaveLength(1);
    expect(result.subGraph.graph.edges[0]).toMatchObject({ source: { node: 'a' }, target: { node: 'b' } });

    expect(result.subGraph.inputs).toEqual([{ id: 'a:x', label: 'X', type: 'float', direction: 'in' }]);
    expect(result.subGraph.outputs).toEqual([{ id: 'b:y', label: 'Y', type: 'float', direction: 'out' }]);

    const instance = result.parentGraph.nodes.find((n) => n.id === result.instanceNodeId);
    expect(instance).toBeDefined();
    expect(instance?.type).toBe(SUBGRAPH_INSTANCE_NODE_TYPE);
    expect(instance?.subGraphId).toBe(result.subGraph.id);
    expect(result.parentGraph.nodes.map((n) => n.id).sort()).toEqual(
      ['surface', 'uv', result.instanceNodeId].sort(),
    );
  });

  it('rewrites crossing edges onto the instance node at the exposed socket ids, preserving connectivity', () => {
    const result = extractSubGraph(graph(), ['a', 'b'], 'Wobble', lookup);
    if (!result.ok) throw new Error(result.message);

    expect(result.parentGraph.edges).toContainEqual(
      expect.objectContaining({ source: { node: 'uv', socket: 'uv' }, target: { node: result.instanceNodeId, socket: 'a:x' } }),
    );
    expect(result.parentGraph.edges).toContainEqual(
      expect.objectContaining({ source: { node: result.instanceNodeId, socket: 'b:y' }, target: { node: 'surface', socket: 'albedo' } }),
    );
  });

  it('dedupes an exposed output that fans out to multiple external targets', () => {
    const g = graph();
    g.nodes.push({ id: 'surface2', type: 'output.surface', position: { x: 500, y: 200 }, params: [] });
    g.edges.push(edge('b', 'y', 'surface2', 'albedo'));
    TYPES.set('surface2|albedo|in', 'color');

    const result = extractSubGraph(g, ['a', 'b'], 'Wobble', lookup);
    if (!result.ok) throw new Error(result.message);

    expect(result.subGraph.outputs).toHaveLength(1);
    expect(result.parentGraph.edges.filter((e) => e.source.node === result.instanceNodeId)).toHaveLength(2);
  });

  it('refuses to extract the graph output node', () => {
    const result = extractSubGraph(graph(), ['surface'], 'Nope', lookup);
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/output node/) });
  });

  it('refuses an empty (fully-unresolvable) selection', () => {
    const result = extractSubGraph(graph(), ['ghost'], 'Nope', lookup);
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/select at least one/i) });
  });

  it('names an untitled extraction "Subgraph"', () => {
    const result = extractSubGraph(graph(), ['a'], '   ', lookup);
    if (!result.ok) throw new Error(result.message);
    expect(result.subGraph.name).toBe('Subgraph');
  });
});

describe('instance identification + socket resolution', () => {
  it('isSubGraphInstanceNode only matches the reserved type', () => {
    expect(isSubGraphInstanceNode({ type: SUBGRAPH_INSTANCE_NODE_TYPE })).toBe(true);
    expect(isSubGraphInstanceNode({ type: 'math.mix' })).toBe(false);
  });

  it('instantiateSubGraph produces a node referencing the subgraph, with no copied sockets', () => {
    const result = extractSubGraph(graph(), ['a', 'b'], 'Wobble', lookup);
    if (!result.ok) throw new Error(result.message);

    const node = instantiateSubGraph(result.subGraph, { x: 10, y: 20 });
    expect(node.type).toBe(SUBGRAPH_INSTANCE_NODE_TYPE);
    expect(node.subGraphId).toBe(result.subGraph.id);
    expect(node.position).toEqual({ x: 10, y: 20 });
    expect(node.params).toEqual([]);
  });

  it('subGraphInstanceSocket resolves live from the SubGraph, not a copy', () => {
    const result = extractSubGraph(graph(), ['a', 'b'], 'Wobble', lookup);
    if (!result.ok) throw new Error(result.message);
    const node = instantiateSubGraph(result.subGraph, { x: 0, y: 0 });

    expect(subGraphInstanceSocket([result.subGraph], node, 'a:x', 'in')).toMatchObject({ type: 'float' });
    expect(subGraphInstanceSocket([result.subGraph], node, 'b:y', 'out')).toMatchObject({ type: 'float' });
    expect(subGraphInstanceSocket([result.subGraph], node, 'nope', 'in')).toBeUndefined();

    // Editing the interface (append a new input) is visible immediately —
    // there is nothing on `node` itself to go stale.
    const edited = { ...result.subGraph, inputs: [...result.subGraph.inputs, { id: 'new', label: 'New', type: 'bool' as const, direction: 'in' as const }] };
    expect(subGraphInstanceSocket([edited], node, 'new', 'in')).toMatchObject({ type: 'bool' });
  });

  it('findSubGraph returns undefined for an unknown or missing id', () => {
    expect(findSubGraph([], undefined)).toBeUndefined();
    expect(findSubGraph([], 'nope')).toBeUndefined();
  });
});
