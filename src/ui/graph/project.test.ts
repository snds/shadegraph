// The canvas is a projection, so the projection is where it can silently lie:
// a dropped socket id, an output node that becomes deletable, an edge tinted by
// the wrong end. These run in a plain node environment — `project.ts` imports
// React Flow for TYPES ONLY, which is exactly the boundary being asserted.

import { describe, expect, it } from 'vitest';

import type { ShaderGraph } from '../../model/document';
import type { SocketTypeLookup } from '../../model/connect';
import { endpointsFrom, SHADER_NODE_TYPE, toFlowEdges, toFlowNodes } from './project';
import { SOCKET_COLORS, socketColor } from './socketStyle';

function graph(): ShaderGraph {
  return {
    outputNodeId: 'out',
    nodes: [
      { id: 'uv', type: 'input.uv', position: { x: 0, y: 0 }, params: [] },
      { id: 'mix', type: 'math.mix', position: { x: 200, y: 40 }, params: [], bypassed: true },
      { id: 'out', type: 'output.surface', position: { x: 400, y: 0 }, params: [], title: 'Result' },
    ],
    edges: [
      {
        id: 'uv:uv->mix:a',
        source: { node: 'uv', socket: 'uv' },
        target: { node: 'mix', socket: 'a' },
      },
    ],
  };
}

const lookup: SocketTypeLookup = (nodeId, socketId, direction) =>
  nodeId === 'uv' && socketId === 'uv' && direction === 'out' ? 'vec2' : undefined;

describe('toFlowNodes', () => {
  it('projects every node onto the single custom node type', () => {
    const flow = toFlowNodes(graph(), []);
    expect(flow).toHaveLength(3);
    expect(flow.every((n) => n.type === SHADER_NODE_TYPE)).toBe(true);
    expect(flow.map((n) => n.id)).toEqual(['uv', 'mix', 'out']);
  });

  it('carries position, title override and bypass into the card data', () => {
    const [uv, mix, out] = toFlowNodes(graph(), []);
    expect(uv.position).toEqual({ x: 0, y: 0 });
    expect(uv.data.shaderType).toBe('input.uv');
    expect(mix.data.bypassed).toBe(true);
    expect(uv.data.bypassed).toBe(false);
    expect(out.data.title).toBe('Result');
  });

  it('marks only the output node undeletable', () => {
    const flow = toFlowNodes(graph(), []);
    expect(flow.find((n) => n.id === 'out')?.deletable).toBe(false);
    expect(flow.find((n) => n.id === 'out')?.data.isOutput).toBe(true);
    expect(flow.filter((n) => n.deletable === false)).toHaveLength(1);
  });

  it('reflects the store selection', () => {
    const flow = toFlowNodes(graph(), ['mix']);
    expect(flow.map((n) => n.selected)).toEqual([false, true, false]);
  });

  it('copies positions rather than aliasing the document', () => {
    const doc = graph();
    const [uv] = toFlowNodes(doc, []);
    uv.position.x = 999;
    expect(doc.nodes[0].position.x).toBe(0);
  });
});

describe('toFlowEdges', () => {
  it('splits model endpoints into React Flow node + handle ids', () => {
    const [edge] = toFlowEdges(graph(), []);
    expect(edge).toMatchObject({
      id: 'uv:uv->mix:a',
      source: 'uv',
      sourceHandle: 'uv',
      target: 'mix',
      targetHandle: 'a',
    });
  });

  it('tints an edge by the type leaving its SOURCE socket', () => {
    const [edge] = toFlowEdges(graph(), [], lookup);
    expect(edge.style?.stroke).toBe(SOCKET_COLORS.vec2);
  });

  it('falls back to a neutral colour without a lookup', () => {
    const [edge] = toFlowEdges(graph(), []);
    expect(edge.style?.stroke).toBe(socketColor(undefined));
  });

  it('reflects edge selection', () => {
    expect(toFlowEdges(graph(), ['uv:uv->mix:a'])[0].selected).toBe(true);
    expect(toFlowEdges(graph(), [])[0].selected).toBe(false);
  });
});

describe('endpointsFrom', () => {
  it('converts a complete connection', () => {
    expect(
      endpointsFrom({ source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }),
    ).toEqual({
      source: { node: 'a', socket: 'out' },
      target: { node: 'b', socket: 'in' },
    });
  });

  it('rejects a connection with no handle id — a socketless link is never valid', () => {
    expect(endpointsFrom({ source: 'a', sourceHandle: null, target: 'b', targetHandle: 'in' })).toBeNull();
    expect(endpointsFrom({ source: 'a', sourceHandle: 'out', target: 'b', targetHandle: null })).toBeNull();
    expect(endpointsFrom({ source: '', sourceHandle: 'out', target: 'b', targetHandle: 'in' })).toBeNull();
  });
});
