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
import type { PreviewScheduler, ThumbnailRequest, ViewerSource } from './scheduler';
import { collectUniformValues, sameUniformValue, topologySignature } from './topology';

function notImplemented(method: string): Error {
  return new Error(
    `PreviewRenderer.${method}() is not implemented — thumbnails are a separate task (see the ` +
      '"Main viewer" task note for scope). The main viewer does not need it.',
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

  constructor(
    private readonly gpu: GpuBinding,
    deps: PreviewRendererDeps = {},
  ) {
    this.compile = deps.compile ?? ((doc, target, opts) => backends.get(target).compileDocument(doc, opts));
    this.onCompileError = deps.onCompileError;
  }

  // ── PreviewScheduler: implemented ─────────────────────────────────────────

  setDocument(doc: ShaderDocument): void {
    this.doc = doc;
    this.reconcile();
  }

  setTarget(target: TargetLang): void {
    if (target === this.target) return;
    this.target = target;
    this.forceRecompile = true;
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

  markDirty(_nodeId: string): void {
    // Per-node dirtiness only matters once per-node thumbnails exist (next
    // task); the main viewer always reflects the latest full-document
    // compile, so there is nothing narrower to invalidate here.
  }

  markAllDirty(): void {
    this.forceRecompile = true;
    this.reconcile();
  }

  dispose(): void {
    this.gpu.dispose();
  }

  // ── PreviewScheduler: next task's scope ───────────────────────────────────

  setVisibleNodes(_nodeIds: string[]): void {
    throw notImplemented('setVisibleNodes');
  }

  requestThumbnail(_req: ThumbnailRequest): Promise<ImageBitmap | HTMLCanvasElement> {
    throw notImplemented('requestThumbnail');
  }

  setThumbnailBudget(_msPerFrame: number): void {
    throw notImplemented('setThumbnailBudget');
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
    if (this.viewerSource.kind === 'node') return { previewNodeId: this.viewerSource.nodeId };
    if (this.viewerSource.kind === 'layer') return { previewLayerId: this.viewerSource.layerId };
    return {};
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

function toThreeUniformValue(type: SocketType, value: ScalarOrVector | string): unknown {
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

/** Real `GpuBinding`: one `THREE.WebGLRenderer` bound to `canvas`, driven by a
 *  continuous render loop (so `input.time`'s `uTime` animates and any rig's
 *  gentle idle spin plays) for as long as the main viewer is mounted. */
export function createThreeGpuBinding(canvas: HTMLCanvasElement): GpuBinding {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setClearColor(0x000000, 1);
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

/** The one shared renderer for the main viewer: wires a real `GpuBinding`
 *  (three.js/WebGL2 on `canvas`) into a `PreviewRenderer`. */
export function createPreviewRenderer(
  canvas: HTMLCanvasElement,
  deps?: PreviewRendererDeps,
): PreviewRenderer {
  return new PreviewRenderer(createThreeGpuBinding(canvas), deps);
}
