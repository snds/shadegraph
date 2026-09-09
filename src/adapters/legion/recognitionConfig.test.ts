// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Legion adapter: recognitionConfig tests
// ───────────────────────────────────────────────────────────────────────────
// Fixtures below are literal excerpts copied verbatim from Legion's real
// source (`~/Projects/Legion`, confirmed at the time this file was written —
// never read live at build or runtime, per the adapter boundary), NOT
// hand-written approximations: real `export const GLSL_<NAME> = /* glsl */`
// bundling syntax, real uniform declaration lines, and the real
// doc-comment-adjacent "Requires ..." prose that documents Legion's actual
// chunk ordering. Trimmed to the lines needed to prove recognition (full
// chunk bodies run hundreds of lines each) — every included line is an exact
// copy, not a rewrite.
//
// Two real files:
//   - `src/render/planet/glsl.ts` — GLSL_SIMPLEX, GLSL_FBM, GLSL_CLOUDS,
//     GLSL_PLATES, GLSL_TERRAIN, GLSL_RAMP
//   - `src/render/star/kelvin.ts` — GLSL_KELVIN
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';

import { makeNode } from '../../storage/tree';
import { recognizeShaderObjects } from '../../storage/recognition';
import { legionRecognitionConfig } from './recognitionConfig';

// Verbatim excerpts from `src/render/planet/glsl.ts`.
const LEGION_GLSL_TS_SOURCE = `
export const GLSL_SIMPLEX = /* glsl */ \`
vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
\`;

export const GLSL_FBM = /* glsl */ \`
uniform vec3  uNoiseSeed;   // per-body domain offset (determinism)
uniform float uRidged;      // 0 = fBm hills, 1 = ridged mountains
uniform float uWarp;        // domain-warp strength
\`;

/*  the deck). Requires GLSL_FBM and GLSL_PLATES (plateMacro) — include BOTH
 *  before this chunk. */
export const GLSL_CLOUDS = /* glsl */ \`
uniform float uCloudCover;    // 0..1 sky coverage (0 = clear)
uniform float uCloudCheap;    // 0 = full FBM, 1 = lite (drop fine octaves / plateMacro)
uniform float uCloudTime;     // raw clock (seconds) — scaled by uCloudSpeed below
\`;

export const GLSL_PLATES = /* glsl */ \`
const int MAX_PLATES = 48;
const int MAX_CONTINENTS = 8;
uniform int   uContCount;
uniform vec3  uContSeed[MAX_CONTINENTS];  // unit continent-centre directions
uniform float uContSize[MAX_CONTINENTS];  // per-continent cap radius (radians)
\`;

/*  Returns a normalised height in [0,1]. Requires GLSL_FBM + GLSL_PLATES. */
export const GLSL_TERRAIN = /* glsl */ \`
uniform float uDetailScale;   // detail-noise frequency multiplier (fine vs lumpy)
uniform float uCraters;       // impact-crater coverage 0..1 (0 = off) — Mercury/Mars ephemera
uniform float uCraterFreq;    // crater cell density (also sets size scale)
\`;

export const GLSL_RAMP = /* glsl */ \`
const int MAX_STOPS = 6;
uniform int   uRampCount;
uniform float uRampAt[MAX_STOPS];
uniform vec3  uRampColor[MAX_STOPS];
\`;
`;

// Verbatim excerpt from `src/render/star/kelvin.ts`.
const LEGION_KELVIN_TS_SOURCE = `
export const GLSL_KELVIN = /* glsl */ \`
vec3 kelvinToRGB(float tempK) {
  float t = clamp(tempK, 1000.0, 40000.0) / 100.0;
  float r, g, b;
\`;
`;

describe('legionRecognitionConfig', () => {
  it('recognizes all 7 real chunk names across both real files', () => {
    const glslNode = makeNode(['src', 'render', 'planet', 'glsl.ts'], 'glsl.ts', 'file');
    const kelvinNode = makeNode(['src', 'render', 'star', 'kelvin.ts'], 'kelvin.ts', 'file');

    const result = recognizeShaderObjects(
      [glslNode, kelvinNode],
      {
        [glslNode.id]: LEGION_GLSL_TS_SOURCE,
        [kelvinNode.id]: LEGION_KELVIN_TS_SOURCE,
      },
      legionRecognitionConfig,
    );

    expect(result.map((o) => o.name).sort()).toEqual([
      'GLSL_CLOUDS',
      'GLSL_FBM',
      'GLSL_KELVIN',
      'GLSL_PLATES',
      'GLSL_RAMP',
      'GLSL_SIMPLEX',
      'GLSL_TERRAIN',
    ]);
  });

  it('detects the real uniforms declared on GLSL_FBM and GLSL_PLATES', () => {
    const glslNode = makeNode(['src', 'render', 'planet', 'glsl.ts'], 'glsl.ts', 'file');
    const result = recognizeShaderObjects(
      [glslNode],
      { [glslNode.id]: LEGION_GLSL_TS_SOURCE },
      legionRecognitionConfig,
    );

    const fbm = result.find((o) => o.name === 'GLSL_FBM');
    expect(fbm?.uniforms).toEqual(['uNoiseSeed', 'uRidged', 'uWarp']);

    const plates = result.find((o) => o.name === 'GLSL_PLATES');
    expect(plates?.uniforms).toEqual(['uContCount', 'uContSeed', 'uContSize']);
  });

  it('recognizes GLSL_KELVIN from the second real file, with no uniforms', () => {
    const kelvinNode = makeNode(['src', 'render', 'star', 'kelvin.ts'], 'kelvin.ts', 'file');
    const result = recognizeShaderObjects(
      [kelvinNode],
      { [kelvinNode.id]: LEGION_KELVIN_TS_SOURCE },
      legionRecognitionConfig,
    );

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('GLSL_KELVIN');
    expect(result[0].uniforms).toEqual([]);
    expect(result[0].requires).toEqual([]);
  });

  it('surfaces the 2 real requires relationships: GLSL_CLOUDS and GLSL_TERRAIN both require GLSL_FBM + GLSL_PLATES', () => {
    const glslNode = makeNode(['src', 'render', 'planet', 'glsl.ts'], 'glsl.ts', 'file');
    const result = recognizeShaderObjects(
      [glslNode],
      { [glslNode.id]: LEGION_GLSL_TS_SOURCE },
      legionRecognitionConfig,
    );

    const clouds = result.find((o) => o.name === 'GLSL_CLOUDS');
    expect(clouds?.requires).toEqual(['GLSL_FBM', 'GLSL_PLATES']);

    const terrain = result.find((o) => o.name === 'GLSL_TERRAIN');
    expect(terrain?.requires).toEqual(['GLSL_FBM', 'GLSL_PLATES']);

    const fbm = result.find((o) => o.name === 'GLSL_FBM');
    expect(fbm?.requires).toEqual([]);

    const plates = result.find((o) => o.name === 'GLSL_PLATES');
    expect(plates?.requires).toEqual([]);
  });
});
