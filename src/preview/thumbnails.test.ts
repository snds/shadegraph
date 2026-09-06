import { describe, expect, it, vi } from 'vitest';

import { emptyDocument, type ShaderDocument, type ShaderGraph } from '../model/document';
import type { CompiledProgram } from '../compiler/backend';
import {
  diffChangedNodeIds,
  downstreamClosure,
  snapThumbnailSize,
  ThumbnailScheduler,
  type ThumbnailGpu,
} from './thumbnails';

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
  doc.layerStack.layers[0].graph = chainGraph();
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
    doc.layerStack.layers[0].graph.nodes[0].params = [
      { id: 'x', label: 'X', type: 'float', value: 1, ui: 'slider' },
    ];
    const edited = clone(doc);
    (edited.layerStack.layers[0].graph.nodes[0].params[0].value as number) = 2;
    expect(diffChangedNodeIds(doc, edited)).toEqual(new Set(['a']));
  });

  it('a bypass toggle reports that node', () => {
    const doc = docWithChain();
    const edited = clone(doc);
    edited.layerStack.layers[0].graph.nodes[1].bypassed = true;
    expect(diffChangedNodeIds(doc, edited)).toEqual(new Set(['b']));
  });

  it('adding a node reports only the new node', () => {
    const doc = docWithChain();
    const edited = clone(doc);
    edited.layerStack.layers[0].graph.nodes.push({
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
    edited.layerStack.layers[0].graph.edges.push({
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
    edited.layerStack.layers[0].graph.nodes[1].bypassed = true; // node "b"
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
    edited.layerStack.layers[0].graph.nodes = edited.layerStack.layers[0].graph.nodes.filter((n) => n.id !== 'a');
    edited.layerStack.layers[0].graph.edges = edited.layerStack.layers[0].graph.edges.filter(
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
