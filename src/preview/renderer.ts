// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Shared preview renderer (main viewer)
// ───────────────────────────────────────────────────────────────────────────
// Implements the slice of `PreviewScheduler` the main viewer needs:
// `setDocument` / `setTarget` / `setRig` / `setViewerSource` / `markDirty` /
// `markAllDirty`. Per-node thumbnails (`requestThumbnail`, `setVisibleNodes`,
// `setThumbnailBudget`) are a separate task and throw here.
//
// The core contract: `compileDocument` (relatively expensive — walks every
// node/edge and re-generates GLSL text) only runs when `topologySignature`
// (topology.ts) actually changes. Everything else — a param slider, a color
// swatch, a layer's opacity dial — writes straight into an already-linked
// program's uniform via a name → (type, GL binding) map built once at bind
// time, so dragging a slider never recompiles.
//
// Split in two for testability without a real GPU:
//   • `PreviewRenderer` — the orchestration/decision logic above. Pure
//     TypeScript aside from the `GpuBinding` calls it makes; unit-tested with
//     a fake `GpuBinding` and an injected `compile` spy (no canvas, no WebGL).
//   • `createThreeGpuBinding` — the actual WebGL2 binding, via three.js's
//     `WebGLRenderer`/`RawShaderMaterial` (three is already a pinned
//     dependency). This is the ONE shared GPU context: one canvas, one
//     renderer, one scene, rebound (not recreated) on every recompile.
// ═══════════════════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { MeshBasicNodeMaterial, WebGPURenderer, type Node as TslNode } from 'three/webgpu';
import { uniform, uv, wgslFn } from 'three/tsl';

import type { PreviewRig, ScalarOrVector, ShaderDocument, SocketType } from '../model/document';
import {
  backends,
  type CompileOptions,
  type CompiledProgram,
  type TargetLang,
} from '../compiler/backend';
// Side effect: registers `glslEsBackend` into the shared `backends` registry
// (idempotent — `Map.set`), and is also where `topology.ts` imports the
// layer-opacity uniform-naming convention from.
import '../compiler/backends/glsl-es';
// Side effect: registers `wgslBackend`, same pattern as glsl-es above.
import '../compiler/backends/wgsl';
import type { PreviewScheduler, ThumbnailRequest, ViewerSource } from './scheduler';
import { viewerSourceToCompileOptions } from './scheduler';
import { collectUniformValues, sameUniformValue, topologySignature } from './topology';
import { createThumbnailScheduler, diffChangedNodeIds, type ThumbnailHost } from './thumbnails';

function notImplemented(method: string): Error {
  return new Error(
    `PreviewRenderer.${method}() is not implemented — no ThumbnailHost was wired into this ` +
      'PreviewRenderer (only real usage, via createPreviewRenderer(), wires one).',
  );
}

// ── GPU boundary ─────────────────────────────────────────────────────────────
// Everything that actually touches WebGL lives behind this interface, so the
// orchestration logic above can be unit-tested with a fake.
export interface GpuBinding {
  /** (Re)links a program for a freshly compiled document + rig. Replaces the
   *  mesh/material in place; the canvas/renderer/scene are reused. */
  bind(compiled: CompiledProgram, rig: PreviewRig): void;
  /** Push one already-declared uniform's new value. No-ops if `name` isn't a
   *  uniform in the currently-bound program. */
  setUniformValue(name: string, type: SocketType, value: ScalarOrVector | string): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

export interface PreviewRendererDeps {
  /** Defaults to `backends.get(target).compileDocument(doc, opts)`. Injectable
   *  so tests can spy on/count compile calls without a real backend. */
  compile?: (doc: ShaderDocument, target: TargetLang, opts: CompileOptions) => CompiledProgram;
  /** Forwards a compile-error message (or `null` on recovery) to the host's
   *  error channel. The main viewer wires this to `store.lastError` —
   *  `NoticeToast`'s existing channel, not a second error UI. */
  onCompileError?: (message: string | null) => void;
  /** Fires with every `CompiledProgram` this renderer actually produces
   *  (real topology-change recompiles only — never on a value-only uniform
   *  write), whether or not it had errors: the lowering pass never throws, so
   *  `compiled` is always valid source + diagnostics even when `gpu.bind`
   *  gets skipped. Lets the code panel and per-node diagnostic badges reuse
   *  the SAME compile the GPU was (or would have been) bound to, instead of
   *  re-compiling a second time. */
  onCompiled?: (program: CompiledProgram) => void;
}

/** Drives one `GpuBinding` from `ShaderDocument` edits, recompiling only on a
 *  genuine topology change and writing every other edit straight to a bound
 *  uniform. Implements enough of `PreviewScheduler` to drive the main viewer;
 *  the thumbnail-only methods throw (next task's scope). */
export class PreviewRenderer implements PreviewScheduler {
  private target: TargetLang = 'glsl-es';
  private rig: PreviewRig = 'sphere';
  private viewerSource: ViewerSource = { kind: 'document' };
  private doc: ShaderDocument | null = null;

  /** The topology fingerprint the currently-BOUND program was compiled from.
   *  `null` until the first successful compile. */
  private boundSignature: string | null = null;
  private forceRecompile = true;
  /** Uniform name → declared type, for every uniform the bound program
   *  actually declared. A value with no entry here has no live uniform (e.g.
   *  `noise.fbm`'s `octaves`, baked as a GLSL ES loop bound) and can only be
   *  applied through a real recompile. */
  private boundUniforms = new Map<string, SocketType>();
  /** Last value pushed (or seeded at bind time) for every predicted uniform
   *  name, so a topology-unchanged `setDocument` only pushes what changed. */
  private lastValues = new Map<string, ScalarOrVector | string>();
  private lastCompileError: string | null = null;

  private readonly compile: NonNullable<PreviewRendererDeps['compile']>;
  private readonly onCompileError: PreviewRendererDeps['onCompileError'];
  private readonly onCompiled: PreviewRendererDeps['onCompiled'];

  constructor(
    private readonly gpu: GpuBinding,
    deps: PreviewRendererDeps = {},
    private readonly thumbnails?: ThumbnailHost,
  ) {
    this.compile = deps.compile ?? ((doc, target, opts) => backends.get(target).compileDocument(doc, opts));
    this.onCompileError = deps.onCompileError;
    this.onCompiled = deps.onCompiled;
  }

  // ── PreviewScheduler: implemented ─────────────────────────────────────────

  setDocument(doc: ShaderDocument): void {
    const prevDoc = this.doc;
    this.doc = doc;
    // Thumbnails only ever have a WebGL2-bound GPU host (see
    // `createPreviewRenderer`'s header comment) — always compile them
    // `glsl-es`, regardless of what the main viewer's `this.target` is, so a
    // main-viewer switch to `wgsl` doesn't silently drag thumbnail compiles
    // along with it.
    this.thumbnails?.onDocument(doc, 'glsl-es', diffChangedNodeIds(prevDoc, doc));
    this.reconcile();
  }

  setTarget(target: TargetLang): void {
    if (target === this.target) return;
    this.target = target;
    this.forceRecompile = true;
    this.thumbnails?.markAllDirty();
    this.reconcile();
  }

  setRig(rig: PreviewRig): void {
    if (rig === this.rig) return;
    this.rig = rig;
    this.forceRecompile = true;
    this.reconcile();
  }

  setViewerSource(src: ViewerSource): void {
    this.viewerSource = src;
    this.forceRecompile = true;
    this.reconcile();
  }

  /** Marks `nodeId` and its downstream subtree's thumbnails stale. Every doc
   *  edit already routes through `setDocument`, which diffs old vs. new and
   *  calls this same propagation automatically — this is for a caller that
   *  wants to invalidate a node explicitly (e.g. an upstream asset changed
   *  out-of-band). The main viewer's own output is always the latest full
   *  compile, so there is nothing narrower to invalidate there. */
  markDirty(nodeId: string): void {
    this.thumbnails?.markDirty(nodeId);
  }

  markAllDirty(): void {
    this.forceRecompile = true;
    this.thumbnails?.markAllDirty();
    this.reconcile();
  }

  dispose(): void {
    this.thumbnails?.dispose();
    this.gpu.dispose();
  }

  // ── PreviewScheduler: per-node thumbnails ─────────────────────────────────

  setVisibleNodes(nodeIds: string[]): void {
    if (!this.thumbnails) throw notImplemented('setVisibleNodes');
    this.thumbnails.setVisibleNodes(nodeIds);
  }

  requestThumbnail(req: ThumbnailRequest): Promise<ImageBitmap | HTMLCanvasElement> {
    if (!this.thumbnails) return Promise.reject(notImplemented('requestThumbnail'));
    return this.thumbnails.request(req);
  }

  setThumbnailBudget(msPerFrame: number): void {
    if (!this.thumbnails) throw notImplemented('setThumbnailBudget');
    this.thumbnails.setBudget(msPerFrame);
  }

  // ── Extra (not part of PreviewScheduler): canvas sizing ───────────────────

  resize(width: number, height: number): void {
    this.gpu.resize(width, height);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private reconcile(): void {
    if (!this.doc) return;
    const signature = topologySignature(this.doc, this.target, this.viewerSource);
    const topologyChanged = this.forceRecompile || signature !== this.boundSignature;
    if (topologyChanged) {
      this.recompile(signature);
      return;
    }
    this.applyValueChanges(false);
  }

  private recompile(signature: string): void {
    const doc = this.doc as ShaderDocument;
    const compiled = this.compile(doc, this.target, this.compileOptions());
    this.onCompiled?.(compiled);
    const errors = compiled.diagnostics.filter((d) => d.level === 'error');

    if (errors.length > 0) {
      // Never crash on a cycle/invalid graph: keep whatever program was
      // bound before (a blank canvas on the very first compile), surface the
      // failure through the host's error channel, and try again on the next
      // edit — `forceRecompile` stays true so a fix is picked up immediately.
      const message = `Shader compile error: ${errors.map((e) => e.message).join('; ')}`;
      this.lastCompileError = message;
      this.onCompileError?.(message);
      return;
    }

    this.gpu.bind(compiled, this.rig);
    this.boundUniforms = new Map(compiled.uniforms.map((u) => [u.name, u.type]));
    this.lastValues = new Map();
    this.applyValueChanges(true);
    this.boundSignature = signature;
    this.forceRecompile = false;

    if (this.lastCompileError) {
      this.lastCompileError = null;
      this.onCompileError?.(null);
    }
  }

  /** Pushes every value that differs from `lastValues` to its bound uniform.
   *  `seed = true` right after a (re)compile: every value is (re)applied
   *  unconditionally, and a value with no live uniform is NOT treated as
   *  needing a follow-up recompile (the compile that just happened already
   *  baked it in — avoids recompiling forever on a param like `octaves`). */
  private applyValueChanges(seed: boolean): void {
    if (!this.doc) return;
    let sawUnboundChange = false;

    for (const entry of collectUniformValues(this.doc)) {
      const previous = this.lastValues.get(entry.name);
      const unchanged = !seed && previous !== undefined && sameUniformValue(previous, entry.value);
      if (unchanged) continue;
      this.lastValues.set(entry.name, entry.value);

      const type = this.boundUniforms.get(entry.name);
      if (type === undefined) {
        if (!seed) sawUnboundChange = true;
        continue;
      }
      this.gpu.setUniformValue(entry.name, type, entry.value);
    }

    if (sawUnboundChange) {
      // e.g. `noise.fbm`'s `octaves`: no uniform exists because GLSL ES 1.0
      // requires a constant loop bound, so the new value can only take
      // effect through a real recompile.
      this.forceRecompile = true;
      this.reconcile();
    }
  }

  private compileOptions(): CompileOptions {
    return viewerSourceToCompileOptions(this.viewerSource);
  }
}

// ── Real GPU binding: three.js WebGLRenderer + RawShaderMaterial ────────────
// three.js supplies the WebGL2 context, program linking, and per-uniform
// upload bookkeeping (`material.uniforms[name].value = x` never relinks the
// program) — exactly the "uniform-location map built once at bind time" the
// task asks for, without hand-rolling `gl.getUniformLocation` bookkeeping.
// `RawShaderMaterial` + `glslVersion: THREE.GLSL1` passes our GLSL ES 1.0
// source through untouched (`attribute`/`varying`/`gl_FragColor`, matching
// what `glsl-es.ts` emits) instead of three's usual GLSL-300 upgrade.

interface RigSetup {
  geometry: THREE.BufferGeometry;
  camera: THREE.Camera;
  side: THREE.Side;
  spin: boolean;
}

function rigSetup(rig: PreviewRig): RigSetup {
  switch (rig) {
    case 'fullscreen':
      return {
        geometry: new THREE.PlaneGeometry(2, 2),
        camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
        side: THREE.FrontSide,
        spin: false,
      };
    case 'sphere': {
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
      camera.position.set(0, 0, 2.6);
      return { geometry: new THREE.SphereGeometry(1, 64, 64), camera, side: THREE.FrontSide, spin: true };
    }
    case 'mesh': {
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
      camera.position.set(0, 0, 2.6);
      return {
        geometry: new THREE.TorusKnotGeometry(0.6, 0.22, 128, 24),
        camera,
        side: THREE.FrontSide,
        spin: true,
      };
    }
    case 'skybox': {
      const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 10);
      camera.position.set(0, 0, 0);
      return { geometry: new THREE.BoxGeometry(2, 2, 2), camera, side: THREE.BackSide, spin: false };
    }
  }
}

/** Exported for `thumbnails.ts`'s `createThumbnailGpu`, so both halves of the
 *  one shared renderer convert a `NodeParam`/uniform value into a three.js
 *  uniform value the exact same way. */
export function toThreeUniformValue(type: SocketType, value: ScalarOrVector | string): unknown {
  switch (type) {
    case 'float':
      return typeof value === 'number' ? value : 0;
    case 'int':
      return typeof value === 'number' ? Math.trunc(value) : 0;
    case 'bool':
      return Boolean(value);
    case 'vec2': {
      const [x, y] = Array.isArray(value) ? value : [0, 0];
      return new THREE.Vector2(Number(x) || 0, Number(y) || 0);
    }
    case 'vec3':
    case 'color':
    case 'normal': {
      const [x, y, z] = Array.isArray(value) ? value : [0, 0, 0];
      return new THREE.Vector3(Number(x) || 0, Number(y) || 0, Number(z) || 0);
    }
    case 'vec4': {
      const [x, y, z, w] = Array.isArray(value) ? value : [0, 0, 0, 1];
      return new THREE.Vector4(Number(x) || 0, Number(y) || 0, Number(z) || 0, Number(w) || 1);
    }
    case 'sampler2D':
    case 'cubemap':
      // No starter node emits a texture uniform yet (matches `glslLiteral`'s
      // "unbound sampler" gap in the backend) — nothing to bind.
      return null;
  }
}

/** Constructs the ONE `THREE.WebGLRenderer`/WebGL2 context `createPreviewRenderer`
 *  shares between the main viewer's `GpuBinding` and the thumbnail scheduler's
 *  `ThumbnailGpu` (`thumbnails.ts`) — split out so both can be handed the same
 *  instance instead of each creating its own context. */
export function createThreeRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(0x000000, 1);
  return renderer;
}

/** Real `GpuBinding`: driven by a continuous render loop (so `input.time`'s
 *  `uTime` animates and any rig's gentle idle spin plays) for as long as the
 *  main viewer is mounted, on `renderer` — the SAME shared context the
 *  thumbnail scheduler renders into via `setRenderTarget`, never a second
 *  `WebGLRenderer`/canvas. */
export function createThreeGpuBinding(renderer: THREE.WebGLRenderer): GpuBinding {
  const scene = new THREE.Scene();
  const clock = new THREE.Clock();

  let mesh: THREE.Mesh | null = null;
  let material: THREE.RawShaderMaterial | null = null;
  let camera: THREE.Camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let spin = false;

  function bind(compiled: CompiledProgram, rig: PreviewRig): void {
    const uniforms: Record<string, THREE.IUniform> = {};
    for (const spec of compiled.uniforms) {
      uniforms[spec.name] = {
        value: toThreeUniformValue(spec.type, (spec.default as ScalarOrVector | string) ?? 0),
      };
    }

    const setup = rigSetup(rig);
    const nextMaterial = new THREE.RawShaderMaterial({
      vertexShader: compiled.vertex ?? '',
      fragmentShader: compiled.fragment ?? '',
      uniforms,
      side: setup.side,
      glslVersion: THREE.GLSL1,
    });

    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    mesh = new THREE.Mesh(setup.geometry, nextMaterial);
    scene.add(mesh);
    material = nextMaterial;
    camera = setup.camera;
    spin = setup.spin;

    const size = new THREE.Vector2();
    renderer.getSize(size);
    if (camera instanceof THREE.PerspectiveCamera && size.y > 0) {
      camera.aspect = size.x / size.y;
      camera.updateProjectionMatrix();
    }
  }

  function setUniformValue(name: string, type: SocketType, value: ScalarOrVector | string): void {
    const uniform = material?.uniforms[name];
    if (!uniform) return;
    uniform.value = toThreeUniformValue(type, value);
  }

  function resize(width: number, height: number): void {
    renderer.setSize(width, height, false);
    if (camera instanceof THREE.PerspectiveCamera && height > 0) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }

  function frame(): void {
    if (mesh && material) {
      const uTime = material.uniforms.uTime;
      if (uTime) uTime.value = clock.getElapsedTime();
      if (spin) mesh.rotation.y += 0.0025;
      renderer.render(scene, camera);
    }
    rafHandle = requestAnimationFrame(frame);
  }
  let rafHandle = requestAnimationFrame(frame);

  function dispose(): void {
    cancelAnimationFrame(rafHandle);
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    renderer.dispose();
  }

  return { bind, setUniformValue, resize, dispose };
}

// ── Real GPU binding: three.js WebGPURenderer + a WGSL `wgslFn` node material ─
// WebGPU's NodeMaterial pipeline has no `RawShaderMaterial` equivalent (there
// is no way to hand a WebGPU material a complete, self-contained shader module
// string the way `RawShaderMaterial` takes raw GLSL) — instead, three's TSL
// `wgslFn(code)` wraps a raw WGSL function as a callable node-graph primitive
// (see `wgsl.ts`'s header comment on why `sg_main` must be the first thing in
// `compiled.module`). Calling that wrapped function with one TSL node per
// `sg_main` parameter — `uv()` for the primary UV, then one `uniform(...)`
// node per declared uniform, in the exact order `compiled.uniforms` declares
// them — produces the node this binding assigns to `MeshBasicNodeMaterial
// .colorNode`, which is WebGPU's equivalent of "this expression IS the pixel
// color", parallel to `RawShaderMaterial`'s `gl_FragColor`.
function createThreeWebGpuBinding(renderer: WebGPURenderer): GpuBinding {
  const scene = new THREE.Scene();
  const clock = new THREE.Clock();

  let mesh: THREE.Mesh | null = null;
  let material: MeshBasicNodeMaterial | null = null;
  let camera: THREE.Camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  let spin = false;
  // Every uniform node this binding currently has live, keyed by the SAME
  // `UniformSpec.name` the compiled program declared — `setUniformValue`
  // looks a name up here exactly like `createThreeGpuBinding`'s
  // `material.uniforms[name]` does for the WebGL path.
  let uniformNodes = new Map<string, ReturnType<typeof uniform>>();

  function bind(compiled: CompiledProgram, rig: PreviewRig): void {
    if (!compiled.module) return;

    const nextUniformNodes = new Map<string, ReturnType<typeof uniform>>();
    const args: TslNode[] = [uv()];
    for (const spec of compiled.uniforms) {
      const node = uniform(toThreeUniformValue(spec.type, (spec.default as ScalarOrVector | string) ?? 0));
      nextUniformNodes.set(spec.name, node);
      args.push(node);
    }
    uniformNodes = nextUniformNodes;

    const colorNode = (wgslFn(compiled.module) as (...params: TslNode[]) => TslNode)(...args);
    const setup = rigSetup(rig);
    const nextMaterial = new MeshBasicNodeMaterial();
    nextMaterial.colorNode = colorNode;
    nextMaterial.side = setup.side;

    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    mesh = new THREE.Mesh(setup.geometry, nextMaterial);
    scene.add(mesh);
    material = nextMaterial;
    camera = setup.camera;
    spin = setup.spin;

    const size = new THREE.Vector2();
    renderer.getSize(size);
    if (camera instanceof THREE.PerspectiveCamera && size.y > 0) {
      camera.aspect = size.x / size.y;
      camera.updateProjectionMatrix();
    }
  }

  function setUniformValue(name: string, type: SocketType, value: ScalarOrVector | string): void {
    const node = uniformNodes.get(name);
    if (!node) return;
    node.value = toThreeUniformValue(type, value);
  }

  function resize(width: number, height: number): void {
    renderer.setSize(width, height, false);
    if (camera instanceof THREE.PerspectiveCamera && height > 0) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }

  // `WebGPURenderer.render()` is a thin sync wrapper: it warns and defers to
  // `renderAsync()` internally when the device hasn't finished its async
  // `init()` yet, rather than throwing — so a frame that lands before init
  // resolves just quietly renders nothing that tick instead of crashing the
  // loop.
  function frame(): void {
    if (mesh && material) {
      const uTimeNode = uniformNodes.get('uTime');
      if (uTimeNode) uTimeNode.value = clock.getElapsedTime();
      if (spin) mesh.rotation.y += 0.0025;
      renderer.render(scene, camera);
    }
    rafHandle = requestAnimationFrame(frame);
  }
  let rafHandle = requestAnimationFrame(frame);

  function dispose(): void {
    cancelAnimationFrame(rafHandle);
    if (mesh) {
      scene.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    renderer.dispose();
  }

  return { bind, setUniformValue, resize, dispose };
}

// ── Dual-backend routing ─────────────────────────────────────────────────────
// A WebGL2 context and a WebGPU context can never share one `<canvas>` (once
// a canvas's rendering context type is established, the browser refuses to
// hand out a context of a different type for that canvas's lifetime) — so
// switching `PreviewRenderer.setTarget('wgsl')` cannot simply rebind the SAME
// canvas the way switching rigs/documents does. Instead this binding owns the
// original (GLSL/WebGL) canvas plus a second, lazily-created WGSL/WebGPU
// canvas stacked in the same DOM slot, and shows/hides whichever one the
// active `CompiledProgram.target` needs — `MainViewer.tsx` itself stays
// completely unaware that a second canvas exists.
function createDualBackendGpuBinding(
  glCanvas: HTMLCanvasElement,
  glBinding: GpuBinding,
): GpuBinding {
  let wgpuBinding: GpuBinding | null = null;
  let wgpuCanvas: HTMLCanvasElement | null = null;
  let active: TargetLang = 'glsl-es';
  let lastSize: { width: number; height: number } | null = null;

  function ensureWgpuBinding(): GpuBinding {
    if (!wgpuBinding) {
      const canvas = document.createElement('canvas');
      canvas.className = glCanvas.className;
      canvas.style.display = 'none';
      glCanvas.insertAdjacentElement('afterend', canvas);
      wgpuCanvas = canvas;
      const renderer = new WebGPURenderer({ canvas, antialias: true });
      renderer.setClearColor(new THREE.Color(0x000000), 1);
      wgpuBinding = createThreeWebGpuBinding(renderer);
      if (lastSize) wgpuBinding.resize(lastSize.width, lastSize.height);
    }
    return wgpuBinding;
  }

  function activate(target: TargetLang): void {
    if (target === active) return;
    active = target;
    glCanvas.style.display = target === 'glsl-es' ? 'block' : 'none';
    if (wgpuCanvas) wgpuCanvas.style.display = target === 'wgsl' ? 'block' : 'none';
  }

  return {
    bind(compiled, rig) {
      if (compiled.target === 'wgsl') {
        // `ensureWgpuBinding()` must run first: on the very first switch it
        // lazily creates `wgpuCanvas`, and `activate('wgsl')` only flips a
        // canvas's `display` if it already exists — calling `activate`
        // before the canvas exists leaves it stuck at `display:none` forever
        // (the early-return guard means `activate('wgsl')` never runs again
        // while already active).
        ensureWgpuBinding().bind(compiled, rig);
        activate('wgsl');
      } else {
        activate('glsl-es');
        glBinding.bind(compiled, rig);
      }
    },
    setUniformValue(name, type, value) {
      const target = active === 'wgsl' ? wgpuBinding : glBinding;
      target?.setUniformValue(name, type, value);
    },
    resize(width, height) {
      lastSize = { width, height };
      glBinding.resize(width, height);
      wgpuBinding?.resize(width, height);
    },
    dispose() {
      glBinding.dispose();
      wgpuBinding?.dispose();
      wgpuCanvas?.remove();
    },
  };
}

/** The one shared renderer for BOTH the main viewer and every per-node
 *  thumbnail (AGENTS.md: "One shared renderer... Dirty + visible only."): a
 *  single `THREE.WebGLRenderer`/WebGL2 context on `canvas` backs a real
 *  `GpuBinding` (the main viewer's continuous render loop) AND a
 *  `ThumbnailScheduler` (pooled offscreen render targets, dirty+visible+
 *  budget gated) — never two contexts. `setTarget('wgsl')` is handled by
 *  `createDualBackendGpuBinding`, which owns a SECOND, lazily-created
 *  WebGPU canvas of its own (see that function's header) — the thumbnail
 *  scheduler is unaffected and keeps using the original WebGL context
 *  regardless of the main viewer's active target (per-node thumbnails on the
 *  `wgsl` target are a known, separate gap — see this task's report). */
export function createPreviewRenderer(
  canvas: HTMLCanvasElement,
  deps?: PreviewRendererDeps,
): PreviewRenderer {
  const renderer = createThreeRenderer(canvas);
  const glBinding = createThreeGpuBinding(renderer);
  const thumbnails = createThumbnailScheduler(renderer);
  const binding = createDualBackendGpuBinding(canvas, glBinding);
  return new PreviewRenderer(binding, deps, thumbnails);
}
