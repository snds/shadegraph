// The canvas is a projection, so the projection is where it can silently lie:
// a dropped socket id, an output node that becomes deletable, an edge tinted by
// the wrong end. These run in a plain node environment — `project.ts` imports
// React Flow for TYPES ONLY, which is exactly the boundary being asserted.

import { describe, expect, it } from 'vitest';

import type { ShaderGraph } from '../../model/document';
import type { SocketTypeLookup } from '../../model/connect';
import {
  endpointsFrom,
  findGroup,
  frameNodeId,
  GROUP_NODE_TYPE,
  groupIdFromFrameNodeId,
  SHADER_NODE_TYPE,
  toFlowEdges,
  toFlowGroups,
  toFlowNodes,
} from './project';
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
    groups: [{ id: 'g1', title: 'Inputs', color: '#ff0000', bounds: { x: -20, y: -20, w: 100, h: 60 } }],
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

describe('toFlowGroups', () => {
  it('projects every group onto the frame node type, id-namespaced from shader nodes', () => {
    const flow = toFlowGroups(graph(), []);
    expect(flow).toHaveLength(1);
    expect(flow[0].type).toBe(GROUP_NODE_TYPE);
    expect(flow[0].id).toBe(frameNodeId('g1'));
    expect(flow[0].id).not.toBe('g1');
  });

  it('positions and sizes the frame from the group bounds', () => {
    const [frame] = toFlowGroups(graph(), []);
    expect(frame.position).toEqual({ x: -20, y: -20 });
    expect(frame.style).toEqual({ width: 100, height: 60 });
  });

  it('carries title/color into frame data and reflects selection', () => {
    const [selected] = toFlowGroups(graph(), ['g1']);
    expect(selected.data).toEqual({ groupId: 'g1', title: 'Inputs', color: '#ff0000' });
    expect(selected.selected).toBe(true);

    const [unselected] = toFlowGroups(graph(), []);
    expect(unselected.selected).toBe(false);
  });

  it('is empty when the graph has no groups', () => {
    expect(toFlowGroups({ ...graph(), groups: undefined }, [])).toEqual([]);
  });
});

describe('frameNodeId / groupIdFromFrameNodeId', () => {
  it('round-trips a group id through its frame node id', () => {
    expect(groupIdFromFrameNodeId(frameNodeId('g1'))).toBe('g1');
  });

  it('rejects an id that is not a frame', () => {
    expect(groupIdFromFrameNodeId('uv')).toBeNull();
  });
});

describe('findGroup', () => {
  it('finds a group by id', () => {
    expect(findGroup(graph(), 'g1')?.title).toBe('Inputs');
  });

  it('returns undefined for an unknown id or a groupless graph', () => {
    expect(findGroup(graph(), 'ghost')).toBeUndefined();
    expect(findGroup({ ...graph(), groups: undefined }, 'g1')).toBeUndefined();
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
