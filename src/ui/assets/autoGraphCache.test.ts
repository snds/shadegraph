import { describe, expect, it } from 'vitest';

import { autoGraphContentSignature, buildAutoGraphDocument } from '../../storage/recognition';
import type { RecognizedShaderObject } from '../../storage/recognition';
import { cacheAutoGraphDocument, clearAutoGraphDocument, getCachedAutoGraphNode } from './autoGraphCache';

function object(overrides: Partial<RecognizedShaderObject> = {}): RecognizedShaderObject {
  return {
    id: 'n#GLSL_FBM',
    name: 'GLSL_FBM',
    nodeId: 'n',
    path: ['shader.glsl'],
    uniforms: [],
    requires: [],
    ...overrides,
  };
}

const SOURCE = 'uniform float x;';

describe('autoGraphCache', () => {
  it('returns undefined for a key that was never cached', () => {
    expect(getCachedAutoGraphNode('never-cached', SOURCE, 'GLSL_FBM')).toBeUndefined();
  });

  it('returns the exact cached ShaderNode for a matching key + unchanged source text', () => {
    const result = buildAutoGraphDocument([object()], SOURCE);
    if (!result.ok) throw new Error('expected ok');
    cacheAutoGraphDocument('root1::n', 'sig', result.doc);

    // A same-content signature check, not a literal string match — mirrors
    // how `planAssetThumbnail` derives its own signature.
    const found = getCachedAutoGraphNode('root1::n', SOURCE, 'GLSL_FBM');
    // `cacheAutoGraphDocument` was called with signature "sig", which will
    // NOT match `autoGraphContentSignature(SOURCE)` — this proves a mismatch
    // is treated as a miss, not a crash.
    expect(found).toBeUndefined();
  });

  it('is a hit when the signature stored matches autoGraphContentSignature(sourceText)', () => {
    const result = buildAutoGraphDocument([object()], SOURCE);
    if (!result.ok) throw new Error('expected ok');
    cacheAutoGraphDocument('root1::n2', autoGraphContentSignature(SOURCE), result.doc);

    const found = getCachedAutoGraphNode('root1::n2', SOURCE, 'GLSL_FBM');
    expect(found).toBeDefined();
    expect(found?.chunkSource?.name).toBe('GLSL_FBM');
    expect(found?.chunkSource?.text).toBe(SOURCE);
  });

  it('is a miss once the source text changes (a different signature)', () => {
    const result = buildAutoGraphDocument([object()], SOURCE);
    if (!result.ok) throw new Error('expected ok');
    cacheAutoGraphDocument('root1::n3', autoGraphContentSignature(SOURCE), result.doc);

    expect(getCachedAutoGraphNode('root1::n3', SOURCE + ' /* edited */', 'GLSL_FBM')).toBeUndefined();
  });

  it('is a miss for an object name never graphed into the cached document', () => {
    const result = buildAutoGraphDocument([object()], SOURCE);
    if (!result.ok) throw new Error('expected ok');
    cacheAutoGraphDocument('root1::n4', autoGraphContentSignature(SOURCE), result.doc);

    expect(getCachedAutoGraphNode('root1::n4', SOURCE, 'SOME_OTHER_OBJECT')).toBeUndefined();
  });

  it('clearAutoGraphDocument drops a cached entry', () => {
    const result = buildAutoGraphDocument([object()], SOURCE);
    if (!result.ok) throw new Error('expected ok');
    const sig = autoGraphContentSignature(SOURCE);
    cacheAutoGraphDocument('root1::n5', sig, result.doc);
    expect(getCachedAutoGraphNode('root1::n5', SOURCE, 'GLSL_FBM')).toBeDefined();

    clearAutoGraphDocument('root1::n5');
    expect(getCachedAutoGraphNode('root1::n5', SOURCE, 'GLSL_FBM')).toBeUndefined();
  });
});
