import { describe, expect, it, vi } from 'vitest';

import { emptyDocument, type ShaderDocument } from '../model/document';
import type { CompileOptions, CompiledProgram } from '../compiler/backend';
import { layerOpacityUniformName } from './topology';
import { PreviewRenderer, type GpuBinding } from './renderer';

// ── Fakes ────────────────────────────────────────────────────────────────────
// No canvas, no WebGL: `GpuBinding` is a plain spy object, and `compile` is
// injected, so this exercises the exact orchestration logic the real
// three.js-backed binding runs through, without a GPU.
function fakeGpu(): GpuBinding & {
  bindCalls: number;
  uniformWrites: Array<{ name: string; value: unknown }>;
} {
  return {
    bindCalls: 0,
    uniformWrites: [],
    bind() {
      this.bindCalls++;
    },
    setUniformValue(name, _type, value) {
      this.uniformWrites.push({ name, value });
    },
    resize() {},
    dispose() {},
  };
}

/** A minimal, valid `CompiledProgram` whose uniform table always includes
 *  every node param's predicted name (i.e. "nothing is baked"), so a value
 *  change never forces a follow-up recompile by itself. */
function fakeCompile(uniformNames: string[]) {
  return vi.fn(
    (_doc: ShaderDocument, _target, _opts: CompileOptions): CompiledProgram => ({
      target: 'glsl-es',
      vertex: 'void main(){}',
      fragment: 'void main(){}',
      uniforms: uniformNames.map((name) => ({ name, type: 'float', default: 0 })),
      diagnostics: [],
    }),
  );
}

function docWithFrequencyNode(): ShaderDocument {
  const doc = emptyDocument('Renderer fixture');
  doc.layerStack.layers[0].graph.nodes.unshift({
    id: 'fbm1',
    type: 'noise.fbm',
    position: { x: 0, y: 0 },
    params: [{ id: 'frequency', label: 'Frequency', type: 'float', value: 2, ui: 'slider' }],
  });
  return doc;
}

function clone(doc: ShaderDocument): ShaderDocument {
  return JSON.parse(JSON.stringify(doc)) as ShaderDocument;
}

describe('PreviewRenderer — recompile vs. direct uniform write', () => {
  it('compiles once on the first setDocument (there is no bound program yet)', () => {
    const gpu = fakeGpu();
    const compile = fakeCompile(['u_fbm1_frequency', layerOpacityUniformName(docWithFrequencyNode().layerStack.layers[0].id)]);
    const renderer = new PreviewRenderer(gpu, { compile });

    renderer.setDocument(docWithFrequencyNode());

    expect(compile).toHaveBeenCalledTimes(1);
    expect(gpu.bindCalls).toBe(1);
  });

  it('a param-only edit (uniform-backed) does NOT trigger a fresh compileDocument call', () => {
    const gpu = fakeGpu();
    const doc = docWithFrequencyNode();
    const opacityName = layerOpacityUniformName(doc.layerStack.layers[0].id);
    const compile = fakeCompile(['u_fbm1_frequency', opacityName]);
    const renderer = new PreviewRenderer(gpu, { compile });

    renderer.setDocument(doc);
    expect(compile).toHaveBeenCalledTimes(1);

    const edited = clone(doc);
    edited.layerStack.layers[0].graph.nodes[0].params[0].value = 9;
    renderer.setDocument(edited);

    // The whole point of this task: dragging a slider never recompiles.
    expect(compile).toHaveBeenCalledTimes(1);
    expect(gpu.bindCalls).toBe(1);
    expect(gpu.uniformWrites).toContainEqual({ name: 'u_fbm1_frequency', value: 9 });
  });

  it('a layer-opacity-only edit (the known-issue fix) does NOT trigger a fresh compileDocument call', () => {
    const gpu = fakeGpu();
    const doc = docWithFrequencyNode();
    const opacityName = layerOpacityUniformName(doc.layerStack.layers[0].id);
    const compile = fakeCompile(['u_fbm1_frequency', opacityName]);
    const renderer = new PreviewRenderer(gpu, { compile });

    renderer.setDocument(doc);
    expect(compile).toHaveBeenCalledTimes(1);

    const edited = clone(doc);
    edited.layerStack.layers[0].opacity = 0.42;
    renderer.setDocument(edited);

    expect(compile).toHaveBeenCalledTimes(1);
    expect(gpu.uniformWrites).toContainEqual({ name: opacityName, value: 0.42 });
  });

  it('an actual topology edit (adding a node) DOES trigger a fresh compileDocument call', () => {
    const gpu = fakeGpu();
    const doc = docWithFrequencyNode();
    const opacityName = layerOpacityUniformName(doc.layerStack.layers[0].id);
    const compile = fakeCompile(['u_fbm1_frequency', opacityName]);
    const renderer = new PreviewRenderer(gpu, { compile });

    renderer.setDocument(doc);
    expect(compile).toHaveBeenCalledTimes(1);

    const edited = clone(doc);
    edited.layerStack.layers[0].graph.nodes.push({
      id: 'extra',
      type: 'math.add',
      position: { x: 0, y: 0 },
      params: [],
    });
    renderer.setDocument(edited);

    expect(compile).toHaveBeenCalledTimes(2);
    expect(gpu.bindCalls).toBe(2);
  });

  it('a value change with no live uniform (baked into source, e.g. `octaves`) forces a recompile', () => {
    const gpu = fakeGpu();
    const doc = docWithFrequencyNode();
    doc.layerStack.layers[0].graph.nodes[0].params.push({
      id: 'octaves',
      label: 'Octaves',
      type: 'int',
      value: 4,
      ui: 'slider',
    });
    const opacityName = layerOpacityUniformName(doc.layerStack.layers[0].id);
    // Deliberately omit `u_fbm1_octaves` from the fake compiled program's
    // uniform table, mirroring the real backend (a compile-time GLSL loop
    // bound has no uniform at all).
    const compile = fakeCompile(['u_fbm1_frequency', opacityName]);
    const renderer = new PreviewRenderer(gpu, { compile });

    renderer.setDocument(doc);
    expect(compile).toHaveBeenCalledTimes(1);

    const edited = clone(doc);
    edited.layerStack.layers[0].graph.nodes[0].params[1].value = 6;
    renderer.setDocument(edited);

    expect(compile).toHaveBeenCalledTimes(2);
    expect(gpu.bindCalls).toBe(2);
  });

  it('reports a compile error via onCompileError and does not touch the GPU binding', () => {
    const gpu = fakeGpu();
    const compile = vi.fn(
      (): CompiledProgram => ({
        target: 'glsl-es',
        uniforms: [],
        diagnostics: [{ level: 'error', message: 'Node "x" is part of a dependency cycle.' }],
      }),
    );
    const onCompileError = vi.fn();
    const renderer = new PreviewRenderer(gpu, { compile, onCompileError });

    renderer.setDocument(docWithFrequencyNode());

    expect(gpu.bindCalls).toBe(0);
    expect(onCompileError).toHaveBeenCalledTimes(1);
    expect(onCompileError).toHaveBeenCalledWith(expect.stringContaining('dependency cycle'));
  });

  it('clears the error via onCompileError(null) once a later edit compiles cleanly', () => {
    const gpu = fakeGpu();
    let broken = true;
    const compile = vi.fn(
      (): CompiledProgram =>
        broken
          ? { target: 'glsl-es', uniforms: [], diagnostics: [{ level: 'error', message: 'broken' }] }
          : { target: 'glsl-es', vertex: '', fragment: '', uniforms: [], diagnostics: [] },
    );
    const onCompileError = vi.fn();
    const renderer = new PreviewRenderer(gpu, { compile, onCompileError });

    renderer.setDocument(docWithFrequencyNode());
    expect(onCompileError).toHaveBeenLastCalledWith(expect.any(String));

    broken = false;
    renderer.markAllDirty();
    expect(onCompileError).toHaveBeenLastCalledWith(null);
    expect(gpu.bindCalls).toBe(1);
  });

  it('setRig/setTarget/setViewerSource force exactly one recompile each, even with an unchanged document', () => {
    const gpu = fakeGpu();
    const doc = docWithFrequencyNode();
    const opacityName = layerOpacityUniformName(doc.layerStack.layers[0].id);
    const compile = fakeCompile(['u_fbm1_frequency', opacityName]);
    const renderer = new PreviewRenderer(gpu, { compile });

    renderer.setDocument(doc);
    expect(compile).toHaveBeenCalledTimes(1);

    renderer.setRig('skybox');
    expect(compile).toHaveBeenCalledTimes(2);

    renderer.setTarget('glsl-es'); // same target: no-op, no extra compile
    expect(compile).toHaveBeenCalledTimes(2);

    renderer.setViewerSource({ kind: 'node', nodeId: 'fbm1' });
    expect(compile).toHaveBeenCalledTimes(3);
  });

  it('the three thumbnail-only methods throw (out of scope for this task)', () => {
    const gpu = fakeGpu();
    const renderer = new PreviewRenderer(gpu, { compile: fakeCompile([]) });
    expect(() => renderer.setVisibleNodes([])).toThrow();
    expect(() => renderer.requestThumbnail({ nodeId: 'x' })).toThrow();
    expect(() => renderer.setThumbnailBudget(16)).toThrow();
  });
});
