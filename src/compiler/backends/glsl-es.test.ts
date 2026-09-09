import { beforeEach, describe, expect, it } from 'vitest';

import { emptyDocument, type ShaderDocument, type ShaderGraph } from '../../model/document';
import { emptyLayer } from '../../model/factory';
import type { SocketTypeLookup } from '../../model/connect';
import { SUBGRAPH_INSTANCE_NODE_TYPE, extractSubGraph } from '../../model/subgraph';
import { registerStarterNodes } from '../../nodes/definitions';
import { CHUNK_RAW_NODE_TYPE } from '../../nodes/definitions/chunk';
import { NodeRegistry, nodes } from '../../nodes/registry';
import { backends } from '../backend';
import { coerceGlsl, glslEsBackend, glslLiteral, layerOpacityUniformName } from './glsl-es';

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

  // Powers the code panel's click-to-source: every `sourceMap` entry must
  // name the line that ACTUALLY resulted from that node's own emitter, not an
  // approximation — verified by indexing into the real fragment text, not by
  // asserting shape alone.
  it('sourceMap lines index into the real fragment text and name the emitting node', () => {
    const graph = uvFbmRampOutputGraph();
    const program = glslEsBackend.compileGraph(graph);
    expect(program.sourceMap && program.sourceMap.length).toBeGreaterThan(0);
    const lines = (program.fragment ?? '').split('\n');

    for (const entry of program.sourceMap ?? []) {
      // 1-indexed per entry contract; must land inside the fragment.
      expect(entry.line).toBeGreaterThanOrEqual(1);
      expect(entry.line).toBeLessThanOrEqual(lines.length);
    }

    const fbmEntry = program.sourceMap?.find((e) => e.nodeId === 'fbm1');
    expect(fbmEntry).toBeDefined();
    expect(lines[(fbmEntry as { line: number }).line - 1]).toMatch(/sg_fbm\(/);

    // color.ramp emits two statements; both must be attributed to it.
    const rampEntries = (program.sourceMap ?? []).filter((e) => e.nodeId === 'ramp1');
    expect(rampEntries).toHaveLength(2);
    expect(lines[rampEntries[0].line - 1]).toMatch(/smoothstep\(/);
    expect(lines[rampEntries[1].line - 1]).toMatch(/mix\(/);
  });
});

// Phase 5 fidelity verification: a document built via "Selective graphing"
// (`graphFromRecognizedObject` -> a `chunk.raw` node) must compile through
// this SAME backend, with no Phase-5-specific branching anywhere in it — see
// the "Fidelity verification wiring" task note. Regression coverage for the
// two real gaps that fix found: a `chunk.raw` node has no sockets, so it was
// silently pruned as unreachable (`resolveOrder`); and even once reachable,
// its raw text (top-level `uniform`/function declarations) was landing
// inside `main()` via `emit` instead of ahead of it via the new `prelude`.
describe('glslEsBackend — chunk.raw fidelity (Phase 5 selective graphing)', () => {
  const chunkText = [
    'uniform float uWarp;',
    'float sg_terrain(vec3 p) {',
    '  return sin(p.x * uWarp);',
    '}',
  ].join('\n');

  function graphWithGraphedChunk(): ShaderGraph {
    const base = uvFbmRampOutputGraph();
    return {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: 'chunk1',
          type: CHUNK_RAW_NODE_TYPE,
          position: { x: 0, y: 0 },
          params: [],
          chunkSource: { name: 'GLSL_TERRAIN', text: chunkText, requires: [] },
        },
      ],
    };
  }

  it('is not pruned despite having no sockets to reach the output through', () => {
    const program = glslEsBackend.compileGraph(graphWithGraphedChunk());
    expect(program.diagnostics).toEqual([]);
    expect(program.fragment).toContain(chunkText);
  });

  it('lands its raw uniform/function text ahead of main(), not inside the body', () => {
    const program = glslEsBackend.compileGraph(graphWithGraphedChunk());
    const fragment = program.fragment ?? '';
    const mainIndex = fragment.indexOf('void main() {');
    const chunkIndex = fragment.indexOf(chunkText);
    expect(mainIndex).toBeGreaterThan(-1);
    expect(chunkIndex).toBeGreaterThan(-1);
    expect(chunkIndex).toBeLessThan(mainIndex);
  });

  it('round-trips through a full document compile unmodified (no Phase-5 branching in compileDocument)', () => {
    const doc = emptyDocument('Graphed chunk');
    doc.layerStack.layers[0].graph = graphWithGraphedChunk();

    const program = glslEsBackend.compileDocument(doc);

    expect(program.diagnostics).toEqual([]);
    expect(program.fragment).toContain(chunkText);
    expect(program.fragment).toContain('gl_FragColor');
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

  // Regression guard for the pre-existing gap flagged by the thumbnails task:
  // `compileDocument` only honored `previewLayerId`, never `previewNodeId`, so
  // `PreviewRenderer`'s `ViewerSource: {kind:'node'}` (solo a node to the MAIN
  // viewer) silently fell back to the full composite instead of that node's
  // output. Must resolve which layer owns the node and isolate it exactly
  // like `previewLayerId`, bypassing compositing entirely.
  it('previewNodeId resolves the owning layer and isolates it, bypassing compositing', () => {
    const doc = twoLayerDoc();
    doc.layerStack.layers[1].graph = uvFbmRampOutputGraph();
    const program = glslEsBackend.compileDocument(doc, { previewNodeId: 'fbm1' });
    expect(program.diagnostics).toEqual([]);
    expect(program.fragment).not.toMatch(/= sg_blend\w+\(/);
    expect(program.fragment).toMatch(/gl_FragColor = vec4\(vec3\(fbm_\d+\), 1\.0\);/);
  });

  it('previewNodeId reports a diagnostic instead of throwing when no layer owns the node', () => {
    const doc = twoLayerDoc();
    const program = glslEsBackend.compileDocument(doc, { previewNodeId: 'does-not-exist' });
    expect(program.diagnostics.some((d) => d.level === 'error')).toBe(true);
  });

  // The second layer's nodes are emitted into the SAME shared body after the
  // first layer's; the sourceMap must carry that offset forward, not restart
  // from each layer's own zero.
  it('sourceMap lines stay correct across multiple composited layers', () => {
    const doc = twoLayerDoc();
    doc.layerStack.layers[1].graph = uvFbmRampOutputGraph();
    const program = glslEsBackend.compileDocument(doc);
    const lines = (program.fragment ?? '').split('\n');

    const fbmEntry = program.sourceMap?.find((e) => e.nodeId === 'fbm1');
    expect(fbmEntry).toBeDefined();
    expect(lines[(fbmEntry as { line: number }).line - 1]).toMatch(/sg_fbm\(/);
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

  // Regression guard for the known issue this task fixed: opacity used to be
  // baked in as a GLSL literal (`fmtNum(layer.opacity)`), which meant
  // dragging a layer's opacity slider forced a recompile. It must now be a
  // uniform, exactly like every `NodeParam`-backed value (`UniformSpec.paramId`).
  it("declares each layer's opacity as a uniform instead of a compile-time literal", () => {
    const doc = twoLayerDoc();
    const overlayId = doc.layerStack.layers[1].id;
    const overlayOpacityName = layerOpacityUniformName(overlayId);
    const program = glslEsBackend.compileDocument(doc);

    const uniform = program.uniforms.find((u) => u.name === overlayOpacityName);
    expect(uniform).toEqual({
      name: overlayOpacityName,
      type: 'float',
      paramId: 'opacity',
      default: 0.5,
    });
    expect(program.fragment).toContain(`uniform float ${overlayOpacityName};`);
    // The blend call site references the uniform, not a baked `0.5` literal.
    const blendLine = (program.fragment ?? '')
      .split('\n')
      .find((line) => line.includes('= sg_blendMultiply('));
    expect(blendLine).toContain(overlayOpacityName);
    expect(blendLine).not.toMatch(/,\s*0\.5\)/);
  });

  it("re-declaring the same document produces the identical fragment when only opacity's uniform default changes", () => {
    // Two different opacity values compile to the SAME shader text modulo the
    // uniform's `default` — proving opacity never perturbs program topology.
    const a = twoLayerDoc();
    const b = twoLayerDoc();
    // Match both layers' random ids so only opacity differs.
    b.layerStack.layers[0].id = a.layerStack.layers[0].id;
    b.layerStack.layers[1].id = a.layerStack.layers[1].id;
    b.layerStack.layers[1].opacity = 0.9;

    const programA = glslEsBackend.compileDocument(a);
    const programB = glslEsBackend.compileDocument(b);

    expect(programA.fragment).toBe(programB.fragment);
    expect(programA.uniforms.find((u) => u.name === layerOpacityUniformName(a.layerStack.layers[1].id))?.default).toBe(
      0.5,
    );
    expect(programB.uniforms.find((u) => u.name === layerOpacityUniformName(b.layerStack.layers[1].id))?.default).toBe(
      0.9,
    );
  });

  // A mask graph terminates at `output.mask` instead of `output.surface` and
  // is compiled through the same `lowerGraph` path as the layer's own graph,
  // sharing the document's single emit sink — no separate compiled program.
  function uvFbmMaskGraph(): ShaderGraph {
    return {
      nodes: [
        { id: 'maskUv1', type: 'input.uv', position: { x: 0, y: 0 }, params: [] },
        { id: 'maskFbm1', type: 'noise.fbm', position: { x: 200, y: 0 }, params: [] },
        { id: 'maskOut1', type: 'output.mask', position: { x: 400, y: 0 }, params: [] },
      ],
      edges: [
        {
          id: 'maskUv1:uv->maskFbm1:uv',
          source: { node: 'maskUv1', socket: 'uv' },
          target: { node: 'maskFbm1', socket: 'uv' },
        },
        {
          id: 'maskFbm1:value->maskOut1:value',
          source: { node: 'maskFbm1', socket: 'value' },
          target: { node: 'maskOut1', socket: 'value' },
        },
      ],
      outputNodeId: 'maskOut1',
    };
  }

  it('golden snapshot: a masked layer multiplies the mask value into the opacity term, per-pixel', () => {
    const doc = twoLayerDoc();
    const overlay = doc.layerStack.layers[1];
    overlay.maskGraph = uvFbmMaskGraph();
    const overlayOpacityName = layerOpacityUniformName(overlay.id);

    const program = glslEsBackend.compileDocument(doc);
    expect(program.diagnostics).toEqual([]);
    const fragment = program.fragment ?? '';

    // The mask graph's own nodes (fbm, then `output.mask`'s clamp) are
    // lowered straight into the shared body, not a separate program.
    expect(fragment).toMatch(/sg_fbm\(/);
    expect(fragment).toMatch(/float mask_\d+ = clamp\(fbm_\d+, 0\.0, 1\.0\);/);

    // The blend call site multiplies the mask's value into the opacity
    // uniform, per-pixel — not a flat scalar, and not a second uniform.
    const blendLine = fragment.split('\n').find((line) => line.includes('= sg_blendMultiply('));
    expect(blendLine).toMatch(new RegExp(`\\(${overlayOpacityName} \\* mask_\\d+\\)`));
  });

  it('a layer with no maskGraph composites exactly as before (opacity uniform alone)', () => {
    const doc = twoLayerDoc();
    const overlayOpacityName = layerOpacityUniformName(doc.layerStack.layers[1].id);
    const program = glslEsBackend.compileDocument(doc);
    const blendLine = (program.fragment ?? '')
      .split('\n')
      .find((line) => line.includes('= sg_blendMultiply('));
    expect(blendLine).toContain(`, ${overlayOpacityName});`);
  });

  it("a mask graph with no resolvable output falls back to the layer's opacity alone, with a diagnostic", () => {
    const doc = twoLayerDoc();
    const overlay = doc.layerStack.layers[1];
    overlay.maskGraph = { nodes: [], edges: [], outputNodeId: 'does-not-exist' };
    const overlayOpacityName = layerOpacityUniformName(overlay.id);

    const program = glslEsBackend.compileDocument(doc);
    expect(
      program.diagnostics.some((d) => d.level === 'error' && d.message.includes('mask graph')),
    ).toBe(true);
    const blendLine = (program.fragment ?? '')
      .split('\n')
      .find((line) => line.includes('= sg_blendMultiply('));
    expect(blendLine).toContain(`, ${overlayOpacityName});`);
  });
});

// End-to-end proof that `subGraphs` actually reaches `lowerGraph` through
// `compileDocument`, not just through `lowerGraph` directly (see
// `lower.test.ts`'s "lowerGraph subgraph instance inlining" for that lower-level
// coverage). Before this task, neither backend forwarded `CompileOptions.subGraphs`
// nor `ShaderDocument.subGraphs` into its internal `lowerGraph` calls, so a
// subgraph instance nested inside a real document silently inlined as nothing.
describe('glslEsBackend.compileDocument — subgraph instances (end-to-end)', () => {
  const registry = registerStarterNodes(new NodeRegistry());

  function registryLookup(graph: ShaderGraph): SocketTypeLookup {
    return (nodeId, socketId, direction) => {
      const node = graph.nodes.find((n) => n.id === nodeId);
      const def = node ? registry.get(node.type) : undefined;
      const sockets = direction === 'out' ? def?.outputs : def?.inputs;
      return sockets?.find((s) => s.id === socketId)?.type;
    };
  }

  const mkEdge = (sn: string, ss: string, tn: string, ts: string) => ({
    id: `${sn}:${ss}->${tn}:${ts}`,
    source: { node: sn, socket: ss },
    target: { node: tn, socket: ts },
  });

  it('compiles a document whose layer contains a subgraph instance to the exact same program as the ungrouped equivalent', () => {
    // ext_in --b--> add1 --a--> mul1 --a--> out1.roughness  (add1, mul1 extracted)
    const originalGraph: ShaderGraph = {
      nodes: [
        { id: 'ext_in', type: 'math.add', position: { x: 0, y: 0 }, params: [] },
        { id: 'add1', type: 'math.add', position: { x: 100, y: 0 }, params: [] },
        { id: 'mul1', type: 'math.mul', position: { x: 200, y: 0 }, params: [] },
        { id: 'out1', type: 'output.surface', position: { x: 300, y: 0 }, params: [] },
      ],
      edges: [
        mkEdge('ext_in', 'result', 'add1', 'b'),
        mkEdge('add1', 'result', 'mul1', 'a'),
        mkEdge('mul1', 'result', 'out1', 'roughness'),
      ],
      outputNodeId: 'out1',
    };

    const extraction = extractSubGraph(originalGraph, ['add1', 'mul1'], 'AddThenMul', registryLookup(originalGraph));
    if (!extraction.ok) throw new Error(extraction.message);
    expect(extraction.parentGraph.nodes.some((n) => n.type === SUBGRAPH_INSTANCE_NODE_TYPE)).toBe(true);

    // Two single-layer documents sharing the same layer id, so only the
    // presence/absence of the subgraph instance can perturb the fragment.
    const plainDoc = emptyDocument('Plain');
    plainDoc.layerStack.layers[0].graph = originalGraph;

    const instancedDoc = emptyDocument('Instanced');
    instancedDoc.layerStack.layers[0].id = plainDoc.layerStack.layers[0].id;
    instancedDoc.layerStack.layers[0].graph = extraction.parentGraph;
    instancedDoc.subGraphs = [extraction.subGraph];

    const plainProgram = glslEsBackend.compileDocument(plainDoc);
    const instancedProgram = glslEsBackend.compileDocument(instancedDoc);

    expect(plainProgram.diagnostics).toEqual([]);
    expect(instancedProgram.diagnostics).toEqual([]);
    // The whole point of this test: without `subGraphs` threaded through,
    // the instance node would silently fail to resolve and this equality
    // would fail (or the instanced fragment would be missing the inlined
    // add/mul statements entirely).
    expect(instancedProgram.fragment).toBe(plainProgram.fragment);
    expect(instancedProgram.fragment).toMatch(/float add_\d+ = /);
    expect(instancedProgram.fragment).toMatch(/float mul_\d+ = /);
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
