import { beforeEach, describe, expect, it } from 'vitest';

import { deserialize, serialize } from '../model/serialize';
import { nodes, type NodeDefinition } from '../nodes/registry';
import { activeGraph, activeLayer, useEditorStore } from './store';

// Purpose-built definitions rather than the starter set: these tests are about
// the STORE's use of the registry, so the socket types under test must stay
// pinned here and not drift with the Phase 1 node catalogue.
const defs: NodeDefinition[] = [
  {
    type: 'test.uv',
    category: 'input',
    title: 'UV',
    inputs: [],
    outputs: [{ id: 'uv', label: 'UV', type: 'vec2' }],
    emit: {},
  },
  {
    type: 'test.noise',
    category: 'noise',
    title: 'Noise',
    inputs: [{ id: 'uv', label: 'UV', type: 'vec2' }],
    outputs: [{ id: 'value', label: 'Value', type: 'vec3' }],
    params: [
      { id: 'octaves', label: 'Octaves', type: 'int', value: 4, ui: 'slider', min: 1, max: 8 },
      { id: 'offset', label: 'Offset', type: 'vec2', value: [0, 0], ui: 'vector' },
    ],
    previewable: true,
    emit: {},
  },
  {
    type: 'output.surface',
    category: 'output',
    title: 'Surface Output',
    inputs: [
      { id: 'albedo', label: 'Albedo', type: 'color' },
      { id: 'emissive', label: 'Emissive', type: 'color' },
      { id: 'roughness', label: 'Roughness', type: 'float' },
    ],
    outputs: [],
    emit: {},
  },
];

for (const def of defs) if (!nodes.get(def.type)) nodes.register(def);

const store = () => useEditorStore.getState();
const graph = () => activeGraph(store().doc);
const outputId = () => graph().outputNodeId;

/** Add a node and assert it landed, so tests read as one line. */
function add(type: string, x = 0, y = 0): string {
  const id = store().addNode(type, { x, y });
  expect(id).not.toBeNull();
  return id as string;
}

beforeEach(() => {
  store().newDocument('Test');
});

describe('addNode', () => {
  it('instantiates a registry type into the active graph', () => {
    const id = add('test.noise', 120, 40);
    const node = graph().nodes.find((n) => n.id === id);

    expect(node?.type).toBe('test.noise');
    expect(node?.position).toEqual({ x: 120, y: 40 });
    expect(node?.previewEnabled).toBe(true);
    expect(node?.params.map((p) => p.id)).toEqual(['octaves', 'offset']);
  });

  it('deep-clones default params so nodes never share state with the registry', () => {
    const a = add('test.noise');
    const b = add('test.noise');

    store().setParam(a, 'octaves', 7);

    const value = (id: string, param: string) =>
      graph().nodes.find((n) => n.id === id)?.params.find((p) => p.id === param)?.value;

    expect(value(a, 'octaves')).toBe(7);
    expect(value(b, 'octaves')).toBe(4);
    expect(nodes.get('test.noise')?.params?.[0].value).toBe(4);
  });

  it('refuses an unregistered type and records the reason', () => {
    expect(store().addNode('test.nope', { x: 0, y: 0 })).toBeNull();
    expect(store().lastError).toMatch(/Unknown node type/);
    expect(graph().nodes).toHaveLength(1);
  });
});

describe('connect', () => {
  it('accepts a legal vec3 → color link and stores one edge', () => {
    const noise = add('test.noise');

    const verdict = store().connect(
      { node: noise, socket: 'value' },
      { node: outputId(), socket: 'albedo' },
    );

    expect(verdict.ok).toBe(true);
    expect(graph().edges).toHaveLength(1);
    expect(store().lastError).toBeNull();
  });

  it('rejects an illegal vec2 → float link and mutates nothing', () => {
    const uv = add('test.uv');

    const verdict = store().connect(
      { node: uv, socket: 'uv' },
      { node: outputId(), socket: 'roughness' },
    );

    expect(verdict).toMatchObject({ ok: false, reason: 'type-mismatch' });
    expect(graph().edges).toEqual([]);
    expect(store().lastError).toMatch(/Cannot connect vec2 to float/);
  });

  it('refuses a second edge into one input socket', () => {
    const first = add('test.noise');
    const second = add('test.noise');
    store().connect({ node: first, socket: 'value' }, { node: outputId(), socket: 'albedo' });

    const verdict = store().connect(
      { node: second, socket: 'value' },
      { node: outputId(), socket: 'albedo' },
    );

    expect(verdict).toMatchObject({ ok: false, reason: 'target-occupied' });
    expect(graph().edges).toHaveLength(1);
    expect(graph().edges[0].source.node).toBe(first);
  });

  it('lets one output fan out to several inputs', () => {
    const noise = add('test.noise');

    store().connect({ node: noise, socket: 'value' }, { node: outputId(), socket: 'albedo' });
    store().connect({ node: noise, socket: 'value' }, { node: outputId(), socket: 'emissive' });

    expect(graph().edges).toHaveLength(2);
  });
});

describe('disconnect and removeNodes', () => {
  it('drops one edge by id', () => {
    const noise = add('test.noise');
    store().connect({ node: noise, socket: 'value' }, { node: outputId(), socket: 'albedo' });
    const edgeId = graph().edges[0].id;

    store().disconnect(edgeId);

    expect(graph().edges).toEqual([]);
  });

  it('deletes a node together with every edge touching it', () => {
    const uv = add('test.uv');
    const noise = add('test.noise');
    store().connect({ node: uv, socket: 'uv' }, { node: noise, socket: 'uv' });
    store().connect({ node: noise, socket: 'value' }, { node: outputId(), socket: 'albedo' });
    expect(graph().edges).toHaveLength(2);

    store().removeNodes([noise]);

    expect(graph().nodes.map((n) => n.id)).toEqual([outputId(), uv]);
    expect(graph().edges).toEqual([]);
  });

  it('never deletes the output node', () => {
    const before = outputId();

    store().removeNodes([before]);

    expect(graph().nodes.some((n) => n.id === before)).toBe(true);
    expect(store().lastError).toMatch(/output node cannot be deleted/i);
  });

  it('deletes the deletable nodes in a mixed selection and clears selection', () => {
    const uv = add('test.uv');
    store().selectNodes([uv, outputId()]);

    store().removeNodes([uv, outputId()]);

    expect(graph().nodes.map((n) => n.id)).toEqual([outputId()]);
    expect(store().selectedNodeIds).toEqual([]);
  });
});

describe('node edits', () => {
  it('moves a node', () => {
    const uv = add('test.uv');

    store().moveNode(uv, { x: 33, y: 44 });

    expect(graph().nodes.find((n) => n.id === uv)?.position).toEqual({ x: 33, y: 44 });
  });

  it('sets a param value and reports an unknown param', () => {
    const noise = add('test.noise');

    store().setParam(noise, 'offset', [1, 2]);
    expect(
      graph().nodes.find((n) => n.id === noise)?.params.find((p) => p.id === 'offset')?.value,
    ).toEqual([1, 2]);

    store().setParam(noise, 'ghost', 1);
    expect(store().lastError).toMatch(/No param "ghost"/);
  });

  it('flips a param exposed flag without touching selection or value', () => {
    const noise = add('test.noise');
    store().selectNodes([noise]);

    store().setParamExposed(noise, 'octaves', true);

    const param = graph().nodes.find((n) => n.id === noise)?.params.find((p) => p.id === 'octaves');
    expect(param?.exposed).toBe(true);
    expect(param?.value).toBe(4);
    expect(store().selectedNodeIds).toEqual([noise]);
    expect(store().doc.meta.updated).not.toBe('');

    store().setParamExposed(noise, 'ghost', true);
    expect(store().lastError).toMatch(/No param "ghost"/);
  });
});

describe('layers', () => {
  it('gives every layer its own graph and edits only the active one', () => {
    const base = activeLayer(store().doc).id;
    add('test.uv');
    const second = store().addLayer('Crust');
    expect(second).not.toBeNull();

    add('test.noise');

    const layers = store().doc.layerStack.layers;
    const baseGraph = layers.find((l) => l.id === base)?.graph;
    const crustGraph = layers.find((l) => l.id === second)?.graph;

    expect(baseGraph?.nodes.map((n) => n.type)).toEqual(['output.surface', 'test.uv']);
    expect(crustGraph?.nodes.map((n) => n.type)).toEqual(['output.surface', 'test.noise']);
    expect(baseGraph?.outputNodeId).not.toBe(crustGraph?.outputNodeId);
  });

  it('switches the active layer and clears selection', () => {
    const base = activeLayer(store().doc).id;
    const uv = add('test.uv');
    store().selectNodes([uv]);
    const second = store().addLayer() as string;

    store().setActiveLayer(base);
    expect(activeLayer(store().doc).id).toBe(base);
    expect(store().selectedNodeIds).toEqual([]);

    store().setActiveLayer(second);
    expect(activeGraph(store().doc).nodes).toHaveLength(1);
  });

  it('edits layer properties without touching the graph', () => {
    const id = activeLayer(store().doc).id;
    const before = activeGraph(store().doc);

    store().setLayerProp(id, { name: 'Crust', opacity: 0.25, enabled: false, blend: 'multiply' });

    const layer = activeLayer(store().doc);
    expect(layer).toMatchObject({ name: 'Crust', opacity: 0.25, enabled: false, blend: 'multiply' });
    expect(layer.graph).toBe(before);
  });

  it('removes a layer but keeps at least one', () => {
    const base = activeLayer(store().doc).id;
    const second = store().addLayer('Crust') as string;

    store().removeLayer(second);
    expect(store().doc.layerStack.layers.map((l) => l.id)).toEqual([base]);
    expect(activeLayer(store().doc).id).toBe(base);

    store().removeLayer(base);
    expect(store().doc.layerStack.layers).toHaveLength(1);
    expect(store().lastError).toMatch(/at least one layer/);
  });

  it('reorders a layer one step and preserves selection', () => {
    const base = activeLayer(store().doc).id;
    const top = store().addLayer('Crust') as string;
    store().setActiveLayer(base);
    const uv = add('test.uv');
    store().selectNodes([uv]);

    store().reorderLayer(base, 'up');

    expect(store().doc.layerStack.layers.map((l) => l.id)).toEqual([top, base]);
    expect(store().selectedNodeIds).toEqual([uv]);
  });

  it('is a no-op at either end of the stack', () => {
    const base = activeLayer(store().doc).id;
    const top = store().addLayer('Crust') as string;
    const before = store().doc;

    store().reorderLayer(top, 'up');
    expect(store().doc).toBe(before);

    store().reorderLayer(base, 'down');
    expect(store().doc).toBe(before);
    expect(store().doc.layerStack.layers.map((l) => l.id)).toEqual([base, top]);
  });
});

describe('masks', () => {
  it('adds an empty mask graph and switches the canvas into editing it', () => {
    const layerId = activeLayer(store().doc).id;

    store().addMaskToLayer(layerId);

    const layer = activeLayer(store().doc);
    expect(layer.maskGraph?.nodes.map((n) => n.type)).toEqual(['output.mask']);
    expect(store().editingTarget).toEqual({ kind: 'mask', layerId });
    expect(activeGraph(store().doc)).toBe(layer.maskGraph);
  });

  it('routes graph mutations to the mask while editing it, leaving the main graph untouched', () => {
    const layerId = activeLayer(store().doc).id;
    const mainGraphBefore = activeLayer(store().doc).graph;

    store().addMaskToLayer(layerId);
    const maskNode = add('test.uv');

    const layer = activeLayer(store().doc);
    expect(layer.maskGraph?.nodes.map((n) => n.id)).toContain(maskNode);
    expect(layer.graph).toBe(mainGraphBefore);
  });

  it('exits back to the main graph and clears selection', () => {
    const layerId = activeLayer(store().doc).id;
    store().addMaskToLayer(layerId);
    store().selectNodes([add('test.uv')]);

    store().exitMaskEditing();

    expect(store().editingTarget).toEqual({ kind: 'layer' });
    expect(store().selectedNodeIds).toEqual([]);
    expect(activeGraph(store().doc)).toBe(activeLayer(store().doc).graph);
  });

  it('re-enters an existing mask via enterMaskEditing', () => {
    const layerId = activeLayer(store().doc).id;
    store().addMaskToLayer(layerId);
    store().exitMaskEditing();

    store().enterMaskEditing(layerId);

    expect(store().editingTarget).toEqual({ kind: 'mask', layerId });
  });

  it('refuses to enter mask editing for a layer with no mask yet', () => {
    const layerId = activeLayer(store().doc).id;

    store().enterMaskEditing(layerId);

    expect(store().editingTarget).toEqual({ kind: 'layer' });
    expect(store().lastError).toMatch(/no mask/);
  });

  it('removing the mask being edited falls back to the main graph', () => {
    const layerId = activeLayer(store().doc).id;
    store().addMaskToLayer(layerId);

    store().removeMaskFromLayer(layerId);

    expect(activeLayer(store().doc).maskGraph).toBeUndefined();
    expect(store().editingTarget).toEqual({ kind: 'layer' });
    expect(activeGraph(store().doc)).toBe(activeLayer(store().doc).graph);
  });

  it('switching the active layer exits mask editing', () => {
    const base = activeLayer(store().doc).id;
    const second = store().addLayer('Crust') as string;
    store().setActiveLayer(base);
    store().addMaskToLayer(base);

    store().setActiveLayer(second);

    expect(store().editingTarget).toEqual({ kind: 'layer' });
  });
});

describe('document lifecycle', () => {
  it('bumps meta.updated on every mutation', async () => {
    const { created, updated: before } = store().doc.meta;
    await new Promise((r) => setTimeout(r, 2));

    add('test.uv');

    expect(store().doc.meta.updated > before).toBe(true);
    expect(store().doc.meta.created).toBe(created);
  });

  it('round-trips the live document through JSON', () => {
    const noise = add('test.noise', 10, 20);
    store().connect({ node: noise, socket: 'value' }, { node: outputId(), socket: 'albedo' });
    store().addLayer('Crust');
    const doc = store().doc;

    const restored = deserialize(serialize(doc));

    expect(restored).toEqual(doc);

    store().loadDocument(restored);
    expect(store().doc).toEqual(doc);
    expect(store().selectedNodeIds).toEqual([]);
  });

  it('newDocument resets graph, selection, and error', () => {
    const uv = add('test.uv');
    store().selectNodes([uv]);
    store().addNode('test.nope', { x: 0, y: 0 });

    store().newDocument('Fresh');

    expect(store().doc.name).toBe('Fresh');
    expect(graph().nodes).toHaveLength(1);
    expect(store().selectedNodeIds).toEqual([]);
    expect(store().lastError).toBeNull();
  });

  it('renames the document, trims the name, and preserves selection', () => {
    const uv = add('test.uv');
    store().selectNodes([uv]);

    store().renameDocument('  Molten Rock  ');

    expect(store().doc.name).toBe('Molten Rock');
    expect(store().selectedNodeIds).toEqual([uv]);
  });

  it('renameDocument no-ops on an empty or unchanged name', () => {
    const before = store().doc;

    store().renameDocument('   ');
    expect(store().doc).toBe(before);

    store().renameDocument(before.name);
    expect(store().doc).toBe(before);
  });
});
