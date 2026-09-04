import { describe, expect, it } from 'vitest';

import type { ShaderGraph, SocketType } from './document';
import {
  canConnect,
  edgeIntoSocket,
  edgesTouchingNodes,
  validateConnection,
  wouldCreateCycle,
  type SocketTypeLookup,
} from './connect';

// A tiny hand-built fixture so these tests exercise the model alone — no node
// registry, no store, no React.
//
//   uv      out uv:vec2
//   noise   in uv:vec2      out value:vec3
//   tint    out color:color
//   surface in albedo:color, emissive:color, roughness:float   out out:color
const TYPES = new Map<string, SocketType>([
  ['uv|uv|out', 'vec2'],
  ['noise|uv|in', 'vec2'],
  ['noise|value|out', 'vec3'],
  ['tint|color|out', 'color'],
  ['surface|albedo|in', 'color'],
  ['surface|emissive|in', 'color'],
  ['surface|roughness|in', 'float'],
  ['surface|out|out', 'color'],
]);

const lookup: SocketTypeLookup = (nodeId, socketId, direction) =>
  TYPES.get(`${nodeId}|${socketId}|${direction}`);

const noiseValue = { node: 'noise', socket: 'value' };
const surfaceAlbedo = { node: 'surface', socket: 'albedo' };

function graph(edges: ShaderGraph['edges'] = []): ShaderGraph {
  return {
    nodes: [
      { id: 'uv', type: 'input.uv', position: { x: 0, y: 0 }, params: [] },
      { id: 'noise', type: 'noise.fbm', position: { x: 200, y: 0 }, params: [] },
      { id: 'tint', type: 'color.ramp', position: { x: 200, y: 150 }, params: [] },
      { id: 'surface', type: 'output.surface', position: { x: 400, y: 0 }, params: [] },
    ],
    edges,
    outputNodeId: 'surface',
  };
}

const edge = (sn: string, ss: string, tn: string, ts: string) => ({
  id: `${sn}:${ss}->${tn}:${ts}`,
  source: { node: sn, socket: ss },
  target: { node: tn, socket: ts },
});

describe('canConnect', () => {
  it('accepts a vec3 output into a color input', () => {
    expect(canConnect('vec3', 'color')).toBe(true);
  });

  it('rejects a vec2 output into a float input', () => {
    expect(canConnect('vec2', 'float')).toBe(false);
  });

  it('follows the SOCKET_COMPATIBILITY table for the semantic aliases', () => {
    expect(canConnect('color', 'vec3')).toBe(true);
    expect(canConnect('normal', 'vec3')).toBe(true);
    expect(canConnect('float', 'int')).toBe(true);
    expect(canConnect('sampler2D', 'cubemap')).toBe(false);
    expect(canConnect('bool', 'float')).toBe(false);
  });
});

describe('validateConnection', () => {
  it('accepts a legal vec3 → color link', () => {
    expect(validateConnection(graph(), noiseValue, surfaceAlbedo, lookup)).toEqual({ ok: true });
  });

  it('rejects an illegal vec2 → float link', () => {
    const verdict = validateConnection(
      graph(),
      { node: 'uv', socket: 'uv' },
      { node: 'surface', socket: 'roughness' },
      lookup,
    );

    expect(verdict).toMatchObject({ ok: false, reason: 'type-mismatch' });
  });

  it('refuses a second edge into an already-fed input socket', () => {
    const occupied = graph([edge('noise', 'value', 'surface', 'albedo')]);

    // A *different*, type-compatible source into the same input socket.
    const verdict = validateConnection(
      occupied,
      { node: 'tint', socket: 'color' },
      { node: 'surface', socket: 'albedo' },
      lookup,
    );

    expect(verdict).toMatchObject({ ok: false, reason: 'target-occupied' });
  });

  it('reports an exact repeat of an existing edge as a duplicate', () => {
    const existing = graph([edge('noise', 'value', 'surface', 'albedo')]);

    expect(validateConnection(existing, noiseValue, surfaceAlbedo, lookup)).toMatchObject({
      ok: false,
      reason: 'duplicate-edge',
    });
  });

  it('allows one output to fan out to several inputs', () => {
    const fanned = graph([edge('noise', 'value', 'surface', 'albedo')]);

    expect(
      validateConnection(fanned, noiseValue, { node: 'surface', socket: 'emissive' }, lookup),
    ).toEqual({ ok: true });
  });

  it('rejects self-connection and unknown endpoints', () => {
    expect(
      validateConnection(
        graph(),
        { node: 'uv', socket: 'uv' },
        { node: 'uv', socket: 'uv' },
        lookup,
      ),
    ).toMatchObject({ reason: 'same-node' });

    expect(
      validateConnection(graph(), { node: 'ghost', socket: 'x' }, surfaceAlbedo, lookup),
    ).toMatchObject({ reason: 'unknown-source' });

    expect(
      validateConnection(graph(), { node: 'noise', socket: 'nope' }, surfaceAlbedo, lookup),
    ).toMatchObject({ reason: 'unknown-source-socket' });
  });

  it('rejects a link that would close a cycle', () => {
    // surface.out → noise.uv would loop back through noise → surface.
    const looping = graph([edge('noise', 'value', 'surface', 'albedo')]);

    expect(
      validateConnection(
        looping,
        { node: 'surface', socket: 'out' },
        { node: 'noise', socket: 'uv' },
        // Force a type-compatible pair so the cycle rule is what fires.
        (n, s, d) => (n === 'noise' && s === 'uv' ? 'vec3' : TYPES.get(`${n}|${s}|${d}`)),
      ),
    ).toMatchObject({ ok: false, reason: 'cycle' });
  });
});

describe('graph queries', () => {
  it('finds the single edge feeding an input socket', () => {
    const g = graph([edge('noise', 'value', 'surface', 'albedo')]);

    expect(edgeIntoSocket(g, 'surface', 'albedo')?.source.node).toBe('noise');
    expect(edgeIntoSocket(g, 'surface', 'emissive')).toBeUndefined();
  });

  it('collects every edge on either side of a set of nodes', () => {
    const g = graph([
      edge('uv', 'uv', 'noise', 'uv'),
      edge('noise', 'value', 'surface', 'albedo'),
    ]);

    expect(edgesTouchingNodes(g, ['noise'])).toHaveLength(2);
    expect(edgesTouchingNodes(g, ['uv']).map((e) => e.id)).toEqual(['uv:uv->noise:uv']);
    expect(edgesTouchingNodes(g, [])).toEqual([]);
  });

  it('detects reachability for cycle prevention', () => {
    const g = graph([edge('uv', 'uv', 'noise', 'uv')]);

    expect(wouldCreateCycle(g, 'uv', 'noise')).toBe(false);
    expect(wouldCreateCycle(g, 'noise', 'uv')).toBe(true);
    expect(wouldCreateCycle(g, 'uv', 'uv')).toBe(true);
  });
});
