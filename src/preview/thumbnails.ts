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
import type { ScalarOrVector, ShaderDocument, ShaderGraph, ShaderLayer, StackNode } from '../model/document';
import { allStackNodes, ancestorGroupIds, findLayerOwningNode, flattenLayers } from '../model/layerTree';
import type { AssetThumbnailRequest, StackThumbnailRequest, ThumbnailRequest } from './scheduler';
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
  return findLayerOwningNode(doc.layerStack.layers, nodeId);
}

/** A cheap structural fingerprint of one `StackNode`'s OWN
 *  compositing-relevant fields — everything a Layers-panel row's thumbnail
 *  depends on that a per-node `changedNodeIds` diff can never see (blend/
 *  opacity/enabled/visible/soloed/mask-presence, and for a group, its
 *  children's identity + order). Two documents produce the same string iff
 *  this node would compile to the identical `previewLayerId` output —
 *  `ThumbnailScheduler.onDocument` diffs this per stack node, every call, to
 *  drive stack-thumbnail dirtiness the same way `diffChangedNodeIds` drives
 *  per-node dirtiness. */
function stackNodeSignature(node: StackNode): string {
  const base = `${node.kind}|${node.blend}|${node.opacity}|${node.enabled}|${node.visible}|${node.soloed ?? false}|${
    node.maskGraph ? 1 : 0
  }`;
  return node.kind === 'group' ? `${base}|${node.children.map((c) => c.id).join(',')}` : base;
}

function allNodeIds(doc: ShaderDocument): Set<string> {
  const ids = new Set<string>();
  for (const layer of flattenLayers(doc.layerStack.layers)) {
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
  const nextLayers = flattenLayers(next.layerStack.layers);
  if (!prev) {
    for (const layer of nextLayers) {
      for (const node of layer.graph.nodes) changed.add(node.id);
    }
    return changed;
  }

  const prevLayers = flattenLayers(prev.layerStack.layers);
  for (const layer of nextLayers) {
    const prevLayer = prevLayers.find((l) => l.id === layer.id);
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

/** Compiles a whole DOCUMENT slice — what a Layers-panel row's thumbnail
 *  needs (`{ previewLayerId: stackNodeId }`, leaf OR group — see
 *  `CompileOptions.previewLayerId`), unlike `CompileGraphFn`'s bare
 *  `ShaderGraph` (a single node's SOLO preview, always scoped to one leaf's
 *  own graph). A group has no single `ShaderGraph` of its own to hand
 *  `compileGraph`; only `compileDocument` can fold an arbitrary subtree. */
export type CompileDocumentFn = (
  doc: ShaderDocument,
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
  /** The Layers-panel counterpart of `setVisibleNodes`/`request`: one
   *  thumbnail per STACK NODE (leaf layer or group), keyed by that node's own
   *  id rather than a node-inside-a-graph id — a disjoint id space and a
   *  disjoint dirty/visible/budget tracker, so panel scrolling never starves
   *  (or is starved by) the graph canvas's per-node thumbnails. */
  setVisibleStackNodes(ids: string[]): void;
  requestStack(req: StackThumbnailRequest): Promise<HTMLCanvasElement>;
  /** The Assets-panel counterpart of `setVisibleNodes`/`setVisibleStackNodes`:
   *  a THIRD, disjoint id space (caller-assigned `AssetThumbnailRequest.key`
   *  strings, never a real graph/stack node id) for auto-graphed per-file
   *  thumbnails — see `renderer.ts`'s `PreviewScheduler.setVisibleAssetThumbnails`. */
  setVisibleAssetThumbnails(keys: string[]): void;
  requestAsset(req: AssetThumbnailRequest): Promise<HTMLCanvasElement>;
  releaseAsset(key: string): void;
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

/** `ThumbnailEntry` plus what an Assets-panel row's own throwaway document
 *  needs: the document itself (compiled fresh whenever `dirty`, never
 *  diffed/topology-signatured the way the main document is — there is
 *  nothing to diff against, each request may hand a brand-new document
 *  object) and the content signature that last caused a render, so a
 *  same-signature request short-circuits to the cached canvas exactly like
 *  an unchanged `entries`/`stackEntries` row does. */
interface AssetThumbnailEntry extends ThumbnailEntry {
  doc: ShaderDocument;
  signature: string;
}

export interface ThumbnailSchedulerDeps {
  compile?: CompileGraphFn;
  /** Defaults to `backends.get(target).compileDocument(doc, opts)`. Only
   *  ever called with `{ previewLayerId: <stack node id> }` — see
   *  `renderOneStack`. */
  compileDocument?: CompileDocumentFn;
  createCanvas?: () => HTMLCanvasElement;
  scheduleFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
  now?: () => number;
}

/** Owns per-node dirty/visible/budget bookkeeping and the promise-based
 *  `requestThumbnail` contract; delegates the actual pixels to a `ThumbnailGpu`
 *  so this class is fully unit-testable with a fake one.
 *
 *  Per-STACK-NODE (Layers panel) thumbnails are a second, parallel tracker
 *  (`stackEntries`/`stackVisible`/`stackSignatures`) inside this SAME class,
 *  and per-ASSET (Assets panel, auto-graphed file previews) thumbnails are a
 *  THIRD (`assetEntries`/`assetVisible`) — all three sharing the one
 *  `ThumbnailGpu`/render-target pool and the one dirty+visible+budget
 *  scheduling loop, per AGENTS.md ("one shared renderer... never a second
 *  preview path"), while staying disjoint id spaces so none of the three
 *  trackers can ever collide with or starve either of the others. */
export class ThumbnailScheduler implements ThumbnailHost {
  private doc: ShaderDocument | null = null;
  private target: TargetLang = 'glsl-es';
  private budgetMs = 8;
  private visible = new Set<string>();
  private entries = new Map<string, ThumbnailEntry>();
  private stackVisible = new Set<string>();
  private stackEntries = new Map<string, ThumbnailEntry>();
  /** The last `stackNodeSignature` seen for every stack node, so `onDocument`
   *  can diff structural (blend/opacity/enabled/visible/soloed/mask/
   *  membership) changes that no `changedNodeIds` entry would ever capture. */
  private stackSignatures = new Map<string, string>();
  /** THIRD, disjoint tracker: one entry per Assets-panel row (keyed by the
   *  caller's own `AssetThumbnailRequest.key`), each carrying its OWN
   *  throwaway `ShaderDocument` + content signature rather than referencing
   *  `this.doc` — completely independent of whatever document the main
   *  viewer/Layers panel are currently editing. Shares the same
   *  `gpu`/render-target pool and the same dirty+visible+budget `tick()` loop
   *  as `entries`/`stackEntries` (one shared renderer, per AGENTS.md), never
   *  a second scheduling path. */
  private assetVisible = new Set<string>();
  private assetEntries = new Map<string, AssetThumbnailEntry>();
  private frameHandle: number | null = null;
  /** Gates `kick()` independently of `frameHandle`'s VALUE, deliberately —
   *  `scheduleFrame` returns a handle synchronously for real `rAF`, but a
   *  synchronous test double runs `tick` (which clears this flag) BEFORE
   *  `scheduleFrame` returns, so `this.frameHandle = this.scheduleFrame(...)`
   *  would otherwise stomp the just-cleared "no tick pending" state with a
   *  stale handle and wedge every future `kick()`. */
  private scheduled = false;

  private readonly compile: CompileGraphFn;
  private readonly compileDocument: CompileDocumentFn;
  private readonly createCanvas: () => HTMLCanvasElement;
  private readonly scheduleFrame: (cb: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly now: () => number;

  constructor(
    private readonly gpu: ThumbnailGpu,
    deps: ThumbnailSchedulerDeps = {},
  ) {
    this.compile = deps.compile ?? ((graph, target, opts) => backends.get(target).compileGraph(graph, opts));
    this.compileDocument = deps.compileDocument ?? ((doc, target, opts) => backends.get(target).compileDocument(doc, opts));
    this.createCanvas = deps.createCanvas ?? (() => document.createElement('canvas'));
    this.scheduleFrame = deps.scheduleFrame ?? ((cb) => requestAnimationFrame(cb));
    this.cancelFrame = deps.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    this.now = deps.now ?? (() => performance.now());
  }

  /** Called on every `PreviewRenderer.setDocument`: records the latest doc,
   *  propagates dirtiness for `changedNodeIds` (+ their downstream subtree,
   *  and every stack node it lives inside), diffs stack-node signatures to
   *  catch every OTHER stack-relevant change, and drops tracking for any
   *  node/stack-node that no longer exists. */
  onDocument(doc: ShaderDocument, target: TargetLang, changedNodeIds: Set<string>): void {
    this.doc = doc;
    if (target !== this.target) {
      this.target = target;
      for (const entry of this.entries.values()) entry.dirty = true;
      for (const entry of this.stackEntries.values()) entry.dirty = true;
      for (const entry of this.assetEntries.values()) entry.dirty = true;
    }
    for (const nodeId of changedNodeIds) this.propagateDirty(nodeId);

    const live = allNodeIds(doc);
    for (const [id, entry] of [...this.entries]) {
      if (!live.has(id)) {
        this.rejectAll(entry, new Error(`Node "${id}" no longer exists.`));
        this.entries.delete(id);
      }
    }

    const stackNodes = allStackNodes(doc.layerStack.layers);
    const nextSignatures = new Map(stackNodes.map((n) => [n.id, stackNodeSignature(n)]));
    for (const n of stackNodes) {
      if (this.stackSignatures.get(n.id) !== nextSignatures.get(n.id)) {
        this.markStackDirtyWithAncestors(doc.layerStack.layers, n.id);
      }
    }
    for (const [id, entry] of [...this.stackEntries]) {
      if (!nextSignatures.has(id)) {
        this.rejectAll(entry, new Error(`Layer "${id}" no longer exists.`));
        this.stackEntries.delete(id);
      }
    }
    this.stackSignatures = nextSignatures;

    this.kick();
  }

  markDirty(nodeId: string): void {
    this.propagateDirty(nodeId);
    this.kick();
  }

  markAllDirty(): void {
    for (const entry of this.entries.values()) entry.dirty = true;
    for (const entry of this.stackEntries.values()) entry.dirty = true;
    for (const entry of this.assetEntries.values()) entry.dirty = true;
    this.kick();
  }

  setVisibleNodes(nodeIds: string[]): void {
    this.visible = new Set(nodeIds);
    this.kick();
  }

  setVisibleStackNodes(ids: string[]): void {
    this.stackVisible = new Set(ids);
    this.kick();
  }

  setVisibleAssetThumbnails(keys: string[]): void {
    this.assetVisible = new Set(keys);
    this.kick();
  }

  setBudget(msPerFrame: number): void {
    this.budgetMs = Math.max(0, msPerFrame);
  }

  request(req: ThumbnailRequest): Promise<HTMLCanvasElement> {
    return this.requestFrom(this.entries, req.nodeId, req.size);
  }

  requestStack(req: StackThumbnailRequest): Promise<HTMLCanvasElement> {
    return this.requestFrom(this.stackEntries, req.id, req.size);
  }

  requestAsset(req: AssetThumbnailRequest): Promise<HTMLCanvasElement> {
    const size = snapThumbnailSize(req.size);
    let entry = this.assetEntries.get(req.key);
    if (!entry) {
      entry = { size, dirty: true, canvas: null, waiters: [], doc: req.doc, signature: req.signature };
      this.assetEntries.set(req.key, entry);
    } else {
      // The signature (not `req.doc` itself — a caller may rebuild an
      // equivalent document object every call) is the ONLY thing that
      // re-dirties an already-rendered entry, per `AssetThumbnailRequest`'s
      // own doc comment. `entry.doc` is still refreshed unconditionally so a
      // genuine re-render (dirty for any reason) always compiles the LATEST
      // document a caller handed in, never a stale one from the first call.
      entry.doc = req.doc;
      if (entry.signature !== req.signature) {
        entry.signature = req.signature;
        entry.dirty = true;
      }
      if (size !== entry.size) {
        entry.size = size;
        entry.dirty = true;
      }
    }

    if (!entry.dirty && entry.canvas) return Promise.resolve(entry.canvas);

    const pending = entry;
    return new Promise<HTMLCanvasElement>((resolve, reject) => {
      pending.waiters.push({ resolve, reject });
      this.kick();
    });
  }

  releaseAsset(key: string): void {
    const entry = this.assetEntries.get(key);
    if (!entry) return;
    this.rejectAll(entry, new Error(`Asset thumbnail "${key}" released.`));
    this.assetEntries.delete(key);
  }

  dispose(): void {
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.scheduled = false;
    for (const entry of this.entries.values()) this.rejectAll(entry, new Error('ThumbnailScheduler disposed.'));
    this.entries.clear();
    for (const entry of this.stackEntries.values()) this.rejectAll(entry, new Error('ThumbnailScheduler disposed.'));
    this.stackEntries.clear();
    for (const entry of this.assetEntries.values()) this.rejectAll(entry, new Error('ThumbnailScheduler disposed.'));
    this.assetEntries.clear();
    this.gpu.dispose();
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private requestFrom(
    entries: Map<string, ThumbnailEntry>,
    id: string,
    requestedSize: number | undefined,
  ): Promise<HTMLCanvasElement> {
    const size = snapThumbnailSize(requestedSize);
    let entry = entries.get(id);
    if (!entry) {
      entry = { size, dirty: true, canvas: null, waiters: [] };
      entries.set(id, entry);
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
    // The owning leaf's own thumbnail (and every group that folds it in) is
    // also affected by a change to any node inside its graph.
    if (layer) this.markStackDirtyWithAncestors(this.doc.layerStack.layers, layer.id);
  }

  /** Marks `id`'s OWN stack thumbnail dirty (if tracked) plus every group
   *  that transitively contains it — a change anywhere inside a subtree
   *  invalidates every ancestor's already-folded composite, not just the
   *  node itself (see `LayerGroup`'s own doc comment on `foldStack`). */
  private markStackDirtyWithAncestors(layers: readonly StackNode[], id: string): void {
    const entry = this.stackEntries.get(id);
    if (entry) entry.dirty = true;
    for (const ancestorId of ancestorGroupIds(layers, id)) {
      const ancestorEntry = this.stackEntries.get(ancestorId);
      if (ancestorEntry) ancestorEntry.dirty = true;
    }
  }

  private hasPendingWork(): boolean {
    for (const [id, entry] of this.entries) {
      if (entry.dirty && entry.waiters.length > 0 && this.visible.has(id)) return true;
    }
    for (const [id, entry] of this.stackEntries) {
      if (entry.dirty && entry.waiters.length > 0 && this.stackVisible.has(id)) return true;
    }
    for (const [id, entry] of this.assetEntries) {
      if (entry.dirty && entry.waiters.length > 0 && this.assetVisible.has(id)) return true;
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
    for (const [id, entry] of this.stackEntries) {
      if (!entry.dirty || entry.waiters.length === 0 || !this.stackVisible.has(id)) continue;
      this.renderOneStack(id, entry);
      if (this.now() - start >= this.budgetMs) break;
    }
    for (const [id, entry] of this.assetEntries) {
      if (!entry.dirty || entry.waiters.length === 0 || !this.assetVisible.has(id)) continue;
      this.renderOneAsset(entry);
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
      compiled = this.compile(layer.graph, this.target, {
        previewNodeId: nodeId,
        subGraphs: this.doc.subGraphs,
      });
    } catch (err) {
      entry.dirty = false;
      this.rejectAll(entry, err);
      return;
    }

    this.finishRenderFromCompile(entry, compiled);
  }

  /** The stack-node (leaf layer OR group) counterpart of `renderOne`:
   *  compiles the WHOLE document isolated to just this one node's subtree
   *  (`CompileOptions.previewLayerId`, generalized in both backends to accept
   *  a group id — see `glsl-es.ts`/`wgsl.ts`), rather than one node inside a
   *  single graph. */
  private renderOneStack(id: string, entry: ThumbnailEntry): void {
    if (!this.doc) return;

    let compiled: CompiledProgram;
    try {
      compiled = this.compileDocument(this.doc, this.target, {
        previewLayerId: id,
        subGraphs: this.doc.subGraphs,
      });
    } catch (err) {
      entry.dirty = false;
      this.rejectAll(entry, err);
      return;
    }

    this.finishRenderFromCompile(entry, compiled);
  }

  /** The Assets-panel counterpart of `renderOne`/`renderOneStack`: compiles
   *  `entry.doc` — a caller-built, SELF-CONTAINED throwaway document — as a
   *  full composite (`compileDocument(doc, target, {})`, no `previewLayerId`/
   *  `previewNodeId`; the document's own single base layer/graph output IS
   *  what the row's thumbnail should show), never anything derived from
   *  `this.doc`. */
  private renderOneAsset(entry: AssetThumbnailEntry): void {
    let compiled: CompiledProgram;
    try {
      compiled = this.compileDocument(entry.doc, this.target, { subGraphs: entry.doc.subGraphs });
    } catch (err) {
      entry.dirty = false;
      this.rejectAll(entry, err);
      return;
    }

    this.finishRenderFromCompile(entry, compiled);
  }

  /** Shared tail of `renderOne`/`renderOneStack`, once a `CompiledProgram`
   *  exists: surface a compile error (resolving with the last-good frame if
   *  there is one, so a transient mid-edit invalid graph never hangs a
   *  waiter forever), otherwise render into the entry's pooled canvas. */
  private finishRenderFromCompile(entry: ThumbnailEntry, compiled: CompiledProgram): void {
    const errors = compiled.diagnostics.filter((d) => d.level === 'error');
    if (errors.length > 0) {
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
