import { describe, expect, it, vi } from 'vitest';

import { emptyDocument, type LayerGroup, type ShaderDocument, type ShaderGraph, type ShaderLayer } from '../model/document';
import type { CompileOptions, CompiledProgram, TargetLang } from '../compiler/backend';
import {
  diffChangedNodeIds,
  downstreamClosure,
  snapThumbnailSize,
  ThumbnailScheduler,
  type ThumbnailGpu,
} from './thumbnails';

/** Every fixture document here is a bare `emptyDocument()` (or one with a
 *  plain leaf layer pushed) with no groups — its top-level stack nodes are
 *  always leaves. */
function layer0(doc: ShaderDocument): ShaderLayer {
  return doc.layerStack.layers[0] as ShaderLayer;
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function chainGraph(): ShaderGraph {
  return {
    nodes: [
      { id: 'a', type: 'math.add', position: { x: 0, y: 0 }, params: [] },
      { id: 'b', type: 'math.add', position: { x: 0, y: 0 }, params: [] },
      { id: 'c', type: 'math.add', position: { x: 0, y: 0 }, params: [] },
      { id: 'lonely', type: 'math.add', position: { x: 0, y: 0 }, params: [] },
    ],
    edges: [
      { id: 'e1', source: { node: 'a', socket: 'out' }, target: { node: 'b', socket: 'a' } },
      { id: 'e2', source: { node: 'b', socket: 'out' }, target: { node: 'c', socket: 'a' } },
    ],
    outputNodeId: 'c',
  };
}

describe('snapThumbnailSize', () => {
  it('snaps up to the nearest pooled bucket', () => {
    expect(snapThumbnailSize(1)).toBe(64);
    expect(snapThumbnailSize(64)).toBe(64);
    expect(snapThumbnailSize(65)).toBe(128);
    expect(snapThumbnailSize(200)).toBe(256);
    expect(snapThumbnailSize(9999)).toBe(256);
    expect(snapThumbnailSize(undefined)).toBe(128);
  });
});

describe('downstreamClosure', () => {
  it('includes the node itself plus everything reachable forward through edges', () => {
    expect(downstreamClosure(chainGraph(), 'a')).toEqual(new Set(['a', 'b', 'c']));
    expect(downstreamClosure(chainGraph(), 'b')).toEqual(new Set(['b', 'c']));
    expect(downstreamClosure(chainGraph(), 'c')).toEqual(new Set(['c']));
  });

  it('a node with no outgoing edges closes over just itself', () => {
    expect(downstreamClosure(chainGraph(), 'lonely')).toEqual(new Set(['lonely']));
  });
});

function docWithChain(): ShaderDocument {
  const doc = emptyDocument('Diff fixture');
  layer0(doc).graph = chainGraph();
  return doc;
}

function clone(doc: ShaderDocument): ShaderDocument {
  return JSON.parse(JSON.stringify(doc)) as ShaderDocument;
}

describe('diffChangedNodeIds', () => {
  it('with no previous doc, every node counts as changed', () => {
    const doc = docWithChain();
    const changed = diffChangedNodeIds(null, doc);
    expect(changed).toEqual(new Set(['a', 'b', 'c', 'lonely']));
  });

  it('an unrelated document re-set with identical content changes nothing', () => {
    const doc = docWithChain();
    expect(diffChangedNodeIds(doc, clone(doc))).toEqual(new Set());
  });

  it('a param edit on one node only reports that node (caller expands downstream separately)', () => {
    const doc = docWithChain();
    layer0(doc).graph.nodes[0].params = [
      { id: 'x', label: 'X', type: 'float', value: 1, ui: 'slider' },
    ];
    const edited = clone(doc);
    (layer0(edited).graph.nodes[0].params[0].value as number) = 2;
    expect(diffChangedNodeIds(doc, edited)).toEqual(new Set(['a']));
  });

  it('a bypass toggle reports that node', () => {
    const doc = docWithChain();
    const edited = clone(doc);
    layer0(edited).graph.nodes[1].bypassed = true;
    expect(diffChangedNodeIds(doc, edited)).toEqual(new Set(['b']));
  });

  it('adding a node reports only the new node', () => {
    const doc = docWithChain();
    const edited = clone(doc);
    layer0(edited).graph.nodes.push({
      id: 'd',
      type: 'math.add',
      position: { x: 0, y: 0 },
      params: [],
    });
    expect(diffChangedNodeIds(doc, edited)).toEqual(new Set(['d']));
  });

  it('adding/removing an edge reports both endpoints', () => {
    const doc = docWithChain();
    const edited = clone(doc);
    layer0(edited).graph.edges.push({
      id: 'e3',
      source: { node: 'lonely', socket: 'out' },
      target: { node: 'c', socket: 'b' },
    });
    expect(diffChangedNodeIds(doc, edited)).toEqual(new Set(['lonely', 'c']));

    expect(diffChangedNodeIds(edited, doc)).toEqual(new Set(['lonely', 'c']));
  });

  it('a layer-opacity-only edit changes nothing (a soloed node bypasses compositing)', () => {
    const doc = docWithChain();
    const edited = clone(doc);
    edited.layerStack.layers[0].opacity = 0.3;
    expect(diffChangedNodeIds(doc, edited)).toEqual(new Set());
  });

  it('a brand-new layer reports all of its nodes', () => {
    const doc = docWithChain();
    const edited = clone(doc);
    edited.layerStack.layers.push({
      kind: 'layer',
      id: 'layer2',
      name: 'New layer',
      graph: { nodes: [{ id: 'z', type: 'math.add', position: { x: 0, y: 0 }, params: [] }], edges: [], outputNodeId: 'z' },
      blend: 'normal',
      opacity: 1,
      enabled: true,
      visible: true,
    });
    expect(diffChangedNodeIds(doc, edited)).toEqual(new Set(['z']));
  });
});

// ── ThumbnailScheduler orchestration (fake GPU, no THREE/DOM) ───────────────

function fakeGpu(): ThumbnailGpu & { renderCount: number } {
  const gpu = {
    renderCount: 0,
    renderInto() {
      gpu.renderCount++;
    },
    dispose() {},
  };
  return gpu;
}

/** A synchronous "frame": the callback runs immediately, so tests don't need
 *  real timers to drive the tick loop. */
function syncScheduleFrame(cb: () => void): number {
  cb();
  return 0;
}

function fakeCanvas(): HTMLCanvasElement {
  return { width: 0, height: 0 } as unknown as HTMLCanvasElement;
}

function okProgram(): CompiledProgram {
  return { target: 'glsl-es', vertex: '', fragment: '', uniforms: [], diagnostics: [] };
}

function schedulerWithGraph() {
  const gpu = fakeGpu();
  const compile = vi.fn((): CompiledProgram => okProgram());
  const scheduler = new ThumbnailScheduler(gpu, {
    compile,
    createCanvas: fakeCanvas,
    scheduleFrame: syncScheduleFrame,
    cancelFrame: () => {},
    now: () => 0,
  });
  const doc = docWithChain();
  scheduler.onDocument(doc, 'glsl-es', diffChangedNodeIds(null, doc));
  return { gpu, compile, scheduler, doc };
}

/** A document whose single top-level `LayerGroup` ("grp1") folds two leaf
 *  layers ("base", "overlay") — the fixture the stack-node thumbnail tests
 *  below use to exercise ancestor-propagation (a change inside "base" must
 *  also dirty "grp1"'s own thumbnail) and structural-signature diffing (an
 *  opacity/blend/enabled/soloed edit that no `changedNodeIds` entry would
 *  ever capture). */
function docWithGroup(): { doc: ShaderDocument; groupId: string; baseId: string; overlayId: string } {
  const doc = emptyDocument('Group fixture');
  const base = layer0(doc);
  base.id = 'base';
  base.graph = chainGraph();
  const overlay: ShaderLayer = JSON.parse(JSON.stringify(base));
  overlay.id = 'overlay';
  const group: LayerGroup = {
    kind: 'group',
    id: 'grp1',
    name: 'Group',
    blend: 'normal',
    opacity: 1,
    enabled: true,
    visible: true,
    children: [base, overlay],
  };
  doc.layerStack.layers = [group];
  return { doc, groupId: 'grp1', baseId: 'base', overlayId: 'overlay' };
}

function schedulerWithGroup() {
  const gpu = fakeGpu();
  const compile = vi.fn((): CompiledProgram => okProgram());
  const compileDocument = vi.fn(
    (_doc: ShaderDocument, _target: TargetLang, _opts: CompileOptions): CompiledProgram => okProgram(),
  );
  const scheduler = new ThumbnailScheduler(gpu, {
    compile,
    compileDocument,
    createCanvas: fakeCanvas,
    scheduleFrame: syncScheduleFrame,
    cancelFrame: () => {},
    now: () => 0,
  });
  const { doc, groupId, baseId, overlayId } = docWithGroup();
  scheduler.onDocument(doc, 'glsl-es', diffChangedNodeIds(null, doc));
  return { gpu, compile, compileDocument, scheduler, doc, groupId, baseId, overlayId };
}

describe('ThumbnailScheduler — stack-node (Layers panel) thumbnails', () => {
  it('never renders a stack node that has not been marked visible', async () => {
    const { compileDocument, scheduler, groupId } = schedulerWithGroup();
    const pending = scheduler.requestStack({ id: groupId });
    expect(compileDocument).not.toHaveBeenCalled();
    scheduler.setVisibleStackNodes([groupId]);
    await expect(pending).resolves.toBeDefined();
    expect(compileDocument).toHaveBeenCalledTimes(1);
    expect(compileDocument.mock.calls[0][2]).toMatchObject({ previewLayerId: groupId });
  });

  it('a second requestStack for a clean node resolves without re-rendering', async () => {
    const { compileDocument, scheduler, groupId } = schedulerWithGroup();
    scheduler.setVisibleStackNodes([groupId]);
    await scheduler.requestStack({ id: groupId });
    expect(compileDocument).toHaveBeenCalledTimes(1);

    await scheduler.requestStack({ id: groupId });
    expect(compileDocument).toHaveBeenCalledTimes(1);
  });

  it('a node edit inside a leaf dirties that leaf AND its ancestor group, never an unrelated sibling leaf', async () => {
    const { scheduler, compileDocument, doc, groupId, baseId, overlayId } = schedulerWithGroup();
    scheduler.setVisibleStackNodes([groupId, baseId, overlayId]);
    await Promise.all([
      scheduler.requestStack({ id: groupId }),
      scheduler.requestStack({ id: baseId }),
      scheduler.requestStack({ id: overlayId }),
    ]);
    compileDocument.mockClear();

    const edited = clone(doc);
    const group = edited.layerStack.layers[0] as LayerGroup;
    (group.children[0] as ShaderLayer).graph.nodes[1].bypassed = true; // node "b", inside "base"
    scheduler.onDocument(edited, 'glsl-es', diffChangedNodeIds(doc, edited));

    await Promise.all([scheduler.requestStack({ id: baseId }), scheduler.requestStack({ id: groupId })]);
    expect(compileDocument).toHaveBeenCalledTimes(2);

    await scheduler.requestStack({ id: overlayId });
    expect(compileDocument).toHaveBeenCalledTimes(2);
  });

  it('a structural edit (opacity) dirties the changed node and its ancestor, even with an empty changedNodeIds', async () => {
    const { scheduler, compileDocument, doc, groupId, baseId, overlayId } = schedulerWithGroup();
    scheduler.setVisibleStackNodes([groupId, baseId, overlayId]);
    await Promise.all([
      scheduler.requestStack({ id: groupId }),
      scheduler.requestStack({ id: baseId }),
      scheduler.requestStack({ id: overlayId }),
    ]);
    compileDocument.mockClear();

    const edited = clone(doc);
    const group = edited.layerStack.layers[0] as LayerGroup;
    (group.children[1] as ShaderLayer).opacity = 0.4; // "overlay" — no node/edge change at all
    const changed = diffChangedNodeIds(doc, edited);
    expect(changed).toEqual(new Set());
    scheduler.onDocument(edited, 'glsl-es', changed);

    await Promise.all([scheduler.requestStack({ id: overlayId }), scheduler.requestStack({ id: groupId })]);
    expect(compileDocument).toHaveBeenCalledTimes(2);

    await scheduler.requestStack({ id: baseId });
    expect(compileDocument).toHaveBeenCalledTimes(2);
  });

  it('a stack node removed from the document rejects any still-pending waiters', async () => {
    const { scheduler, doc, overlayId } = schedulerWithGroup();
    // Never made visible, so the request never resolves on its own.
    const pending = scheduler.requestStack({ id: overlayId });

    const edited = clone(doc);
    const group = edited.layerStack.layers[0] as LayerGroup;
    group.children = group.children.filter((c) => c.id !== overlayId);
    scheduler.onDocument(edited, 'glsl-es', new Set());

    await expect(pending).rejects.toThrow();
  });

  it('dispose rejects any pending stack waiters', async () => {
    const { scheduler, overlayId } = schedulerWithGroup();
    const pending = scheduler.requestStack({ id: overlayId });
    scheduler.dispose();
    await expect(pending).rejects.toThrow();
  });
});

describe('ThumbnailScheduler', () => {
  it('never renders a node that has not been marked visible', async () => {
    const { compile, scheduler } = schedulerWithGraph();
    // No setVisibleNodes call at all — request() should register interest but
    // the synchronous "frame" loop must not fire because nothing is visible.
    const pending = scheduler.request({ nodeId: 'a' });
    expect(compile).not.toHaveBeenCalled();
    // Now make it visible: the same pending promise resolves.
    scheduler.setVisibleNodes(['a']);
    await expect(pending).resolves.toBeDefined();
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('a second request for a clean (non-dirty) node resolves without re-rendering', async () => {
    const { compile, scheduler } = schedulerWithGraph();
    scheduler.setVisibleNodes(['a']);
    await scheduler.request({ nodeId: 'a' });
    expect(compile).toHaveBeenCalledTimes(1);

    await scheduler.request({ nodeId: 'a' });
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it('markDirty on an upstream node re-dirties its downstream subtree, not unrelated nodes', async () => {
    const { compile, scheduler } = schedulerWithGraph();
    scheduler.setVisibleNodes(['a', 'b', 'c', 'lonely']);
    await Promise.all([
      scheduler.request({ nodeId: 'a' }),
      scheduler.request({ nodeId: 'b' }),
      scheduler.request({ nodeId: 'c' }),
      scheduler.request({ nodeId: 'lonely' }),
    ]);
    expect(compile).toHaveBeenCalledTimes(4);

    scheduler.markDirty('a');
    await Promise.all([scheduler.request({ nodeId: 'a' }), scheduler.request({ nodeId: 'b' }), scheduler.request({ nodeId: 'c' })]);
    // a, b, c are downstream of a (inclusive); "lonely" must NOT re-render.
    expect(compile).toHaveBeenCalledTimes(4 + 3);

    await scheduler.request({ nodeId: 'lonely' });
    expect(compile).toHaveBeenCalledTimes(4 + 3);
  });

  it('a doc edit only re-renders the changed node + its downstream subtree', async () => {
    const { compile, scheduler, doc } = schedulerWithGraph();
    scheduler.setVisibleNodes(['a', 'b', 'c', 'lonely']);
    await Promise.all([
      scheduler.request({ nodeId: 'a' }),
      scheduler.request({ nodeId: 'b' }),
      scheduler.request({ nodeId: 'c' }),
      scheduler.request({ nodeId: 'lonely' }),
    ]);
    compile.mockClear();

    const edited = clone(doc);
    layer0(edited).graph.nodes[1].bypassed = true; // node "b"
    scheduler.onDocument(edited, 'glsl-es', diffChangedNodeIds(doc, edited));

    await Promise.all([scheduler.request({ nodeId: 'b' }), scheduler.request({ nodeId: 'c' })]);
    expect(compile).toHaveBeenCalledTimes(2);

    await scheduler.request({ nodeId: 'a' });
    await scheduler.request({ nodeId: 'lonely' });
    expect(compile).toHaveBeenCalledTimes(2);
  });

  it('setThumbnailBudget caps how many nodes render within a single tick', async () => {
    const gpu = fakeGpu();
    const compile = vi.fn((): CompiledProgram => okProgram());
    let frameCount = 0;
    let elapsed = 0;
    const scheduler = new ThumbnailScheduler(gpu, {
      compile,
      createCanvas: fakeCanvas,
      // Every scheduled frame runs synchronously, but we count how many
      // separate frames it took to drain the queue.
      scheduleFrame: (cb) => {
        frameCount++;
        cb();
        return frameCount;
      },
      cancelFrame: () => {},
      // Each render call "costs" 5ms of budget; a budget of 5ms allows
      // exactly one render before a tick bails out and reschedules.
      now: () => {
        const t = elapsed;
        elapsed += 5;
        return t;
      },
    });
    scheduler.setBudget(5);
    const doc = docWithChain();
    scheduler.onDocument(doc, 'glsl-es', diffChangedNodeIds(null, doc));
    scheduler.setVisibleNodes(['a', 'b', 'c', 'lonely']);

    await Promise.all([
      scheduler.request({ nodeId: 'a' }),
      scheduler.request({ nodeId: 'b' }),
      scheduler.request({ nodeId: 'c' }),
      scheduler.request({ nodeId: 'lonely' }),
    ]);

    expect(compile).toHaveBeenCalledTimes(4);
    // With a 5ms budget and each render costing 5ms, the work must have been
    // spread across multiple frames rather than done all in one.
    expect(frameCount).toBeGreaterThan(1);
  });

  it('a node removed from the document rejects any still-pending waiters', async () => {
    const { scheduler, doc } = schedulerWithGraph();
    // Never make it visible, so the request never resolves on its own.
    const pending = scheduler.request({ nodeId: 'a' });

    const edited = clone(doc);
    layer0(edited).graph.nodes = layer0(edited).graph.nodes.filter((n) => n.id !== 'a');
    layer0(edited).graph.edges = layer0(edited).graph.edges.filter(
      (e) => e.source.node !== 'a' && e.target.node !== 'a',
    );
    scheduler.onDocument(edited, 'glsl-es', new Set());

    await expect(pending).rejects.toThrow();
  });

  it('a compile error resolves with the last-good frame instead of hanging forever', async () => {
    const gpu = fakeGpu();
    let broken = false;
    const compile = vi.fn(
      (): CompiledProgram =>
        broken
          ? { target: 'glsl-es', uniforms: [], diagnostics: [{ level: 'error', message: 'bad graph' }] }
          : okProgram(),
    );
    const scheduler = new ThumbnailScheduler(gpu, {
      compile,
      createCanvas: fakeCanvas,
      scheduleFrame: syncScheduleFrame,
      cancelFrame: () => {},
      now: () => 0,
    });
    const doc = docWithChain();
    scheduler.onDocument(doc, 'glsl-es', diffChangedNodeIds(null, doc));
    scheduler.setVisibleNodes(['a']);

    const firstCanvas = await scheduler.request({ nodeId: 'a' });
    expect(firstCanvas).toBeDefined();

    broken = true;
    scheduler.markDirty('a');
    const secondCanvas = await scheduler.request({ nodeId: 'a' });
    expect(secondCanvas).toBe(firstCanvas);
  });
});

// ── ThumbnailScheduler — asset (Assets-panel auto-graph) thumbnails ─────────
// A THIRD, disjoint tracker: entries here carry their OWN throwaway document
// per key rather than sharing `this.doc` (never set via `onDocument` at
// all) — these tests never call `onDocument`, proving the asset tracker
// works completely independently of whatever the main/Layers-panel trackers
// are doing.

function assetSchedulerFixture() {
  const gpu = fakeGpu();
  const compileDocument = vi.fn((): CompiledProgram => okProgram());
  const scheduler = new ThumbnailScheduler(gpu, {
    compileDocument,
    createCanvas: fakeCanvas,
    scheduleFrame: syncScheduleFrame,
    cancelFrame: () => {},
    now: () => 0,
  });
  return { gpu, compileDocument, scheduler };
}

describe('ThumbnailScheduler — asset (Assets-panel) thumbnails', () => {
  it('never renders an asset that has not been marked visible', async () => {
    const { compileDocument, scheduler } = assetSchedulerFixture();
    const pending = scheduler.requestAsset({ key: 'root1::a', doc: docWithChain(), signature: 'sig1' });
    expect(compileDocument).not.toHaveBeenCalled();
    scheduler.setVisibleAssetThumbnails(['root1::a']);
    await expect(pending).resolves.toBeDefined();
    expect(compileDocument).toHaveBeenCalledTimes(1);
  });

  it('a second request with the SAME signature resolves without re-rendering', async () => {
    const { compileDocument, scheduler } = assetSchedulerFixture();
    scheduler.setVisibleAssetThumbnails(['root1::a']);
    await scheduler.requestAsset({ key: 'root1::a', doc: docWithChain(), signature: 'sig1' });
    expect(compileDocument).toHaveBeenCalledTimes(1);

    // A brand-new (but equivalent) document object, same signature — the
    // whole point of a content-signature cache key: no re-render.
    await scheduler.requestAsset({ key: 'root1::a', doc: docWithChain(), signature: 'sig1' });
    expect(compileDocument).toHaveBeenCalledTimes(1);
  });

  it('a request with a DIFFERENT signature for the same key re-renders (the file changed)', async () => {
    const { compileDocument, scheduler } = assetSchedulerFixture();
    scheduler.setVisibleAssetThumbnails(['root1::a']);
    await scheduler.requestAsset({ key: 'root1::a', doc: docWithChain(), signature: 'sig1' });
    expect(compileDocument).toHaveBeenCalledTimes(1);

    await scheduler.requestAsset({ key: 'root1::a', doc: docWithChain(), signature: 'sig2' });
    expect(compileDocument).toHaveBeenCalledTimes(2);
  });

  it('two different keys never collide, even with the same signature', async () => {
    const { compileDocument, scheduler } = assetSchedulerFixture();
    scheduler.setVisibleAssetThumbnails(['root1::a', 'root2::a']);
    await Promise.all([
      scheduler.requestAsset({ key: 'root1::a', doc: docWithChain(), signature: 'same' }),
      scheduler.requestAsset({ key: 'root2::a', doc: docWithChain(), signature: 'same' }),
    ]);
    expect(compileDocument).toHaveBeenCalledTimes(2);
  });

  it('releaseAsset drops the cached entry, rejecting any still-pending waiter', async () => {
    const { scheduler } = assetSchedulerFixture();
    // Never made visible, so the request never resolves on its own.
    const pending = scheduler.requestAsset({ key: 'root1::a', doc: docWithChain(), signature: 'sig1' });
    scheduler.releaseAsset('root1::a');
    await expect(pending).rejects.toThrow();
  });

  it('releasing a key that was never requested is a harmless no-op', () => {
    const { scheduler } = assetSchedulerFixture();
    expect(() => scheduler.releaseAsset('never-requested')).not.toThrow();
  });

  it('markAllDirty re-renders every already-rendered asset entry', async () => {
    const { compileDocument, scheduler } = assetSchedulerFixture();
    scheduler.setVisibleAssetThumbnails(['root1::a']);
    await scheduler.requestAsset({ key: 'root1::a', doc: docWithChain(), signature: 'sig1' });
    expect(compileDocument).toHaveBeenCalledTimes(1);

    scheduler.markAllDirty();
    await scheduler.requestAsset({ key: 'root1::a', doc: docWithChain(), signature: 'sig1' });
    expect(compileDocument).toHaveBeenCalledTimes(2);
  });

  it('dispose rejects any pending asset waiters', async () => {
    const { scheduler } = assetSchedulerFixture();
    const pending = scheduler.requestAsset({ key: 'root1::a', doc: docWithChain(), signature: 'sig1' });
    scheduler.dispose();
    await expect(pending).rejects.toThrow();
  });

  it('an asset render never touches the per-node/per-stack trackers (fully independent, no onDocument call)', async () => {
    const { compileDocument, scheduler } = assetSchedulerFixture();
    scheduler.setVisibleAssetThumbnails(['root1::a']);
    // No onDocument() call anywhere in this test — the asset tracker must
    // still work with no "current document" set at all.
    const canvas = await scheduler.requestAsset({ key: 'root1::a', doc: docWithChain(), signature: 'sig1' });
    expect(canvas).toBeDefined();
    expect(compileDocument).toHaveBeenCalledTimes(1);
  });
});
