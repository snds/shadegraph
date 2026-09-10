// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — persistence tests
// ───────────────────────────────────────────────────────────────────────────
// The round-trip test below is the Phase 1 safety net: a document that has been
// saved and re-opened must be the SAME document, down to node positions and
// param values. It exercises the real save/load path the toolbar uses
// (`serialize` → text/localStorage → `parseDocumentText`), not a hand-rolled
// copy of it.
//
// Node environment: no DOM. Storage is injected, so nothing here needs
// `localStorage`.
// ═══════════════════════════════════════════════════════════════════════════

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  emptyDocument,
  type NodeParam,
  type ShaderDocument,
  type ShaderGraph,
  type ShaderLayer,
  type ShaderNode,
} from '../model/document';
import { emptyLayer } from '../model/factory';
import { makeEdgeId, makeNodeId } from '../model/ids';
import { serialize } from '../model/serialize';
import { registerStarterNodes } from '../nodes/definitions';
import { nodes } from '../nodes/registry';
import {
  AUTOSAVE_KEY,
  clearAutosave,
  createAutosaver,
  decodeAutosave,
  documentFileName,
  encodeAutosave,
  parseDocumentText,
  readAutosave,
  writeAutosave,
  type StorageLike,
} from './persistence';

registerStarterNodes();

// ── Fixtures ───────────────────────────────────────────────────────────────

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Instantiate a registry node type the way the store does, then apply the
 *  caller's param overrides — so the fixture carries REAL param shapes rather
 *  than invented ones. */
function makeNode(
  type: string,
  position: { x: number; y: number },
  overrides: Record<string, NodeParam['value']> = {},
  extra: Partial<ShaderNode> = {},
): ShaderNode {
  const def = nodes.get(type);
  if (!def) throw new Error(`Fixture wants an unregistered node type "${type}"`);
  const params = clone(def.params ?? []).map((p) =>
    p.id in overrides ? { ...p, value: overrides[p.id] } : p,
  );
  return {
    id: makeNodeId(type),
    type,
    position,
    params,
    previewEnabled: def.previewable ?? false,
    ...extra,
  };
}

function link(graph: ShaderGraph, from: [string, string], to: [string, string]) {
  const source = { node: from[0], socket: from[1] };
  const target = { node: to[0], socket: to[1] };
  graph.edges.push({ id: makeEdgeId(source, target), source, target });
}

/**
 * A deliberately non-trivial document: two layers, each with its own graph,
 * several nodes at non-default positions with non-default param values, edges,
 * an exposed/bound param, a group frame, a bypassed + collapsed node, a
 * document blackboard, and populated meta.
 */
function richDocument(): ShaderDocument {
  const doc = emptyDocument('Rocky Planet');

  // ── Layer 1: base — uv → fbm → ramp → output
  const base = doc.layerStack.layers[0] as ShaderLayer;
  const uv = makeNode('input.uv', { x: -320, y: 40 }, { tiling: [4, 4], offset: [0.25, -0.5] });
  const fbm = makeNode(
    'noise.fbm',
    { x: -60, y: 120 },
    { frequency: 7.5, octaves: 6, lacunarity: 2.31, gain: 0.42, seed: 1337 },
  );
  const ramp = makeNode(
    'color.ramp',
    { x: 220, y: 96 },
    { colorA: [0.12, 0.09, 0.07], colorB: [0.8, 0.72, 0.6], posA: 0.15, posB: 0.85 },
    { title: 'Crust tint', collapsed: true },
  );
  // The exposed/bound param: this is what the Legion lab-store export reads.
  fbm.params = fbm.params.map((p) =>
    p.id === 'frequency' ? { ...p, exposed: true, bindUniform: 'uTerrainFrequency' } : p,
  );

  base.graph.nodes.push(uv, fbm, ramp);
  link(base.graph, [uv.id, 'uv'], [fbm.id, 'uv']);
  link(base.graph, [fbm.id, 'value'], [ramp.id, 't']);
  link(base.graph, [ramp.id, 'color'], [base.graph.outputNodeId, 'baseColor']);
  base.graph.groups = [
    {
      id: 'grp_terrain',
      title: 'Terrain colour',
      color: '#3a5a40',
      bounds: { x: -360, y: -20, w: 700, h: 320 },
    },
  ];
  // Non-default output-node position, so a moved terminal node round-trips too.
  const outIndex = base.graph.nodes.findIndex((n) => n.id === base.graph.outputNodeId);
  base.graph.nodes[outIndex] = {
    ...base.graph.nodes[outIndex],
    position: { x: 512.5, y: 208.25 },
  };

  // ── Layer 2: an overlay with its own graph and a bypassed node
  const overlay = emptyLayer('Snow');
  const time = makeNode('input.time', { x: -280, y: 300 }, { speed: 0.05 });
  const mix = makeNode('math.mix', { x: 40, y: 260 }, {}, { bypassed: true });
  overlay.graph.nodes.push(time, mix);
  link(overlay.graph, [mix.id, 'result'], [overlay.graph.outputNodeId, 'baseColor']);
  overlay.blend = 'screen';
  overlay.opacity = 0.65;
  overlay.enabled = true;
  overlay.visible = false;
  overlay.soloed = true;

  doc.layerStack.layers.push(overlay);
  doc.layerStack.activeLayerId = overlay.id;

  doc.archetype = 'rocky';
  doc.previewRig = 'sphere';
  doc.blackboard.push(
    {
      id: 'uTerrainFrequency',
      label: 'Terrain frequency',
      type: 'float',
      value: 7.5,
      ui: 'slider',
      min: 0.1,
      max: 32,
      step: 0.1,
      exposed: true,
      bindUniform: 'uTerrainFrequency',
    },
    {
      id: 'uSnowLine',
      label: 'Snow line',
      type: 'float',
      value: 0.72,
      ui: 'slider',
      min: 0,
      max: 1,
      step: 0.001,
      exposed: true,
    },
  );
  doc.meta.author = 'sean';
  doc.meta.validatedTargets = ['glsl-es', 'wgsl'];
  return doc;
}

/** In-memory `Storage` slice, so autosave is testable without a DOM. */
function memoryStorage(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ── The round trip ─────────────────────────────────────────────────────────

describe('save → load round trip', () => {
  it('restores a two-layer document losslessly through the file path', () => {
    const doc = richDocument();

    const result = parseDocumentText(serialize(doc));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc).toEqual(doc);
    // `toEqual` ignores key order but not key presence; compare the text too so
    // a dropped optional field (soloed, groups, bindUniform…) cannot hide.
    expect(serialize(result.doc)).toBe(serialize(doc));
  });

  it('preserves node positions and param values exactly', () => {
    const doc = richDocument();

    const result = parseDocumentText(serialize(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const before = (doc.layerStack.layers[0] as ShaderLayer).graph;
    const after = (result.doc.layerStack.layers[0] as ShaderLayer).graph;

    expect(after.nodes.map((n) => n.position)).toEqual(before.nodes.map((n) => n.position));
    expect(after.nodes.find((n) => n.type === 'noise.fbm')?.params).toEqual(
      before.nodes.find((n) => n.type === 'noise.fbm')?.params,
    );
    // Spot-check the values themselves, not just that two copies agree.
    const fbm = after.nodes.find((n) => n.type === 'noise.fbm');
    expect(fbm?.position).toEqual({ x: -60, y: 120 });
    expect(fbm?.params.find((p) => p.id === 'frequency')).toMatchObject({
      value: 7.5,
      exposed: true,
      bindUniform: 'uTerrainFrequency',
    });
    expect(after.nodes.find((n) => n.type === 'input.uv')?.params.find((p) => p.id === 'tiling'))
      .toMatchObject({ value: [4, 4] });
  });

  it('preserves edges, groups, layer props and the blackboard', () => {
    const doc = richDocument();

    const result = parseDocumentText(serialize(doc));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [base, overlay] = result.doc.layerStack.layers as ShaderLayer[];
    expect(base.graph.edges).toEqual((doc.layerStack.layers[0] as ShaderLayer).graph.edges);
    expect(base.graph.groups).toEqual((doc.layerStack.layers[0] as ShaderLayer).graph.groups);
    expect(overlay).toMatchObject({
      name: 'Snow',
      blend: 'screen',
      opacity: 0.65,
      visible: false,
      soloed: true,
    });
    expect(overlay.graph.nodes.find((n) => n.type === 'math.mix')?.bypassed).toBe(true);
    expect(result.doc.layerStack.activeLayerId).toBe(doc.layerStack.activeLayerId);
    expect(result.doc.blackboard).toEqual(doc.blackboard);
    expect(result.doc.meta).toEqual(doc.meta);
  });

  it('survives repeated save/load cycles without drift', () => {
    const once = serialize(richDocument());
    const twice = parseDocumentText(once);
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    const thrice = parseDocumentText(serialize(twice.doc));
    expect(thrice.ok).toBe(true);
    if (!thrice.ok) return;

    expect(serialize(twice.doc)).toBe(once);
    expect(serialize(thrice.doc)).toBe(once);
  });

  it('round-trips losslessly through the autosave envelope too', () => {
    const doc = richDocument();

    const restored = decodeAutosave(encodeAutosave(doc, '2026-09-05T14:39:13.000Z'));

    expect(restored?.ok).toBe(true);
    if (!restored?.ok) return;
    expect(restored.doc).toEqual(doc);
    expect(serialize(restored.doc)).toBe(serialize(doc));
    expect(restored.savedAt).toBe('2026-09-05T14:39:13.000Z');
  });
});

// ── Rejection: a bad payload never becomes a document ──────────────────────

describe('parseDocumentText', () => {
  it('reports malformed JSON instead of throwing', () => {
    expect(parseDocumentText('{ not json')).toEqual({
      ok: false,
      message: expect.stringContaining('Not valid JSON'),
    });
  });

  it('rejects JSON that is not a ShadeGraph document', () => {
    const result = parseDocumentText('{"hello":"world"}');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/schema version/i);
  });

  it('rejects a document from another schema version', () => {
    const doc = { ...emptyDocument(), schemaVersion: '9.9.9' };

    const result = parseDocumentText(JSON.stringify(doc));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('9.9.9');
  });

  it('rejects a document whose layers were emptied', () => {
    const doc = emptyDocument();
    doc.layerStack.layers = [];

    const result = parseDocumentText(JSON.stringify(doc));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/non-empty array/);
  });
});

// ── Filenames ──────────────────────────────────────────────────────────────

describe('documentFileName', () => {
  it('appends the ShadeGraph suffix', () => {
    expect(documentFileName('Rocky')).toBe('Rocky.shadegraph.json');
  });

  it('collapses characters a filesystem would reject', () => {
    expect(documentFileName('Rocky Planet / v2')).toBe('Rocky-Planet-v2.shadegraph.json');
    expect(documentFileName('  spaced  out  ')).toBe('spaced-out.shadegraph.json');
  });

  it('falls back to "untitled" for an unusable name', () => {
    expect(documentFileName('')).toBe('untitled.shadegraph.json');
    expect(documentFileName('///')).toBe('untitled.shadegraph.json');
  });
});

// ── Autosave slot ──────────────────────────────────────────────────────────

describe('autosave storage', () => {
  it('writes, reads back and clears the autosave slot', () => {
    const storage = memoryStorage();
    const doc = richDocument();

    expect(writeAutosave(doc, storage)).toBe(true);
    expect(storage.map.has(AUTOSAVE_KEY)).toBe(true);

    const restored = readAutosave(storage);
    expect(restored?.ok).toBe(true);
    if (!restored?.ok) return;
    expect(restored.doc).toEqual(doc);

    clearAutosave(storage);
    expect(readAutosave(storage)).toBeNull();
  });

  it('treats an empty slot as "nothing to restore"', () => {
    expect(readAutosave(memoryStorage())).toBeNull();
    expect(decodeAutosave(null)).toBeNull();
    expect(decodeAutosave('')).toBeNull();
  });

  it('reports a corrupt slot rather than returning a half document', () => {
    const garbage = readAutosave(memoryStorage({ [AUTOSAVE_KEY]: 'not json at all' }));
    expect(garbage).toEqual({ ok: false, message: expect.stringContaining('not valid JSON') });

    const wrongShape = readAutosave(memoryStorage({ [AUTOSAVE_KEY]: '{"doc":42}' }));
    expect(wrongShape).toEqual({ ok: false, message: expect.stringContaining('recognised format') });

    const badDoc = readAutosave(
      memoryStorage({ [AUTOSAVE_KEY]: JSON.stringify({ savedAt: 'x', doc: '{"nope":1}' }) }),
    );
    expect(badDoc?.ok).toBe(false);
  });

  it('survives storage that refuses to write (private mode, quota)', () => {
    const hostile: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
    };

    expect(writeAutosave(richDocument(), hostile)).toBe(false);
    expect(() => clearAutosave(hostile)).not.toThrow();
  });

  it('is a no-op when there is no storage at all', () => {
    expect(writeAutosave(richDocument(), null)).toBe(false);
    expect(readAutosave(null)).toBeNull();
    expect(() => clearAutosave(null)).not.toThrow();
  });
});

describe('createAutosaver', () => {
  it('coalesces a burst of edits into a single write of the latest document', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const autosaver = createAutosaver({ storage, delayMs: 500 });

    const first = richDocument();
    const last = { ...first, name: 'Latest' };
    autosaver.schedule(first);
    vi.advanceTimersByTime(400);
    autosaver.schedule(last);
    expect(setItem).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);

    expect(setItem).toHaveBeenCalledTimes(1);
    const restored = readAutosave(storage);
    expect(restored?.ok && restored.doc.name).toBe('Latest');
  });

  it('flushes on demand and drops nothing on a second flush', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const autosaver = createAutosaver({ storage, delayMs: 500 });

    autosaver.schedule(richDocument());
    autosaver.flush();
    autosaver.flush();
    vi.advanceTimersByTime(1000);

    expect(setItem).toHaveBeenCalledTimes(1);
  });

  it('cancel forgets the pending document', () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const autosaver = createAutosaver({ storage, delayMs: 500 });

    autosaver.schedule(richDocument());
    autosaver.cancel();
    vi.advanceTimersByTime(1000);

    expect(readAutosave(storage)).toBeNull();
  });
});
