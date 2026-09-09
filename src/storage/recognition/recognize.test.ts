// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — recognizeShaderObjects tests
// ───────────────────────────────────────────────────────────────────────────
// Fixtures below are hand-written, modeled on the *shape* described in the
// Phase 5 sketch's "reality gap" section (a bundled multi-function chunk
// declaring several uniforms; a second chunk that declares an ordering
// dependency on two others) — not copied from any real source tree. The
// `RecognitionConfig` used here is the kind of config a real call site
// would supply; nothing under `src/storage/recognition/` itself references
// any real project's paths or names.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';

import { makeNode } from '../tree';
import { recognizeShaderObjects } from './recognize';
import type { RecognitionConfig } from './types';

const BUNDLED_CHUNKS_SOURCE = `
export const GLSL_FBM = \`
  uniform float uNoiseSeed;
  uniform bool uRidged;
  uniform vec2 uWarp;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  float fbm(vec2 p) { return hash(p); }
\`;

export const GLSL_PLATES = \`
  uniform float uPlateCount;

  float plates(vec2 p) { return p.x; }
\`;

// Requires GLSL_FBM and GLSL_PLATES included before this in the final
// program — informal prose, deliberately NOT parsed by the recognizer.
export const GLSL_CLOUDS = \`
  uniform float uCloudCover;
  uniform float uCloudSharpness;

  vec3 clouds(vec2 p) { return vec3(fbm(p) * plates(p)); }
\`;

export const NOT_A_SHADER_EXPORT = "just a regular string";
`;

const STANDALONE_GLSL_SOURCE = `
uniform mat4 uViewProjection;
uniform vec3 uSunDirection;

void main() {}
`;

function config(overrides: Partial<RecognitionConfig> = {}): RecognitionConfig {
  return {
    fileExtensions: ['.glsl', '.wgsl'],
    bundledExtensions: ['.ts', '.js'],
    exportNamePattern: /^GLSL_[A-Z0-9_]+$/,
    requires: {
      GLSL_CLOUDS: ['GLSL_FBM', 'GLSL_PLATES'],
    },
    ...overrides,
  };
}

describe('recognizeShaderObjects', () => {
  it('detects multiple uniforms declared within one bundled chunk', () => {
    const node = makeNode(['src', 'shaders.ts'], 'shaders.ts', 'file');
    const result = recognizeShaderObjects([node], { [node.id]: BUNDLED_CHUNKS_SOURCE }, config());

    const fbm = result.find((o) => o.name === 'GLSL_FBM');
    expect(fbm).toBeDefined();
    expect(fbm?.uniforms).toEqual(['uNoiseSeed', 'uRidged', 'uWarp']);
    expect(fbm?.nodeId).toBe(node.id);
  });

  it('surfaces a config-declared `requires` ordering on the dependent chunk', () => {
    const node = makeNode(['src', 'shaders.ts'], 'shaders.ts', 'file');
    const result = recognizeShaderObjects([node], { [node.id]: BUNDLED_CHUNKS_SOURCE }, config());

    const clouds = result.find((o) => o.name === 'GLSL_CLOUDS');
    expect(clouds).toBeDefined();
    expect(clouds?.requires).toEqual(['GLSL_FBM', 'GLSL_PLATES']);
    expect(clouds?.uniforms).toEqual(['uCloudCover', 'uCloudSharpness']);

    const fbm = result.find((o) => o.name === 'GLSL_FBM');
    expect(fbm?.requires).toEqual([]);
  });

  it('recognizes every matching export in one file as a separate object, ignoring non-matching exports', () => {
    const node = makeNode(['src', 'shaders.ts'], 'shaders.ts', 'file');
    const result = recognizeShaderObjects([node], { [node.id]: BUNDLED_CHUNKS_SOURCE }, config());

    expect(result.map((o) => o.name).sort()).toEqual(['GLSL_CLOUDS', 'GLSL_FBM', 'GLSL_PLATES']);
    expect(result.every((o) => o.name !== 'NOT_A_SHADER_EXPORT')).toBe(true);
  });

  it('recognizes a standalone .glsl file as one object keyed by file name', () => {
    const node = makeNode(['src', 'sky.glsl'], 'sky.glsl', 'file');
    const result = recognizeShaderObjects([node], { [node.id]: STANDALONE_GLSL_SOURCE }, config());

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(node.id);
    expect(result[0].name).toBe('sky.glsl');
    expect(result[0].uniforms).toEqual(['uViewProjection', 'uSunDirection']);
    expect(result[0].requires).toEqual([]);
  });

  it('ignores folders and files with no source text available', () => {
    const folder = makeNode(['src'], 'src', 'folder');
    const unread = makeNode(['src', 'unread.glsl'], 'unread.glsl', 'file');
    const result = recognizeShaderObjects([folder, unread], {}, config());
    expect(result).toEqual([]);
  });

  it('ignores files whose extension matches neither fileExtensions nor bundledExtensions', () => {
    const node = makeNode(['README.md'], 'README.md', 'file');
    const result = recognizeShaderObjects([node], { [node.id]: 'uniform float uUnused;' }, config());
    expect(result).toEqual([]);
  });

  it('does not extract bundled chunks when no exportNamePattern is configured', () => {
    const node = makeNode(['src', 'shaders.ts'], 'shaders.ts', 'file');
    const result = recognizeShaderObjects(
      [node],
      { [node.id]: BUNDLED_CHUNKS_SOURCE },
      config({ exportNamePattern: undefined }),
    );
    expect(result).toEqual([]);
  });
});
