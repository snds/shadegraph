// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Per-node thumbnail scheduler
// ───────────────────────────────────────────────────────────────────────────
// The thumbnail half of `PreviewRenderer` (see `renderer.ts`'s header): kept
// in its own file/class — a *sibling*, composed into `PreviewRenderer` rather
// than folded in — so its dirty/visible/budget bookkeeping is unit-testable
// with a fake `ThumbnailGpu`, exactly the same split `PreviewRenderer` itself
// uses for `GpuBinding`.
//
// Fidelity: a thumbnail is `backend.compileGraph(layerGraph, { previewNodeId
// })` — the SAME per-layer compile path the model/compiler already define for
// "solo this node" — never a second, fake rendering path. `createThumbnailGpu`
// renders it through the SAME `THREE.WebGLRenderer` instance the main viewer
// binds to (see `createPreviewRenderer` in `renderer.ts`), redirected to a
// pooled offscreen `THREE.WebGLRenderTarget` via `setRenderTarget` — never a
// second WebGL context.
//
// Scale: only nodes that are both DIRTY (their own or an upstream node's
// output changed) and VISIBLE (reported via `setVisibleNodes`) are ever
// re-rendered, and `setThumbnailBudget` caps how much of that work happens in
// a single animation frame so a large graph's thumbnails never starve the
// main viewer.
// ═══════════════════════════════════════════════════════════════════════════

import * as THREE from 'three';

import type {
  CompileOptions,
  CompiledProgram,
  TargetLang,
} from '../compiler/backend';
import { backends } from '../compiler/backend';
import type { ScalarOrVector, ShaderDocument, ShaderGraph, ShaderLayer } from '../model/document';
import type { ThumbnailRequest } from './scheduler';
import { toThreeUniformValue } from './renderer';

// ── Pure helpers (no GPU, no DOM — directly unit-testable) ─────────────────

const POOL_SIZES = [64, 128, 256] as const;

/** Snaps a requested thumbnail size up to the nearest pooled render-target
 *  bucket, so the pool never grows one target per distinct size requested. */
export function snapThumbnailSize(requested: number | undefined): number {
  const want = requested ?? 96;
  for (const size of POOL_SIZES) if (want <= size) return size;
  return POOL_SIZES[POOL_SIZES.length - 1];
}

function findLayerContaining(doc: ShaderDocument, nodeId: string): ShaderLayer | undefined {
  return doc.layerStack.layers.find((l) => l.graph.nodes.some((n) => n.id === nodeId));
}

function allNodeIds(doc: ShaderDocument): Set<string> {
  const ids = new Set<string>();
  for (const layer of doc.layerStack.layers) {
    for (const node of layer.graph.nodes) ids.add(node.id);
  }
  return ids;
}

/** `nodeId` plus every node reachable by following edges forward from it
 *  within `graph` — a param/topology change on a node can only ever change
 *  what nodes DOWNSTREAM of it render, never upstream siblings. */
export function downstreamClosure(graph: ShaderGraph, nodeId: string): Set<string> {
  const forward = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = forward.get(edge.source.node);
    if (list) list.push(edge.target.node);
    else forward.set(edge.source.node, [edge.target.node]);
  }
  const seen = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of forward.get(current) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Every node id whose OWN emitted output could differ between `prev` and
 *  `next`: newly added nodes, nodes whose params/bypass changed, and both
 *  endpoints of any edge that was added or removed (an edge change alters
 *  what each endpoint sees as its connected input/output, even though
 *  neither node's own fields changed). Deliberately excludes layer opacity —
 *  a soloed node's thumbnail bypasses compositing entirely, so opacity can
 *  never affect it. Callers still need to expand each id through
 *  `downstreamClosure` themselves (this only finds the ROOT of a change). */
export function diffChangedNodeIds(prev: ShaderDocument | null, next: ShaderDocument): Set<string> {
  const changed = new Set<string>();
  if (!prev) {
    for (const layer of next.layerStack.layers) {
      for (const node of layer.graph.nodes) changed.add(node.id);
    }
    return changed;
  }

  for (const layer of next.layerStack.layers) {
    const prevLayer = prev.layerStack.layers.find((l) => l.id === layer.id);
    if (!prevLayer) {
      for (const node of layer.graph.nodes) changed.add(node.id);
      continue;
    }

    const prevEdges = new Map(prevLayer.graph.edges.map((e) => [e.id, e]));
    const nextEdges = new Map(layer.graph.edges.map((e) => [e.id, e]));
    for (const [id, edge] of nextEdges) {
      if (!prevEdges.has(id)) {
        changed.add(edge.source.node);
        changed.add(edge.target.node);
      }
    }
    for (const [id, edge] of prevEdges) {
      if (!nextEdges.has(id)) {
        changed.add(edge.source.node);
        changed.add(edge.target.node);
      }
    }

    const prevNodes = new Map(prevLayer.graph.nodes.map((n) => [n.id, n]));
    for (const node of layer.graph.nodes) {
      const prevNode = prevNodes.get(node.id);
      if (!prevNode) {
        changed.add(node.id);
        continue;
      }
      if ((prevNode.bypassed ?? false) !== (node.bypassed ?? false)) changed.add(node.id);
      else if (JSON.stringify(prevNode.params) !== JSON.stringify(node.params)) changed.add(node.id);
    }
  }

  return changed;
}

// ── GPU boundary (mirrors `GpuBinding` in renderer.ts) ──────────────────────

export interface ThumbnailGpu {
  /** Renders `compiled` as a flat, unlit fullscreen quad into a pooled
   *  `size`×`size` render target and blits the result onto `canvas` (resized
   *  to `size`×`size` first). */
  renderInto(compiled: CompiledProgram, size: number, canvas: HTMLCanvasElement): void;
  dispose(): void;
}

function flipVertical(pixels: Uint8Array<ArrayBuffer>, size: number): Uint8ClampedArray<ArrayBuffer> {
  const rowBytes = size * 4;
  const out = new Uint8ClampedArray(pixels.length);
  for (let y = 0; y < size; y++) {
    const src = y * rowBytes;
    const dst = (size - 1 - y) * rowBytes;
    out.set(pixels.subarray(src, src + rowBytes), dst);
  }
  return out;
}

/** Real `ThumbnailGpu`: shares `renderer` (the SAME `THREE.WebGLRenderer` the
 *  main viewer's `GpuBinding` draws with — see `createPreviewRenderer`) by
 *  redirecting its output to an offscreen target via `setRenderTarget` and
 *  restoring the previous target afterwards, exactly like a scissor/viewport
 *  save-restore. Never constructs a second `WebGLRenderer`/canvas/context. */
export function createThumbnailGpu(renderer: THREE.WebGLRenderer): ThumbnailGpu {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const clock = new THREE.Clock();
  const pool = new Map<number, THREE.WebGLRenderTarget>();
  let mesh: THREE.Mesh | null = null;

  function targetFor(size: number): THREE.WebGLRenderTarget {
    let target = pool.get(size);
    if (!target) {
      target = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, stencilBuffer: false });
      pool.set(size, target);
    }
    return target;
  }

  function renderInto(compiled: CompiledProgram, size: number, canvas: HTMLCanvasElement): void {
    const uniforms: Record<string, THREE.IUniform> = {};
    for (const spec of compiled.uniforms) {
      uniforms[spec.name] = {
        value: toThreeUniformValue(spec.type, (spec.default as ScalarOrVector | string) ?? 0),
      };
    }
    const uTime = uniforms.uTime;
    if (uTime) uTime.value = clock.getElapsedTime();

    const material = new THREE.RawShaderMaterial({
      vertexShader: compiled.vertex ?? '',
      fragmentShader: compiled.fragment ?? '',
      uniforms,
      glslVersion: THREE.GLSL1,
    });

    const previousMaterial = mesh ? (mesh.material as THREE.Material) : null;
    if (!mesh) {
      mesh = new THREE.Mesh(geometry, material);
      scene.add(mesh);
    } else {
      mesh.material = material;
    }
    previousMaterial?.dispose();

    const target = targetFor(size);
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const pixels: Uint8Array<ArrayBuffer> = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels);
    renderer.setRenderTarget(previousTarget);

    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx?.putImageData(new ImageData(flipVertical(pixels, size), size, size), 0, 0);
  }

  function dispose(): void {
    if (mesh) {
      scene.remove(mesh);
      (mesh.material as THREE.Material).dispose();
      mesh = null;
    }
    geometry.dispose();
    for (const target of pool.values()) target.dispose();
    pool.clear();
  }

  return { renderInto, dispose };
}

// ── Scheduler ────────────────────────────────────────────────────────────

export type CompileGraphFn = (
  graph: ShaderGraph,
  target: TargetLang,
  opts: CompileOptions,
) => CompiledProgram;

/** The slice of `ThumbnailScheduler` `PreviewRenderer` depends on, so
 *  `renderer.test.ts` can inject a plain fake without touching THREE or the
 *  DOM at all (same pattern as `GpuBinding`). */
export interface ThumbnailHost {
  onDocument(doc: ShaderDocument, target: TargetLang, changedNodeIds: Set<string>): void;
  markDirty(nodeId: string): void;
  markAllDirty(): void;
  setVisibleNodes(nodeIds: string[]): void;
  request(req: ThumbnailRequest): Promise<HTMLCanvasElement>;
  setBudget(msPerFrame: number): void;
  dispose(): void;
}

interface Waiter {
  resolve: (canvas: HTMLCanvasElement) => void;
  reject: (err: unknown) => void;
}

interface ThumbnailEntry {
  size: number;
  dirty: boolean;
  canvas: HTMLCanvasElement | null;
  waiters: Waiter[];
}

export interface ThumbnailSchedulerDeps {
  compile?: CompileGraphFn;
  createCanvas?: () => HTMLCanvasElement;
  scheduleFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
}

/** Owns per-node dirty/visible/budget bookkeeping and the promise-based
 *  `requestThumbnail` contract; delegates the actual pixels to a `ThumbnailGpu`
 *  so this class is fully unit-testable with a fake one. */
export class ThumbnailScheduler implements ThumbnailHost {
  private doc: ShaderDocument | null = null;
  private target: TargetLang = 'glsl-es';
  private budgetMs = 8;
  private visible = new Set<string>();
  private entries = new Map<string, ThumbnailEntry>();
  private frameHandle: number | null = null;
  /** Gates `kick()` independently of `frameHandle`'s VALUE, deliberately —
   *  `scheduleFrame` returns a handle synchronously for real `rAF`, but a
   *  synchronous test double runs `tick` (which clears this flag) BEFORE
   *  `scheduleFrame` returns, so `this.frameHandle = this.scheduleFrame(...)`
   *  would otherwise stomp the just-cleared "no tick pending" state with a
   *  stale handle and wedge every future `kick()`. */
  private scheduled = false;

  private readonly compile: CompileGraphFn;
  private readonly createCanvas: () => HTMLCanvasElement;
  private readonly scheduleFrame: (cb: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly now: () => number;

  constructor(
    private readonly gpu: ThumbnailGpu,
    deps: ThumbnailSchedulerDeps = {},
  ) {
    this.compile = deps.compile ?? ((graph, target, opts) => backends.get(target).compileGraph(graph, opts));
    this.createCanvas = deps.createCanvas ?? (() => document.createElement('canvas'));
    this.scheduleFrame = deps.scheduleFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = deps.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.now = deps.now ?? (() => performance.now());
  }

  /** Called on every `PreviewRenderer.setDocument`: records the latest doc,
   *  propagates dirtiness for `changedNodeIds` (+ their downstream subtree),
   *  and drops tracking for any node that no longer exists. */
  onDocument(doc: ShaderDocument, target: TargetLang, changedNodeIds: Set<string>): void {
    this.doc = doc;
    if (target !== this.target) {
      this.target = target;
      for (const entry of this.entries.values()) entry.dirty = true;
    }
    for (const nodeId of changedNodeIds) this.propagateDirty(nodeId);

    const live = allNodeIds(doc);
    for (const [id, entry] of [...this.entries]) {
      if (!live.has(id)) {
        this.rejectAll(entry, new Error(`Node "${id}" no longer exists.`));
        this.entries.delete(id);
      }
    }
    this.kick();
  }

  markDirty(nodeId: string): void {
    this.propagateDirty(nodeId);
    this.kick();
  }

  markAllDirty(): void {
    for (const entry of this.entries.values()) entry.dirty = true;
    this.kick();
  }

  setVisibleNodes(nodeIds: string[]): void {
    this.visible = new Set(nodeIds);
    this.kick();
  }

  setBudget(msPerFrame: number): void {
    this.budgetMs = Math.max(0, msPerFrame);
  }

  request(req: ThumbnailRequest): Promise<HTMLCanvasElement> {
    const size = snapThumbnailSize(req.size);
    let entry = this.entries.get(req.nodeId);
    if (!entry) {
      entry = { size, dirty: true, canvas: null, waiters: [] };
      this.entries.set(req.nodeId, entry);
    } else if (size !== entry.size) {
      entry.size = size;
      entry.dirty = true;
    }

    if (!entry.dirty && entry.canvas) return Promise.resolve(entry.canvas);

    const pending = entry;
    return new Promise<HTMLCanvasElement>((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
      this.kick();
    });
  }

  dispose(): void {
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.scheduled = false;
    for (const entry of this.entries.values()) this.rejectAll(entry, new Error('ThumbnailScheduler disposed.'));
    this.entries.clear();
    this.gpu.dispose();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private propagateDirty(nodeId: string): void {
    if (!this.doc) {
      const entry = this.entries.get(nodeId);
      if (entry) entry.dirty = true;
      return;
    }
    const layer = findLayerContaining(this.doc, nodeId);
    const affected = layer ? downstreamClosure(layer.graph, nodeId) : new Set([nodeId]);
    for (const id of affected) {
      const entry = this.entries.get(id);
      if (entry) entry.dirty = true;
    }
  }

  private hasPendingWork(): boolean {
    for (const [id, entry] of this.entries) {
      if (entry.dirty && entry.waiters.length > 0 && this.visible.has(id)) return true;
    }
    return false;
  }

  private kick(): void {
    if (this.scheduled || !this.hasPendingWork()) return;
    this.scheduled = true;
    this.frameHandle = this.scheduleFrame(this.tick);
  }

  private readonly tick = (): void => {
    this.scheduled = false;
    this.frameHandle = null;
    const start = this.now();
    for (const [id, entry] of this.entries) {
      if (!entry.dirty || entry.waiters.length === 0 || !this.visible.has(id)) continue;
      this.renderOne(id, entry);
      if (this.now() - start >= this.budgetMs) break;
    }
    if (this.hasPendingWork()) this.kick();
  };

  private renderOne(nodeId: string, entry: ThumbnailEntry): void {
    if (!this.doc) return;
    const layer = findLayerContaining(this.doc, nodeId);
    if (!layer) {
      entry.dirty = false;
      this.rejectAll(entry, new Error(`Node "${nodeId}" is not in any layer.`));
      return;
    }

    let compiled: CompiledProgram;
    try {
      compiled = this.compile(layer.graph, this.target, { previewNodeId: nodeId });
    } catch (err) {
      entry.dirty = false;
      this.rejectAll(entry, err);
      return;
    }

    const errors = compiled.diagnostics.filter((d) => d.level === 'error');
    if (errors.length > 0) {
      // A transient invalid graph (e.g. mid-edit cycle): stop retrying until
      // the next real edit re-marks it dirty, and never hang a waiter forever
      // — resolve with the last-good frame if there is one.
      entry.dirty = false;
      if (entry.canvas) this.resolveAll(entry, entry.canvas);
      else this.rejectAll(entry, new Error(errors.map((e) => e.message).join('; ')));
      return;
    }

    if (!entry.canvas) entry.canvas = this.createCanvas();
    this.gpu.renderInto(compiled, entry.size, entry.canvas);
    entry.dirty = false;
    this.resolveAll(entry, entry.canvas);
  }

  private resolveAll(entry: ThumbnailEntry, canvas: HTMLCanvasElement): void {
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const w of waiters) w.resolve(canvas);
  }

  private rejectAll(entry: ThumbnailEntry, err: unknown): void {
    const waiters = entry.waiters;
    entry.waiters = [];
    for (const w of waiters) w.reject(err);
  }
}

/** The one shared thumbnail scheduler: wires a real `ThumbnailGpu` (sharing
 *  `renderer`) into a `ThumbnailScheduler`. */
export function createThumbnailScheduler(
  renderer: THREE.WebGLRenderer,
  deps?: ThumbnailSchedulerDeps,
): ThumbnailScheduler {
  return new ThumbnailScheduler(createThumbnailGpu(renderer), deps);
}
