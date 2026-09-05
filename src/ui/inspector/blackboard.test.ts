import { describe, expect, it } from 'vitest';

import {
  emptyDocument,
  type NodeParam,
  type ShaderDocument,
  type ShaderNode,
} from '../../model/document';
import { collectExposedParams, describeDocument, withParamExposed } from './blackboard';

const p = (id: string, extra: Partial<NodeParam> = {}): NodeParam => ({
  id,
  label: id,
  type: 'float',
  value: 0,
  ui: 'number',
  ...extra,
});

const node = (id: string, params: NodeParam[]): ShaderNode => ({
  id,
  type: 'noise.fbm',
  position: { x: 0, y: 0 },
  params,
});

/** A two-layer document: base layer holds `fbm`, second layer holds `ramp`. */
function fixture(): ShaderDocument {
  const doc = emptyDocument('Fixture');
  const base = doc.layerStack.layers[0];
  base.graph.nodes.push(node('fbm', [p('frequency', { value: 2 }), p('gain', { value: 0.5 })]));
  return {
    ...doc,
    layerStack: {
      ...doc.layerStack,
      layers: [
        base,
        {
          id: 'layer-2',
          name: 'Detail',
          graph: {
            nodes: [node('ramp', [p('posA', { value: 0.25 })])],
            edges: [],
            outputNodeId: 'ramp',
          },
          blend: 'normal',
          opacity: 1,
          enabled: true,
          visible: true,
        },
      ],
    },
  };
}

describe('collectExposedParams', () => {
  it('is empty until something is exposed', () => {
    expect(collectExposedParams(fixture())).toEqual([]);
  });

  it('collects exposed params across every layer, in layer order', () => {
    let doc = fixture();
    doc = withParamExposed(doc, 'ramp', 'posA', true)!;
    doc = withParamExposed(doc, 'fbm', 'gain', true)!;

    const entries = collectExposedParams(doc);
    expect(entries.map((e) => e.param.id)).toEqual(['gain', 'posA']);
    expect(entries[0]).toMatchObject({ nodeId: 'fbm', layerName: 'Base' });
    expect(entries[1]).toMatchObject({ nodeId: 'ramp', layerName: 'Detail' });
    expect(new Set(entries.map((e) => e.key)).size).toBe(2);
  });

  it('prefers a node title override, then the registry title, then the type', () => {
    let doc = withParamExposed(fixture(), 'fbm', 'gain', true)!;
    expect(collectExposedParams(doc)[0].nodeTitle).toBe('noise.fbm');
    expect(collectExposedParams(doc, () => 'FBM Noise')[0].nodeTitle).toBe('FBM Noise');

    const layers = doc.layerStack.layers.slice();
    const graph = layers[0].graph;
    layers[0] = {
      ...layers[0],
      graph: {
        ...graph,
        nodes: graph.nodes.map((n) => (n.id === 'fbm' ? { ...n, title: 'Continents' } : n)),
      },
    };
    doc = { ...doc, layerStack: { ...doc.layerStack, layers } };
    expect(collectExposedParams(doc, () => 'FBM Noise')[0].nodeTitle).toBe('Continents');
  });

  it('lists document-level global dials after the node params', () => {
    const doc = { ...withParamExposed(fixture(), 'fbm', 'gain', true)!, blackboard: [p('uGlobal')] };
    const entries = collectExposedParams(doc);
    expect(entries.map((e) => e.param.id)).toEqual(['gain', 'uGlobal']);
    expect(entries[1].nodeId).toBeUndefined();
    expect(entries[1].key).toBe('doc:uGlobal');
  });
});

describe('withParamExposed', () => {
  it('sets the flag without mutating the original document', () => {
    const before = fixture();
    const after = withParamExposed(before, 'fbm', 'gain', true)!;
    expect(after).not.toBe(before);
    expect(before.layerStack.layers[0].graph.nodes[1].params[1].exposed).toBeUndefined();
    expect(after.layerStack.layers[0].graph.nodes[1].params[1].exposed).toBe(true);
  });

  it('un-exposes a param in a non-active layer', () => {
    const exposed = withParamExposed(fixture(), 'ramp', 'posA', true)!;
    const cleared = withParamExposed(exposed, 'ramp', 'posA', false)!;
    expect(collectExposedParams(cleared)).toEqual([]);
  });

  it('leaves untouched layers structurally shared', () => {
    const before = fixture();
    const after = withParamExposed(before, 'ramp', 'posA', true)!;
    expect(after.layerStack.layers[0]).toBe(before.layerStack.layers[0]);
    expect(after.layerStack.layers[1]).not.toBe(before.layerStack.layers[1]);
  });

  it('bumps meta.updated', () => {
    const before = { ...fixture(), meta: { created: 'x', updated: 'x' } };
    expect(withParamExposed(before, 'fbm', 'gain', true)!.meta.updated).not.toBe('x');
    expect(withParamExposed(before, 'fbm', 'gain', true)!.meta.created).toBe('x');
  });

  it('returns null for an unknown node, unknown param, or a no-op write', () => {
    const doc = fixture();
    expect(withParamExposed(doc, 'nope', 'gain', true)).toBeNull();
    expect(withParamExposed(doc, 'fbm', 'nope', true)).toBeNull();
    expect(withParamExposed(doc, 'fbm', 'gain', false)).toBeNull();
  });
});

describe('describeDocument', () => {
  it('summarises the fields shown when nothing is selected', () => {
    expect(describeDocument(fixture())).toEqual({
      name: 'Fixture',
      archetype: '—',
      previewRig: 'sphere',
      layerCount: 2,
      exposedCount: 0,
    });
  });

  it('shows a real archetype and counts the dials', () => {
    const doc = { ...withParamExposed(fixture(), 'fbm', 'gain', true)!, archetype: 'rocky' };
    expect(describeDocument(doc)).toMatchObject({ archetype: 'rocky', exposedCount: 1 });
  });
});
