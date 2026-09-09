import { describe, expect, it } from 'vitest';

import { CHUNK_RAW_NODE_TYPE } from '../../nodes/definitions/chunk';
import { graphFromRecognizedObject } from './graphFromRecognizedObject';
import type { RecognizedShaderObject } from './types';

const RAW_TEXT = [
  'uniform float uNoiseSeed;',
  'uniform bool uRidged;',
  'float sg_fbm(vec2 uv) { return uv.x + uNoiseSeed; }',
].join('\n');

function fixture(overrides: Partial<RecognizedShaderObject> = {}): RecognizedShaderObject {
  return {
    id: 'node-1',
    name: 'GLSL_FBM',
    nodeId: 'node-1',
    path: ['shaders', 'glsl.ts'],
    uniforms: ['uNoiseSeed', 'uRidged'],
    requires: [],
    ...overrides,
  };
}

describe('graphFromRecognizedObject', () => {
  it('produces a chunk.raw ShaderNode with verbatim emit text and params mirroring detected uniforms', () => {
    const object = fixture();
    const result = graphFromRecognizedObject(object, RAW_TEXT, { makeId: () => 'fixed-id' });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    expect(result.node).toEqual({
      id: 'fixed-id',
      type: CHUNK_RAW_NODE_TYPE,
      title: 'GLSL_FBM',
      position: { x: 0, y: 0 },
      previewEnabled: false,
      params: [
        { id: 'uNoiseSeed', label: 'uNoiseSeed', type: 'float', value: 0, ui: 'number' },
        { id: 'uRidged', label: 'uRidged', type: 'float', value: 0, ui: 'number' },
      ],
      chunkSource: {
        name: 'GLSL_FBM',
        text: RAW_TEXT,
        requires: [],
      },
    });
    // Verbatim: the exact same string reference/content survives, not a
    // reconstructed/reparsed re-serialisation of it.
    expect(result.node.chunkSource!.text).toBe(RAW_TEXT);
  });

  it('honours a custom position', () => {
    const result = graphFromRecognizedObject(fixture(), RAW_TEXT, { position: { x: 120, y: 40 } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.node.position).toEqual({ x: 120, y: 40 });
  });

  it('produces a node with zero params for an object with no detected uniforms', () => {
    const object = fixture({ uniforms: [] });
    const result = graphFromRecognizedObject(object, 'void main() {}');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.node.params).toEqual([]);
  });

  it('blocks when a declared `requires` chunk has not been graphed yet', () => {
    const object = fixture({ requires: ['GLSL_PLATES'] });
    const result = graphFromRecognizedObject(object, RAW_TEXT);

    expect(result).toEqual({ ok: false, reason: 'missing-requires', missing: ['GLSL_PLATES'] });
  });

  it('reports every missing requires name, not just the first', () => {
    const object = fixture({ requires: ['GLSL_PLATES', 'GLSL_SIMPLEX'] });
    const result = graphFromRecognizedObject(object, RAW_TEXT, {
      graphedChunkNames: ['GLSL_SIMPLEX'],
    });

    expect(result).toEqual({ ok: false, reason: 'missing-requires', missing: ['GLSL_PLATES'] });
  });

  it('proceeds when every declared requires chunk is already graphed', () => {
    const object = fixture({ requires: ['GLSL_PLATES', 'GLSL_SIMPLEX'] });
    const result = graphFromRecognizedObject(object, RAW_TEXT, {
      graphedChunkNames: ['GLSL_PLATES', 'GLSL_SIMPLEX'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(result.node.chunkSource!.requires).toEqual(['GLSL_PLATES', 'GLSL_SIMPLEX']);
  });
});
