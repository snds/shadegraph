import { beforeEach, describe, expect, it } from 'vitest';

import {
  emptyDocument,
  SOCKET_COMPATIBILITY,
  type LayerGroup,
  type ScalarOrVector,
  type ShaderDocument,
  type ShaderGraph,
  type ShaderLayer,
  type SocketType,
} from '../../model/document';
import { emptyLayer } from '../../model/factory';
import { registerStarterNodes } from '../../nodes/definitions';
import { nodes } from '../../nodes/registry';
import { backends } from '../backend';
import { coerceWgsl, layerOpacityUniformName, wgslBackend, wgslLiteral } from './wgsl';

// Import for the registration side effect (`backends.register(wgslBackend)`)
// so `backends.get('wgsl')` resolves the same singleton the app uses.
import './wgsl';

beforeEach(() => {
  registerStarterNodes(nodes);
});

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Deliberately the SAME fixture documents `glsl-es.test.ts` uses (per this
// task's Definition of Done: "produce valid WGSL for the same fixture
// documents the glsl-es golden-snapshot tests use") — duplicated here rather
// than imported since the originals aren't exported from that test file, but
// every node id/type/edge is identical.
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

/** Loose but real structural validity check: every WGSL text this backend
 *  produces must start with the `sg_main` entry declaration (required by
 *  `renderer.ts`'s `wgslFn` binding — see `wgsl.ts`'s header comment), and
 *  every brace must balance. Not a full WGSL parser (none is a project
 *  dependency), but catches the class of mistake this backend is most likely
 *  to make: malformed signatures, unbalanced blocks, leftover GLSL syntax. */
function assertLooksLikeValidWgsl(module: string): void {
  expect(module.startsWith('fn sg_main(')).toBe(true);
  const opens = (module.match(/{/g) ?? []).length;
  const closes = (module.match(/}/g) ?? []).length;
  expect(opens).toBe(closes);
  expect(opens).toBeGreaterThan(0);
  // No leftover GLSL-only syntax should ever appear in WGSL output.
  expect(module).not.toContain('gl_FragColor');
  expect(module).not.toMatch(/\bvarying\b/);
  expect(module).not.toMatch(/\battribute\b/);
}

describe('wgslBackend.compileGraph', () => {
  it('registers into the shared backend registry', () => {
    expect(backends.get('wgsl')).toBe(wgslBackend);
  });

  it('produces a valid WGSL module for UV -> FBM -> Ramp -> Output', () => {
    const program = wgslBackend.compileGraph(uvFbmRampOutputGraph());
    expect(program.diagnostics).toEqual([]);
    expect(program.target).toBe('wgsl');
    expect(typeof program.module).toBe('string');
    assertLooksLikeValidWgsl(program.module ?? '');
    expect(program.module).toContain('sg_fbm(');
    expect(program.module).toMatch(/return\s+.+;\n}/);
  });

  it('produces a valid WGSL module for UV -> FBM -> Ramp -> Mix -> Output (exercises color<->vec3 coercion)', () => {
    const program = wgslBackend.compileGraph(uvFbmRampMixOutputGraph());
    expect(program.diagnostics).toEqual([]);
    assertLooksLikeValidWgsl(program.module ?? '');
    expect(program.module).toMatch(/mix\(/);
  });

  it('is headless: pure data in, a CompiledProgram out, no globals/DOM touched', () => {
    expect(typeof window).toBe('undefined');
    const program = wgslBackend.compileGraph(uvFbmRampOutputGraph());
    expect(program.target).toBe('wgsl');
    expect(typeof program.module).toBe('string');
    expect(program.vertex).toBeUndefined();
    expect(program.fragment).toBeUndefined();
  });

  it('dedupes uniforms by name and back-references each to its NodeParam id', () => {
    const program = wgslBackend.compileGraph(uvFbmRampOutputGraph());
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
    expect(() => wgslBackend.compileGraph(graph)).not.toThrow();
    const program = wgslBackend.compileGraph(graph);
    expect(program.diagnostics.some((d) => d.level === 'error')).toBe(true);
    assertLooksLikeValidWgsl(program.module ?? '');
  });

  it('previewNodeId wraps an arbitrary node output for display', () => {
    const graph = uvFbmRampOutputGraph();
    const program = wgslBackend.compileGraph(graph, { previewNodeId: 'fbm1' });
    expect(program.diagnostics).toEqual([]);
    expect(program.module).toMatch(/return vec4<f32>\(vec3<f32>\(fbm_\d+\), 1\.0\);/);
  });

  it('sourceMap lines index into the real module text and name the emitting node', () => {
    const graph = uvFbmRampOutputGraph();
    const program = wgslBackend.compileGraph(graph);
    expect(program.sourceMap && program.sourceMap.length).toBeGreaterThan(0);
    const lines = (program.module ?? '').split('\n');

    for (const entry of program.sourceMap ?? []) {
      expect(entry.line).toBeGreaterThanOrEqual(1);
      expect(entry.line).toBeLessThanOrEqual(lines.length);
    }

    const fbmEntry = program.sourceMap?.find((e) => e.nodeId === 'fbm1');
    expect(fbmEntry).toBeDefined();
    expect(lines[(fbmEntry as { line: number }).line - 1]).toMatch(/sg_fbm\(/);

    const rampEntries = (program.sourceMap ?? []).filter((e) => e.nodeId === 'ramp1');
    expect(rampEntries).toHaveLength(2);
    expect(lines[rampEntries[0].line - 1]).toMatch(/smoothstep\(/);
    expect(lines[rampEntries[1].line - 1]).toMatch(/mix\(/);
  });
});

describe('wgslBackend.compileDocument', () => {
  function twoLayerDoc(): ShaderDocument {
    const doc = emptyDocument('Composite');
    const overlay = emptyLayer('Overlay');
    overlay.blend = 'multiply';
    overlay.opacity = 0.5;
    doc.layerStack.layers.push(overlay);
    return doc;
  }

  it('composites bottom-to-top with the layer blend function and a final return', () => {
    const doc = twoLayerDoc();
    const program = wgslBackend.compileDocument(doc);
    expect(program.diagnostics).toEqual([]);
    const module = program.module ?? '';
    assertLooksLikeValidWgsl(module);
    expect(module).toMatch(/= sg_blendMultiply\(/);
    const lines = module.split('\n');
    // Last statement inside `sg_main` (line before its closing `}`).
    const closeIdx = lines.indexOf('}');
    expect(lines[closeIdx - 1]).toMatch(/return vec4<f32>\(.+, 1\.0\);/);
  });

  it('honors solo: only soloed layers composite, regardless of enabled', () => {
    const doc = twoLayerDoc();
    doc.layerStack.layers[0].soloed = true;
    doc.layerStack.layers[1].enabled = false;
    const program = wgslBackend.compileDocument(doc);
    const blendCalls = (program.module ?? '').match(/= sg_blend\w+\(/g) ?? [];
    expect(blendCalls).toHaveLength(1);
  });

  it('previewLayerId isolates a single layer, bypassing compositing', () => {
    const doc = twoLayerDoc();
    const overlayId = doc.layerStack.layers[1].id;
    const program = wgslBackend.compileDocument(doc, { previewLayerId: overlayId });
    expect(program.module).not.toMatch(/= sg_blend\w+\(/);
    expect(program.module).toContain('return');
  });

  // Same generalization as `glsl-es.test.ts`: a Layers-panel row's thumbnail
  // for a GROUP compiles through this exact path — `previewLayerId` naming a
  // `LayerGroup` folds its own children in isolation.
  it('previewLayerId isolates a GROUP by folding its own children, bypassing the parent stack', () => {
    const doc = twoLayerDoc();
    const group: LayerGroup = {
      kind: 'group',
      id: 'grp1',
      name: 'Group',
      blend: 'normal',
      opacity: 1,
      enabled: true,
      visible: true,
      children: doc.layerStack.layers,
    };
    const third = emptyLayer('Third');
    const wrapped = emptyDocument('Wrapped');
    wrapped.layerStack.layers = [group, third];

    const program = wgslBackend.compileDocument(wrapped, { previewLayerId: 'grp1' });
    expect(program.diagnostics).toEqual([]);
    // Two blend call sites (the group's own two children) — never a third
    // for the group's own blend into the parent stack.
    const blendCalls = (program.module ?? '').match(/= sg_blend\w+\(/g) ?? [];
    expect(blendCalls).toHaveLength(2);
    expect(program.module).toContain('return');
  });

  it('previewLayerId reports a diagnostic instead of throwing when the id resolves to nothing', () => {
    const doc = twoLayerDoc();
    const program = wgslBackend.compileDocument(doc, { previewLayerId: 'does-not-exist' });
    expect(program.diagnostics.some((d) => d.level === 'error')).toBe(true);
  });

  it('previewNodeId resolves the owning layer and isolates it, bypassing compositing', () => {
    const doc = twoLayerDoc();
    (doc.layerStack.layers[1] as ShaderLayer).graph = uvFbmRampOutputGraph();
    const program = wgslBackend.compileDocument(doc, { previewNodeId: 'fbm1' });
    expect(program.diagnostics).toEqual([]);
    expect(program.module).not.toMatch(/= sg_blend\w+\(/);
    expect(program.module).toMatch(/return vec4<f32>\(vec3<f32>\(fbm_\d+\), 1\.0\);/);
  });

  it('previewNodeId reports a diagnostic instead of throwing when no layer owns the node', () => {
    const doc = twoLayerDoc();
    const program = wgslBackend.compileDocument(doc, { previewNodeId: 'does-not-exist' });
    expect(program.diagnostics.some((d) => d.level === 'error')).toBe(true);
  });

  it('sourceMap lines stay correct across multiple composited layers', () => {
    const doc = twoLayerDoc();
    (doc.layerStack.layers[1] as ShaderLayer).graph = uvFbmRampOutputGraph();
    const program = wgslBackend.compileDocument(doc);
    const lines = (program.module ?? '').split('\n');

    const fbmEntry = program.sourceMap?.find((e) => e.nodeId === 'fbm1');
    expect(fbmEntry).toBeDefined();
    expect(lines[(fbmEntry as { line: number }).line - 1]).toMatch(/sg_fbm\(/);
  });

  describe('layer groups', () => {
    // Same "compiled source is provably equivalent" substitute for a GPU
    // pixel diff that `glsl-es.test.ts` uses for this same scenario (this
    // backend is `headless: true`, and there is no GPU/pixel harness in this
    // test environment). Unlike glsl-es, `output.surface`'s WGSL emitter has
    // no per-layer `return`-equivalent side effect (see its own comment in
    // `nodes/definitions/output.ts`) — the ONLY `return` in `sg_main`'s body
    // is the final composite write, so the body comparison here is simpler:
    // drop just that one trailing line.
    function mainBody(module: string): string {
      const start = module.indexOf('{') + 1;
      const end = module.indexOf('\n}');
      return module.slice(start, end).replace(/^\n/, '');
    }

    it('a document with a top-level group composites its children identically to the equivalent ungrouped document', () => {
      const flatDoc = twoLayerDoc();
      const flatProgram = wgslBackend.compileDocument(flatDoc);
      expect(flatProgram.diagnostics).toEqual([]);
      const flatBody = mainBody(flatProgram.module ?? '');

      const groupedDoc = emptyDocument('Grouped');
      const group: LayerGroup = {
        kind: 'group',
        id: 'grp_everything',
        name: 'Everything',
        blend: 'normal',
        opacity: 1,
        enabled: true,
        visible: true,
        children: flatDoc.layerStack.layers,
      };
      groupedDoc.layerStack.layers = [group];
      const groupedProgram = wgslBackend.compileDocument(groupedDoc);
      expect(groupedProgram.diagnostics).toEqual([]);
      const groupedBody = mainBody(groupedProgram.module ?? '');

      const flatLines = flatBody.split('\n');
      const flatBodyWithoutFinalReturn = flatLines.slice(0, -1).join('\n');
      expect(flatLines.at(-1)?.trim()).toMatch(/^return vec4<f32>\(/);
      expect(groupedBody.startsWith(flatBodyWithoutFinalReturn)).toBe(true);

      const groupOpacityUniform = layerOpacityUniformName(group.id);
      expect(groupedProgram.uniforms.map((u) => u.name)).toContain(groupOpacityUniform);
      const extra = groupedBody.slice(flatBodyWithoutFinalReturn.length);
      const wrappingLine = extra
        .split('\n')
        .find((line) => line.includes('sg_blendNormal(vec3<f32>(0.0), (vec4<f32>(') && line.includes(groupOpacityUniform));
      expect(wrappingLine).toBeDefined();
      const wrappingVar = wrappingLine!.match(/let (\w+):/)![1];
      expect(extra.trim().endsWith(`return vec4<f32>(${wrappingVar}, 1.0);`)).toBe(true);
    });
  });

  it('falls back to Normal with a warning diagnostic for the unimplemented "custom" blend', () => {
    const doc = twoLayerDoc();
    doc.layerStack.layers[1].blend = 'custom';
    const program = wgslBackend.compileDocument(doc);
    const normalCallSites = (program.module ?? '').match(/= sg_blendNormal\(/g) ?? [];
    expect(normalCallSites).toHaveLength(2);
    expect(program.diagnostics.some((d) => d.level === 'warning' && d.message.includes('custom'))).toBe(
      true,
    );
  });

  it("declares each layer's opacity as a uniform (same naming convention as glsl-es)", () => {
    const doc = twoLayerDoc();
    const overlayId = doc.layerStack.layers[1].id;
    const overlayOpacityName = layerOpacityUniformName(overlayId);
    const program = wgslBackend.compileDocument(doc);

    const uniform = program.uniforms.find((u) => u.name === overlayOpacityName);
    expect(uniform).toEqual({
      name: overlayOpacityName,
      type: 'float',
      paramId: 'opacity',
      default: 0.5,
    });
    // Declared as an `sg_main` function parameter, not a WGSL `var<uniform>`
    // global — see `wgsl.ts`'s header comment on the `wgslFn` binding
    // convention `renderer.ts` relies on.
    expect(program.module).toContain(`${overlayOpacityName}: f32`);
  });
});

describe('coerceWgsl', () => {
  it('is the identity for identical types', () => {
    expect(coerceWgsl('x', 'float', 'float')).toBe('x');
  });

  it('produces the documented conversion for every table entry', () => {
    expect(coerceWgsl('i', 'int', 'float')).toBe('f32(i)');
    expect(coerceWgsl('f', 'float', 'int')).toBe('i32(f)');
    expect(coerceWgsl('c', 'color', 'vec3')).toBe('c');
    expect(coerceWgsl('n', 'normal', 'vec3')).toBe('n');
    expect(coerceWgsl('v', 'vec3', 'color')).toBe('v');
    expect(coerceWgsl('v4', 'vec4', 'color')).toBe('v4.rgb');
    expect(coerceWgsl('c', 'color', 'vec4')).toBe('vec4<f32>(c, 1.0)');
    expect(coerceWgsl('v', 'vec3', 'normal')).toBe('normalize(v)');
  });

  it('returns undefined for a pair with no registered conversion', () => {
    expect(coerceWgsl('x', 'bool', 'sampler2D')).toBeUndefined();
  });

  // Mirrors `lower.test.ts`'s "GLSL_COERCIONS exhaustiveness" check: proves
  // the second backend's coercion table is exhaustive against the SAME
  // target-neutral `SOCKET_COMPATIBILITY`, independent of `coerceGlsl`'s own
  // table (see this file/task's `lower.ts` reconciliation report).
  it('is exhaustive: supplies a real conversion for every non-identity permitted (from, to) pair', () => {
    const SOCKET_TYPES = Object.keys(SOCKET_COMPATIBILITY) as SocketType[];
    const missing: string[] = [];
    for (const to of SOCKET_TYPES) {
      for (const from of SOCKET_COMPATIBILITY[to]) {
        if (from === to) continue;
        if (coerceWgsl('x', from, to) === undefined) missing.push(`${from}->${to}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('wgslLiteral', () => {
  it('formats floats with an explicit decimal point', () => {
    expect(wgslLiteral(2, 'float')).toBe('2.0');
    expect(wgslLiteral(0.5, 'float')).toBe('0.5');
  });

  it('formats vectors with WGSL constructor syntax, padding a short array with zeros', () => {
    expect(wgslLiteral([1, 2], 'vec3')).toBe('vec3<f32>(1.0, 2.0, 0.0)');
  });

  it('falls back to a safe default when the value is missing entirely', () => {
    expect(wgslLiteral(undefined, 'vec2')).toBe('vec2<f32>(0.0, 0.0)');
    expect(wgslLiteral(undefined, 'bool')).toBe('false');
  });
});

// Not part of the (from, to) table above but exercised by `ScalarOrVector`
// throughout: guards against accidentally emitting a bare scalar literal
// where WGSL requires an explicit vector constructor (a real category of
// invalid-WGSL bug GLSL's laxer implicit-broadcast rules would never catch).
describe('wgslLiteral / defaults never leak a bare scalar into a vector context', () => {
  it('vec4 default padding always yields a 4-component constructor', () => {
    const literal: ScalarOrVector | undefined = undefined;
    expect(wgslLiteral(literal, 'vec4')).toMatch(/^vec4<f32>\([^)]+\)$/);
  });
});
