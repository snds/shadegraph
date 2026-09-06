import { beforeEach, describe, expect, it } from 'vitest';

import { emptyDocument, type ShaderDocument, type ShaderGraph } from '../../model/document';
import { emptyLayer } from '../../model/factory';
import { registerStarterNodes } from '../../nodes/definitions';
import { nodes } from '../../nodes/registry';
import { backends } from '../backend';
import { coerceGlsl, glslEsBackend, glslLiteral } from './glsl-es';

// Import for the registration side effect (`backends.register(glslEsBackend)`)
// so `backends.get('glsl-es')` resolves the same singleton the app uses.
import './glsl-es';

beforeEach(() => {
  registerStarterNodes(nodes);
});

// ── Fixtures ─────────────────────────────────────────────────────────────────
// The Phase 1 Wave 4 verification chain: UV -> FBM -> Ramp -> Output. Node ids
// are hand-picked (not `makeNodeId`, which is random) so the golden snapshot
// stays byte-stable across runs.
function uvFbmRampOutputGraph(): ShaderGraph {
  return {
    nodes: [
      { id: 'uv1', type: 'input.uv', position: { x: 0, y: 0 }, params: [] },
      { id: 'fbm1', type: 'noise.fbm', position: { x: 200, y: 0 }, params: [] },
      { id: 'ramp1', type: 'color.ramp', position: { x: 400, y: 0 }, params: [] },
      { id: 'out1', type: 'output.surface', position: { x: 600, y: 0 }, params: [] },
    ],
    edges: [
      { id: 'uv1:uv->fbm1:uv', source: { node: 'uv1', socket: 'uv' }, target: { node: 'fbm1', socket: 'uv' } },
      {
        id: 'fbm1:value->ramp1:t',
        source: { node: 'fbm1', socket: 'value' },
        target: { node: 'ramp1', socket: 't' },
      },
      {
        id: 'ramp1:color->out1:baseColor',
        source: { node: 'ramp1', socket: 'color' },
        target: { node: 'out1', socket: 'baseColor' },
      },
    ],
    outputNodeId: 'out1',
  };
}

// Same chain plus `math.mix`, which forces two real coercion-table lookups:
// color.ramp's `color` output into mix's `vec3` input, and mix's `vec3`
// output back into output.surface's `color` input. Both are identity
// conversions in this backend (color IS vec3), but going through
// `coerceGlsl` — not skipped — is exactly what this test guards.
function uvFbmRampMixOutputGraph(): ShaderGraph {
  const base = uvFbmRampOutputGraph();
  return {
    nodes: [
      ...base.nodes.filter((n) => n.id !== 'out1'),
      { id: 'mix1', type: 'math.mix', position: { x: 500, y: 0 }, params: [] },
      { id: 'out1', type: 'output.surface', position: { x: 700, y: 0 }, params: [] },
    ],
    edges: [
      ...base.edges.filter((e) => e.id !== 'ramp1:color->out1:baseColor'),
      { id: 'ramp1:color->mix1:a', source: { node: 'ramp1', socket: 'color' }, target: { node: 'mix1', socket: 'a' } },
      {
        id: 'mix1:result->out1:baseColor',
        source: { node: 'mix1', socket: 'result' },
        target: { node: 'out1', socket: 'baseColor' },
      },
    ],
    outputNodeId: 'out1',
  };
}

describe('glslEsBackend.compileGraph', () => {
  it('registers into the shared backend registry', () => {
    expect(backends.get('glsl-es')).toBe(glslEsBackend);
  });

  it('golden snapshot: UV -> FBM -> Ramp -> Output', () => {
    const program = glslEsBackend.compileGraph(uvFbmRampOutputGraph());
    expect(program.diagnostics).toEqual([]);
    expect(program.vertex).toMatchSnapshot('vertex');
    expect(program.fragment).toMatchSnapshot('fragment');
    expect(program.uniforms).toMatchSnapshot('uniforms');
  });

  it('golden snapshot: UV -> FBM -> Ramp -> Mix -> Output (exercises color<->vec3 coercion)', () => {
    const program = glslEsBackend.compileGraph(uvFbmRampMixOutputGraph());
    expect(program.diagnostics).toEqual([]);
    expect(program.fragment).toMatchSnapshot('fragment-with-mix');
  });

  it('is headless: pure data in, a CompiledProgram out, no globals/DOM touched', () => {
    expect(typeof window).toBe('undefined');
    const program = glslEsBackend.compileGraph(uvFbmRampOutputGraph());
    expect(program.target).toBe('glsl-es');
    expect(typeof program.fragment).toBe('string');
    expect(typeof program.vertex).toBe('string');
  });

  it('dedupes uniforms by name and back-references each to its NodeParam id', () => {
    const program = glslEsBackend.compileGraph(uvFbmRampOutputGraph());
    const names = program.uniforms.map((u) => u.name);
    expect(new Set(names).size).toBe(names.length);
    const tiling = program.uniforms.find((u) => u.name.includes('tiling'));
    expect(tiling?.paramId).toBe('tiling');
  });

  it('reports a diagnostic and keeps compiling through a cycle', () => {
    const graph: ShaderGraph = {
      nodes: [
        { id: 'a1', type: 'math.add', position: { x: 0, y: 0 }, params: [] },
        { id: 'b1', type: 'math.add', position: { x: 0, y: 0 }, params: [] },
        { id: 'out1', type: 'output.surface', position: { x: 0, y: 0 }, params: [] },
      ],
      edges: [
        { id: 'a->b', source: { node: 'a1', socket: 'result' }, target: { node: 'b1', socket: 'a' } },
        { id: 'b->a', source: { node: 'b1', socket: 'result' }, target: { node: 'a1', socket: 'a' } },
        {
          id: 'b->out',
          source: { node: 'b1', socket: 'result' },
          target: { node: 'out1', socket: 'roughness' },
        },
      ],
      outputNodeId: 'out1',
    };
    expect(() => glslEsBackend.compileGraph(graph)).not.toThrow();
    const program = glslEsBackend.compileGraph(graph);
    expect(program.diagnostics.some((d) => d.level === 'error')).toBe(true);
    expect(program.fragment).toContain('void main()');
  });

  it('previewNodeId wraps an arbitrary node output for display', () => {
    const graph = uvFbmRampOutputGraph();
    const program = glslEsBackend.compileGraph(graph, { previewNodeId: 'fbm1' });
    expect(program.diagnostics).toEqual([]);
    expect(program.fragment).toMatch(/gl_FragColor = vec4\(vec3\(fbm_\d+\), 1\.0\);/);
  });
});

describe('glslEsBackend.compileDocument', () => {
  function twoLayerDoc(): ShaderDocument {
    const doc = emptyDocument('Composite');
    const overlay = emptyLayer('Overlay');
    overlay.blend = 'multiply';
    overlay.opacity = 0.5;
    doc.layerStack.layers.push(overlay);
    return doc;
  }

  it('composites bottom-to-top with the layer blend function and a final gl_FragColor write', () => {
    const doc = twoLayerDoc();
    const program = glslEsBackend.compileDocument(doc);
    expect(program.diagnostics).toEqual([]);
    const fragment = program.fragment ?? '';
    // The prelude always defines every blend function; only a call SITE (an
    // assignment, not a `vec3 sg_blendXxx(...) {` definition) proves this
    // layer's mode was actually dispatched.
    expect(fragment).toMatch(/= sg_blendMultiply\(/);
    expect(fragment.trim().endsWith('}')).toBe(true);
    const lines = fragment.split('\n');
    const lastStatement = lines.filter((l) => l.trim().length > 0).at(-2);
    expect(lastStatement).toMatch(/gl_FragColor = vec4\(.+, 1\.0\);/);
  });

  it('honors solo: only soloed layers composite, regardless of enabled', () => {
    const doc = twoLayerDoc();
    doc.layerStack.layers[0].soloed = true;
    doc.layerStack.layers[1].enabled = false;
    const program = glslEsBackend.compileDocument(doc);
    // Only one layer participates, so there is exactly one blend call SITE
    // (against the implicit black canvas), not two chained ones. Match only
    // assignment call sites, not the always-present function definitions.
    const blendCalls = (program.fragment ?? '').match(/= sg_blend\w+\(/g) ?? [];
    expect(blendCalls).toHaveLength(1);
  });

  it('previewLayerId isolates a single layer, bypassing compositing', () => {
    const doc = twoLayerDoc();
    const overlayId = doc.layerStack.layers[1].id;
    const program = glslEsBackend.compileDocument(doc, { previewLayerId: overlayId });
    expect(program.fragment).not.toMatch(/= sg_blend\w+\(/);
    expect(program.fragment).toContain('gl_FragColor');
  });

  it('falls back to Normal with a warning diagnostic for the unimplemented "custom" blend', () => {
    const doc = twoLayerDoc();
    doc.layerStack.layers[1].blend = 'custom';
    const program = glslEsBackend.compileDocument(doc);
    const normalCallSites = (program.fragment ?? '').match(/= sg_blendNormal\(/g) ?? [];
    // Base layer (normal) + overlay (custom, falls back to normal) = 2 sites.
    expect(normalCallSites).toHaveLength(2);
    expect(program.diagnostics.some((d) => d.level === 'warning' && d.message.includes('custom'))).toBe(
      true,
    );
  });
});

describe('coerceGlsl', () => {
  it('is the identity for identical types', () => {
    expect(coerceGlsl('x', 'float', 'float')).toBe('x');
  });

  it('produces the documented conversion for every table entry', () => {
    expect(coerceGlsl('i', 'int', 'float')).toBe('float(i)');
    expect(coerceGlsl('f', 'float', 'int')).toBe('int(f)');
    expect(coerceGlsl('c', 'color', 'vec3')).toBe('c');
    expect(coerceGlsl('n', 'normal', 'vec3')).toBe('n');
    expect(coerceGlsl('v', 'vec3', 'color')).toBe('v');
    expect(coerceGlsl('v4', 'vec4', 'color')).toBe('v4.rgb');
    expect(coerceGlsl('c', 'color', 'vec4')).toBe('vec4(c, 1.0)');
    expect(coerceGlsl('v', 'vec3', 'normal')).toBe('normalize(v)');
  });

  it('returns undefined for a pair with no registered conversion', () => {
    expect(coerceGlsl('x', 'bool', 'sampler2D')).toBeUndefined();
  });
});

describe('glslLiteral', () => {
  it('formats floats with an explicit decimal point (GLSL ES requires it)', () => {
    expect(glslLiteral(2, 'float')).toBe('2.0');
    expect(glslLiteral(0.5, 'float')).toBe('0.5');
  });

  it('formats vectors component-wise, padding a short array with zeros', () => {
    expect(glslLiteral([1, 2], 'vec3')).toBe('vec3(1.0, 2.0, 0.0)');
  });

  it('falls back to a safe default when the value is missing entirely', () => {
    expect(glslLiteral(undefined, 'vec2')).toBe('vec2(0.0, 0.0)');
    expect(glslLiteral(undefined, 'bool')).toBe('false');
  });
});
