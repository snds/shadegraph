import { describe, expect, it } from 'vitest';

import { SCHEMA_VERSION, emptyDocument, type LayerGroup, type ShaderDocument, type ShaderLayer } from './document';
import { emptyLayer } from './factory';
import { DocumentParseError, deserialize, serialize, validateDocument } from './serialize';

/** A document exercising the fields a bare `emptyDocument()` leaves empty, so
 *  round-trip coverage is not just the happy minimum. */
function richDocument(): ShaderDocument {
  const doc = emptyDocument('Rocky');
  const second = emptyLayer('Crust');
  const graph = (doc.layerStack.layers[0] as ShaderLayer).graph;
  const uvId = 'uv_1';

  graph.nodes.push({
    id: uvId,
    type: 'input.uv',
    title: 'Screen UV',
    position: { x: 40, y: 120 },
    params: [
      { id: 'scale', label: 'Scale', type: 'vec2', value: [2, 2], ui: 'vector' },
      { id: 'tint', label: 'Tint', type: 'color', value: [1, 0.5, 0.25], ui: 'color', exposed: true },
      { id: 'map', label: 'Map', type: 'sampler2D', value: 'asset:123', ui: 'texture' },
    ],
    bypassed: false,
    previewEnabled: true,
    collapsed: false,
  });
  graph.edges.push({
    id: `${uvId}:uv->${graph.outputNodeId}:albedo`,
    source: { node: uvId, socket: 'uv' },
    target: { node: graph.outputNodeId, socket: 'albedo' },
  });
  graph.groups = [
    { id: 'g1', title: 'Base colour', color: '#334455', bounds: { x: 0, y: 0, w: 320, h: 200 } },
  ];

  doc.archetype = 'rocky';
  doc.layerStack.layers.push(second);
  doc.layerStack.activeLayerId = second.id;
  doc.blackboard.push({
    id: 'uNormalStrength',
    label: 'Normal strength',
    type: 'float',
    value: 0.8,
    ui: 'slider',
    min: 0,
    max: 2,
    step: 0.01,
    exposed: true,
    bindUniform: 'uNormalStrength',
  });
  doc.meta.author = 'sean';
  doc.meta.validatedTargets = ['glsl-es'];
  return doc;
}

describe('serialize / deserialize', () => {
  it('round-trips an empty document losslessly', () => {
    const doc = emptyDocument();

    expect(deserialize(serialize(doc))).toEqual(doc);
  });

  it('round-trips a populated document losslessly', () => {
    const doc = richDocument();

    const restored = deserialize(serialize(doc));

    expect(restored).toEqual(doc);
    // toEqual ignores key order but not key *presence*; compare the text too.
    expect(serialize(restored)).toBe(serialize(doc));
  });

  it('survives repeated round-trips without drift', () => {
    const once = serialize(richDocument());
    const twice = serialize(deserialize(once));
    const thrice = serialize(deserialize(twice));

    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  it('emits indented JSON by default and compact JSON on request', () => {
    const doc = emptyDocument();

    expect(serialize(doc)).toContain('\n  ');
    expect(serialize(doc, false)).not.toContain('\n');
  });
});

describe('deserialize validation', () => {
  const parseFails = (json: string, match: RegExp) => {
    expect(() => deserialize(json)).toThrow(DocumentParseError);
    expect(() => deserialize(json)).toThrow(match);
  };

  it('rejects malformed JSON', () => {
    parseFails('{ not json', /Not valid JSON/);
  });

  it('rejects a non-object payload', () => {
    parseFails('[]', /expected a JSON object/);
    parseFails('42', /expected a JSON object/);
  });

  it('rejects a document from a different schema version', () => {
    const doc = { ...emptyDocument(), schemaVersion: '9.9.9' };

    parseFails(JSON.stringify(doc), /Unsupported schema version "9\.9\.9"/);
  });

  it('rejects a document with no layers', () => {
    const doc = emptyDocument();
    doc.layerStack.layers = [];

    parseFails(JSON.stringify(doc), /non-empty array/);
  });

  it('rejects a layer whose graph is missing its output node id', () => {
    const doc = emptyDocument();
    delete (
      (doc.layerStack.layers[0] as ShaderLayer).graph as { outputNodeId?: string }
    ).outputNodeId;

    parseFails(JSON.stringify(doc), /outputNodeId/);
  });

  it('rejects missing top-level fields', () => {
    const doc = emptyDocument();
    delete (doc as { blackboard?: unknown[] }).blackboard;

    parseFails(JSON.stringify(doc), /"blackboard"/);
  });

  it('accepts an already-parsed object through validateDocument', () => {
    const doc = emptyDocument();

    expect(validateDocument(JSON.parse(serialize(doc)))).toEqual(doc);
    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('rejects a group whose "children" array is missing', () => {
    const doc = emptyDocument();
    (doc.layerStack.layers as unknown[]).push({
      kind: 'group',
      id: 'g1',
      name: 'Broken group',
      blend: 'normal',
      opacity: 1,
      enabled: true,
      visible: true,
    });

    parseFails(JSON.stringify(doc), /"children"/);
  });

  it('rejects a document whose only stack nodes are empty groups (no leaf layer anywhere)', () => {
    const doc = emptyDocument();
    doc.layerStack.layers = [
      {
        kind: 'group',
        id: 'g1',
        name: 'Empty group',
        blend: 'normal',
        opacity: 1,
        enabled: true,
        visible: true,
        children: [],
      },
    ];

    parseFails(JSON.stringify(doc), /at least one leaf layer/);
  });
});

describe('legacy documents (pre-LayerGroup)', () => {
  it('loads a saved document that predates the "kind" discriminant', () => {
    const doc = richDocument();
    // Simulate a file saved before `LayerGroup`/`kind` existed: every stack
    // node was implicitly a leaf layer, so the field was never written.
    const legacyJson = JSON.stringify(doc, (key, value) => (key === 'kind' ? undefined : value));
    expect(legacyJson).not.toContain('"kind"');

    const restored = deserialize(legacyJson);
    expect(restored.layerStack.layers.map((l) => l.id)).toEqual(doc.layerStack.layers.map((l) => l.id));
    for (const layer of restored.layerStack.layers) {
      expect(layer.kind).toBe('layer');
    }
    expect((restored.layerStack.layers[0] as ShaderLayer).graph.nodes).toEqual(
      (doc.layerStack.layers[0] as ShaderLayer).graph.nodes,
    );
  });
});

describe('LayerGroup round-trip', () => {
  it('round-trips a document with nested groups (2+ levels deep) losslessly', () => {
    const doc = emptyDocument('Nested');
    const leafA = emptyLayer('A');
    const leafB = emptyLayer('B');
    const leafC = emptyLayer('C');
    const innerGroup: LayerGroup = {
      kind: 'group',
      id: 'inner_group',
      name: 'Inner',
      blend: 'screen',
      opacity: 0.75,
      enabled: true,
      visible: true,
      soloed: false,
      children: [leafB, leafC],
    };
    const outerGroup: LayerGroup = {
      kind: 'group',
      id: 'outer_group',
      name: 'Outer',
      blend: 'multiply',
      opacity: 0.5,
      enabled: true,
      visible: true,
      children: [leafA, innerGroup],
    };
    doc.layerStack.layers = [...doc.layerStack.layers, outerGroup];

    const restored = deserialize(serialize(doc));
    expect(restored).toEqual(doc);
    expect(serialize(restored)).toBe(serialize(doc));
  });
});
