import { describe, expect, it } from 'vitest';

import { emptyDocument, type ShaderDocument, type ShaderLayer } from '../model/document';
import { emptyLayer } from '../model/factory';
import {
  collectUniformValues,
  layerOpacityUniformName,
  paramUniformName,
  sameUniformValue,
  topologySignature,
} from './topology';

/** Every fixture document here is a bare `emptyDocument()` with no groups —
 *  its sole top-level stack node is always a leaf. */
function layer0(doc: ShaderDocument): ShaderLayer {
  return doc.layerStack.layers[0] as ShaderLayer;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
function docWithOneParamNode(): ShaderDocument {
  const doc = emptyDocument('Topology fixture');
  const layer = layer0(doc);
  layer.graph.nodes.unshift({
    id: 'fbm1',
    type: 'noise.fbm',
    position: { x: 0, y: 0 },
    params: [
      { id: 'frequency', label: 'Frequency', type: 'float', value: 2, ui: 'slider' },
      { id: 'octaves', label: 'Octaves', type: 'int', value: 4, ui: 'slider' },
    ],
  });
  return doc;
}

function sig(doc: ShaderDocument) {
  return topologySignature(doc, 'glsl-es', { kind: 'document' });
}

/** `emptyDocument`/`emptyLayer` mint fresh random ids every call, which would
 *  swamp these comparisons (ids are legitimately part of the signature — see
 *  `layerOpacityUniformName` — but are stable across edits to one real
 *  in-session document). Clone instead of re-minting so only the field under
 *  test differs, exactly like a real store edit would. */
function clone(doc: ShaderDocument): ShaderDocument {
  return JSON.parse(JSON.stringify(doc)) as ShaderDocument;
}

describe('topologySignature', () => {
  it('is stable for the identical document', () => {
    const doc = docWithOneParamNode();
    expect(sig(doc)).toBe(sig(doc));
  });

  it('does NOT change when a node param value changes', () => {
    const before = docWithOneParamNode();
    const after = clone(before);
    layer0(after).graph.nodes[0].params[0].value = 30;
    expect(sig(before)).toBe(sig(after));
  });

  it('does NOT change when layer opacity changes (the known-issue fix)', () => {
    const before = docWithOneParamNode();
    const after = clone(before);
    after.layerStack.layers[0].opacity = 0.3;
    expect(sig(before)).toBe(sig(after));
  });

  it('does NOT change on node position, previewEnabled, or collapsed edits', () => {
    const before = docWithOneParamNode();
    const after = clone(before);
    layer0(after).graph.nodes[0].position = { x: 999, y: 999 };
    layer0(after).graph.nodes[0].previewEnabled = true;
    layer0(after).graph.nodes[0].collapsed = true;
    expect(sig(before)).toBe(sig(after));
  });

  it('changes when a node is added', () => {
    const before = docWithOneParamNode();
    const after = clone(before);
    layer0(after).graph.nodes.push({
      id: 'extra',
      type: 'math.add',
      position: { x: 0, y: 0 },
      params: [],
    });
    expect(sig(before)).not.toBe(sig(after));
  });

  it('changes when an edge connects two nodes', () => {
    const before = docWithOneParamNode();
    const after = clone(before);
    layer0(after).graph.edges.push({
      id: 'fbm1:value->output:baseColor',
      source: { node: 'fbm1', socket: 'value' },
      target: { node: 'output', socket: 'baseColor' },
    });
    expect(sig(before)).not.toBe(sig(after));
  });

  it('changes when a node is bypassed', () => {
    const before = docWithOneParamNode();
    const after = clone(before);
    layer0(after).graph.nodes[0].bypassed = true;
    expect(sig(before)).not.toBe(sig(after));
  });

  it('changes on layer reorder (compositing order)', () => {
    const before = docWithOneParamNode();
    before.layerStack.layers.push(emptyLayer('Second'));
    const after = clone(before);
    // Same layers, reversed composite order.
    after.layerStack.layers.reverse();
    expect(sig(before)).not.toBe(sig(after));
  });

  it('changes on blend mode, enabled, and soloed edits', () => {
    const base = docWithOneParamNode();

    const blendChanged = clone(base);
    blendChanged.layerStack.layers[0].blend = 'multiply';
    expect(sig(base)).not.toBe(sig(blendChanged));

    const enabledChanged = clone(base);
    enabledChanged.layerStack.layers[0].enabled = false;
    expect(sig(base)).not.toBe(sig(enabledChanged));

    const soloedChanged = clone(base);
    soloedChanged.layerStack.layers[0].soloed = true;
    expect(sig(base)).not.toBe(sig(soloedChanged));
  });

  it('changes when the preview rig changes', () => {
    const before = docWithOneParamNode();
    const after = clone(before);
    after.previewRig = 'skybox';
    expect(sig(before)).not.toBe(sig(after));
  });

  it('changes when the target backend changes', () => {
    const doc = docWithOneParamNode();
    const a = topologySignature(doc, 'glsl-es', { kind: 'document' });
    const b = topologySignature(doc, 'wgsl', { kind: 'document' });
    expect(a).not.toBe(b);
  });

  it('changes when the viewer source changes (solo node vs. full composite)', () => {
    const doc = docWithOneParamNode();
    const a = topologySignature(doc, 'glsl-es', { kind: 'document' });
    const b = topologySignature(doc, 'glsl-es', { kind: 'node', nodeId: 'fbm1' });
    expect(a).not.toBe(b);
  });

  it('is unaffected by node/edge array order (only structural presence matters)', () => {
    const a = docWithOneParamNode();
    layer0(a).graph.nodes.push({ id: 'z', type: 'math.add', position: { x: 0, y: 0 }, params: [] });
    layer0(a).graph.nodes.push({ id: 'a', type: 'math.add', position: { x: 0, y: 0 }, params: [] });

    const b = clone(a);
    layer0(b).graph.nodes.reverse();

    expect(sig(a)).toBe(sig(b));
  });
});

describe('paramUniformName / layerOpacityUniformName', () => {
  it('matches the naming convention `paramUniform`/the glsl-es backend actually declare', () => {
    expect(paramUniformName('fbm1', 'frequency')).toBe('u_fbm1_frequency');
    expect(layerOpacityUniformName('layer_abc123')).toBe('u_layer_layer_abc123_opacity');
  });

  it('sanitises ids with characters that are not valid in a GLSL identifier', () => {
    expect(paramUniformName('math.mix#1', 'amount')).toBe('u_math_mix_1_amount');
  });
});

describe('collectUniformValues', () => {
  it('emits one entry per node param plus one synthetic layer-opacity entry', () => {
    const doc = docWithOneParamNode();
    doc.layerStack.layers[0].opacity = 0.75;
    const entries = collectUniformValues(doc);

    const opacityEntry = entries.find((e) => e.name === layerOpacityUniformName(doc.layerStack.layers[0].id));
    expect(opacityEntry).toEqual({
      name: layerOpacityUniformName(doc.layerStack.layers[0].id),
      type: 'float',
      value: 0.75,
    });

    expect(entries).toContainEqual({ name: 'u_fbm1_frequency', type: 'float', value: 2 });
    expect(entries).toContainEqual({ name: 'u_fbm1_octaves', type: 'int', value: 4 });
  });
});

describe('sameUniformValue', () => {
  it('compares scalars by value', () => {
    expect(sameUniformValue(1, 1)).toBe(true);
    expect(sameUniformValue(1, 2)).toBe(false);
    expect(sameUniformValue(true, true)).toBe(true);
  });

  it('compares vector/color tuples element-wise, not by reference', () => {
    expect(sameUniformValue([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(sameUniformValue([1, 2, 3], [1, 2, 4])).toBe(false);
    expect(sameUniformValue([1, 2], [1, 2, 3])).toBe(false);
  });
});
