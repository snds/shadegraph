import { describe, expect, it } from 'vitest';

import { makeNode } from '../../storage/tree';
import type { RecognizedShaderObject } from '../../storage/recognition';
import { assetThumbnailKey, planAssetThumbnail } from './assetThumbnailPlan';

function shaderObject(overrides: Partial<RecognizedShaderObject> = {}): RecognizedShaderObject {
  return {
    id: 'shader.glsl#GLSL_FBM',
    name: 'GLSL_FBM',
    nodeId: 'shader.glsl',
    path: ['shaders', 'shader.glsl'],
    uniforms: [],
    requires: [],
    ...overrides,
  };
}

describe('assetThumbnailKey', () => {
  it('embeds both the root id and node id, never colliding across roots', () => {
    expect(assetThumbnailKey('rootA', 'shader.glsl')).toBe('rootA::shader.glsl');
    expect(assetThumbnailKey('rootA', 'shader.glsl')).not.toBe(assetThumbnailKey('rootB', 'shader.glsl'));
  });
});

describe('planAssetThumbnail', () => {
  it('is "none" for a folder', () => {
    const folder = makeNode(['shaders'], 'shaders', 'folder');
    expect(planAssetThumbnail(folder)).toEqual({ kind: 'none' });
  });

  it('is "none" for a file that has not finished recognition yet', () => {
    const file = makeNode(['shaders', 'a.glsl'], 'a.glsl', 'file');
    expect(planAssetThumbnail(file)).toEqual({ kind: 'none' });
  });

  it('is "none" for a file recognized as NOT a shader object', () => {
    const file = { ...makeNode(['a.txt'], 'a.txt', 'file'), recognized: false as const };
    expect(planAssetThumbnail(file)).toEqual({ kind: 'none' });
  });

  it('is "render" (with a throwaway document + signature) for a cleanly recognized file', () => {
    const file = {
      ...makeNode(['shader.glsl'], 'shader.glsl', 'file'),
      recognized: true as const,
      recognizedObjects: [shaderObject()],
      sourceText: 'uniform float x;',
    };
    const plan = planAssetThumbnail(file);
    expect(plan.kind).toBe('render');
    if (plan.kind !== 'render') throw new Error('expected render');
    expect(plan.doc.layerStack.layers).toHaveLength(1);
    expect(typeof plan.signature).toBe('string');
  });

  it('is "fallback" when the recognized object refuses (missing-requires)', () => {
    const file = {
      ...makeNode(['shader.glsl'], 'shader.glsl', 'file'),
      recognized: true as const,
      recognizedObjects: [shaderObject({ requires: ['SomeOtherFile'] })],
      sourceText: 'uniform float x;',
    };
    expect(planAssetThumbnail(file)).toEqual({ kind: 'fallback' });
  });

  it('two calls for the same unchanged file produce the SAME signature (the cache key the scheduler relies on)', () => {
    const file = {
      ...makeNode(['shader.glsl'], 'shader.glsl', 'file'),
      recognized: true as const,
      recognizedObjects: [shaderObject()],
      sourceText: 'uniform float x;',
    };
    const first = planAssetThumbnail(file);
    const second = planAssetThumbnail(file);
    if (first.kind !== 'render' || second.kind !== 'render') throw new Error('expected render');
    expect(first.signature).toBe(second.signature);
    // Independent document instances even though the signature matches —
    // the SCHEDULER (not this function) is what shortcuts a re-render.
    expect(first.doc).not.toBe(second.doc);
  });
});
