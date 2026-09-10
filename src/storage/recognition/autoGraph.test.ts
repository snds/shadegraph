import { describe, expect, it } from 'vitest';

import type { ShaderLayer } from '../../model/document';
import { CHUNK_RAW_NODE_TYPE } from '../../nodes/definitions/chunk';
import { autoGraphContentSignature, buildAutoGraphDocument } from './autoGraph';
import type { RecognizedShaderObject } from './types';

function object(overrides: Partial<RecognizedShaderObject> = {}): RecognizedShaderObject {
  return {
    id: 'node-1#GLSL_FBM',
    name: 'GLSL_FBM',
    nodeId: 'node-1',
    path: ['shaders', 'glsl.ts'],
    uniforms: ['uSeed'],
    requires: [],
    ...overrides,
  };
}

const SOURCE = 'uniform float uSeed;\nfloat sg_fbm(vec2 uv) { return uv.x + uSeed; }';

describe('buildAutoGraphDocument', () => {
  it('produces a throwaway document with one chunk.raw node per recognized object', () => {
    const result = buildAutoGraphDocument([object()], SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');

    const layer = result.doc.layerStack.layers[0] as ShaderLayer;
    // The pre-existing output node plus exactly one new chunk.raw node.
    expect(layer.graph.nodes).toHaveLength(2);
    const chunkNode = layer.graph.nodes.find((n) => n.type === CHUNK_RAW_NODE_TYPE);
    expect(chunkNode?.chunkSource).toEqual({ name: 'GLSL_FBM', text: SOURCE, requires: [] });
  });

  it('never mutates the caller-passed objects/sourceText', () => {
    const objects = [object()];
    const snapshot = JSON.parse(JSON.stringify(objects));
    buildAutoGraphDocument(objects, SOURCE);
    expect(objects).toEqual(snapshot);
  });

  it('two calls for the same file produce independent documents (never sharing a live reference)', () => {
    const a = buildAutoGraphDocument([object()], SOURCE);
    const b = buildAutoGraphDocument([object()], SOURCE);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.doc).not.toBe(b.doc);
    expect(a.doc.id).not.toBe(b.doc.id);
  });

  it('a later object in the same file may require an earlier one', () => {
    const first = object({ id: 'n#A', name: 'A' });
    const second = object({ id: 'n#B', name: 'B', requires: ['A'] });
    const result = buildAutoGraphDocument([first, second], SOURCE);
    expect(result.ok).toBe(true);
  });

  it('refuses (missing-requires) when an object requires something not graphed earlier in this same call', () => {
    const withMissingRequire = object({ requires: ['SomeOtherFileChunk'] });
    const result = buildAutoGraphDocument([withMissingRequire], SOURCE);
    expect(result).toEqual({ ok: false, reason: 'missing-requires', missing: ['SomeOtherFileChunk'] });
  });

  it('refuses the whole file if ANY of its objects refuses — never a partially-built document', () => {
    const ok = object({ id: 'n#A', name: 'A' });
    const refused = object({ id: 'n#B', name: 'B', requires: ['NotGraphedAnywhere'] });
    const result = buildAutoGraphDocument([ok, refused], SOURCE);
    expect(result.ok).toBe(false);
  });
});

describe('autoGraphContentSignature', () => {
  it('is stable for identical text', () => {
    expect(autoGraphContentSignature(SOURCE)).toBe(autoGraphContentSignature(SOURCE));
  });

  it('differs for different text', () => {
    expect(autoGraphContentSignature(SOURCE)).not.toBe(autoGraphContentSignature(SOURCE + ' '));
  });

  it('is a non-empty string for empty input (never throws)', () => {
    expect(typeof autoGraphContentSignature('')).toBe('string');
    expect(autoGraphContentSignature('').length).toBeGreaterThan(0);
  });
});
