// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — WGSL backend
// ───────────────────────────────────────────────────────────────────────────
// Lowers a `ShaderGraph`/`ShaderDocument` into a raw WGSL module: a single
// entry function (`sg_main`) followed by the shared prelude (noise + blend
// helpers). All graph topology, dispatch order, and default-value/coercion
// diagnostics come from `../lower` — the SAME pass `glsl-es.ts` uses,
// unmodified. This file only supplies the WGSL-specific vocabulary: type
// names, literal syntax, the coercion table, the shared function prelude, and
// layer compositing. See this file's task note for the `lower.ts`
// reconciliation findings this backend was built to force.
//
// Entry-function convention: `sg_main`'s signature must be the very first
// thing in `module` (`vUv: vec2<f32>` then one parameter per declared
// uniform, in declaration order) because `src/preview/renderer.ts` binds this
// module through three.js's `wgslFn`, whose WGSL parser only recognises a
// function declaration anchored at the START of the source string — anything
// after that first function's closing brace (the prelude, here) is carried
// through verbatim as additional module-scope WGSL text.
//
// Color-space note: identical simplification to `glsl-es.ts` — every `color`
// socket is a plain linear vec3, no sRGB<->linear conversion anywhere here.
// ═══════════════════════════════════════════════════════════════════════════

import type {
  BlendMode,
  ScalarOrVector,
  ShaderDocument,
  ShaderGraph,
  SocketType,
} from '../../model/document';
import { nodes as defaultRegistry, type NodeRegistry } from '../../nodes/registry';
import {
  backends,
  type CompileOptions,
  type CompiledProgram,
  type Diagnostic,
  type ShaderBackend,
} from '../backend';
import { createEmitSink, lowerGraph, type LowerHooks } from '../lower';
// Naming convention only (`u_layer_${id}_opacity`) — pure string formatting,
// not GLSL syntax, so it is reused verbatim rather than duplicated. See this
// file's header comment / task report for why this didn't need to move.
import { layerOpacityUniformName } from './glsl-es';

export { layerOpacityUniformName };

// ── WGSL type-name mapping ───────────────────────────────────────────────────
function typeName(type: SocketType): string {
  switch (type) {
    case 'float':
      return 'f32';
    case 'int':
      return 'i32';
    case 'bool':
      return 'bool';
    case 'vec2':
      return 'vec2<f32>';
    case 'vec3':
    case 'color':
    case 'normal':
      return 'vec3<f32>';
    case 'vec4':
      return 'vec4<f32>';
    case 'sampler2D':
      return 'texture_2d<f32>';
    case 'cubemap':
      return 'texture_cube<f32>';
  }
}

// ── Literal formatting ───────────────────────────────────────────────────────
function fmtNum(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return Number.isInteger(v) ? `${v}.0` : String(v);
}

function asComponents(value: ScalarOrVector | string | undefined, len: number): number[] {
  if (Array.isArray(value)) {
    const out = value.slice(0, len).map(Number);
    while (out.length < len) out.push(0);
    return out;
  }
  if (typeof value === 'number') return new Array(len).fill(value);
  return new Array(len).fill(0);
}

/** Renders an unconnected input socket's default value as a WGSL literal. */
export function wgslLiteral(value: ScalarOrVector | string | undefined, type: SocketType): string {
  switch (type) {
    case 'float':
      return fmtNum(typeof value === 'number' ? value : 0);
    case 'int':
      return String(Math.trunc(typeof value === 'number' ? value : 0));
    case 'bool':
      return value ? 'true' : 'false';
    case 'vec2': {
      const [x, y] = asComponents(value, 2);
      return `vec2<f32>(${fmtNum(x)}, ${fmtNum(y)})`;
    }
    case 'vec3':
    case 'color':
    case 'normal': {
      const [x, y, z] = asComponents(value, 3);
      return `vec3<f32>(${fmtNum(x)}, ${fmtNum(y)}, ${fmtNum(z)})`;
    }
    case 'vec4': {
      const [x, y, z, w] = asComponents(value ?? [0, 0, 0, 1], 4);
      return `vec4<f32>(${fmtNum(x)}, ${fmtNum(y)}, ${fmtNum(z)}, ${fmtNum(w)})`;
    }
    case 'sampler2D':
    case 'cubemap':
      // No starter node currently uses a texture input; identical gap to
      // `glslLiteral`'s "unbound sampler" — flagged by the caller, not
      // silently accepted.
      return '/* unbound sampler */';
  }
}

// ── Type-coercion table ──────────────────────────────────────────────────────
// Same permitted (from, to) pairs as `GLSL_COERCIONS` (both are exhaustive
// against the same target-neutral `SOCKET_COMPATIBILITY`) — only the surface
// syntax differs (WGSL constructors/builtins). See this backend's task report
// for why `lower.ts` itself needed no changes to support this second table.
type Pair = `${SocketType}->${SocketType}`;

const WGSL_COERCIONS: Partial<Record<Pair, (expr: string) => string>> = {
  'int->float': (e) => `f32(${e})`,
  'float->int': (e) => `i32(${e})`,
  'color->vec3': (e) => e,
  'normal->vec3': (e) => e,
  'vec3->color': (e) => e,
  'vec4->color': (e) => `${e}.rgb`,
  'color->vec4': (e) => `vec4<f32>(${e}, 1.0)`,
  'vec3->normal': (e) => `normalize(${e})`,
};

export function coerceWgsl(expr: string, from: SocketType, to: SocketType): string | undefined {
  if (from === to) return expr;
  const fn = WGSL_COERCIONS[`${from}->${to}` as Pair];
  return fn ? fn(expr) : undefined;
}

const HOOKS: LowerHooks = { target: 'wgsl', coerce: coerceWgsl, literal: wgslLiteral };

// ── Shared prelude ───────────────────────────────────────────────────────────
// WGSL port of `glsl-es.ts`'s `GLSL_PRELUDE`: same functions, same behaviour.
// WGSL for-loops allow a non-constant bound (unlike GLSL ES 1.0), so
// `sg_fbm` loops directly to `octaves` instead of GLSL's fixed-iteration+mask
// trick — a WGSL-side implementation choice inside this file, not a `lower.ts`
// change (`noise.fbm`'s node definition still bakes `octaves` as a compile-time
// literal for both backends; see its `emit['wgsl']`).
const WGSL_PRELUDE = `
fn sg_hash(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453123);
}

fn sg_valueNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = sg_hash(i);
  let b = sg_hash(i + vec2<f32>(1.0, 0.0));
  let c = sg_hash(i + vec2<f32>(0.0, 1.0));
  let d = sg_hash(i + vec2<f32>(1.0, 1.0));
  let u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

fn sg_fbm(p: vec2<f32>, octaves: i32, lacunarity: f32, gain: f32) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  for (var i: i32 = 0; i < octaves; i = i + 1) {
    sum = sum + amp * sg_valueNoise(p * freq);
    freq = freq * lacunarity;
    amp = amp * gain;
  }
  return sum;
}

fn sg_blendNormal(base: vec3<f32>, blend: vec4<f32>, opacity: f32) -> vec3<f32> {
  return mix(base, blend.rgb, opacity);
}

fn sg_blendMix(base: vec3<f32>, blend: vec4<f32>, opacity: f32) -> vec3<f32> {
  return mix(base, blend.rgb, opacity);
}

fn sg_blendAdd(base: vec3<f32>, blend: vec4<f32>, opacity: f32) -> vec3<f32> {
  return mix(base, base + blend.rgb, opacity);
}

fn sg_blendMultiply(base: vec3<f32>, blend: vec4<f32>, opacity: f32) -> vec3<f32> {
  return mix(base, base * blend.rgb, opacity);
}

fn sg_blendScreen(base: vec3<f32>, blend: vec4<f32>, opacity: f32) -> vec3<f32> {
  return mix(base, vec3<f32>(1.0) - (vec3<f32>(1.0) - base) * (vec3<f32>(1.0) - blend.rgb), opacity);
}

fn sg_overlayChannel(b: vec3<f32>, s: vec3<f32>) -> vec3<f32> {
  let lo = 2.0 * b * s;
  let hi = vec3<f32>(1.0) - 2.0 * (vec3<f32>(1.0) - b) * (vec3<f32>(1.0) - s);
  return mix(lo, hi, step(vec3<f32>(0.5), b));
}

fn sg_blendOverlay(base: vec3<f32>, blend: vec4<f32>, opacity: f32) -> vec3<f32> {
  return mix(base, sg_overlayChannel(base, blend.rgb), opacity);
}

fn sg_softLightD(x: vec3<f32>) -> vec3<f32> {
  let lo = ((16.0 * x - vec3<f32>(12.0)) * x + vec3<f32>(4.0)) * x;
  let hi = sqrt(max(x, vec3<f32>(0.0)));
  return mix(lo, hi, step(vec3<f32>(0.25), x));
}

fn sg_softLightChannel(b: vec3<f32>, s: vec3<f32>) -> vec3<f32> {
  let lo = b - (vec3<f32>(1.0) - 2.0 * s) * b * (vec3<f32>(1.0) - b);
  let hi = b + (2.0 * s - vec3<f32>(1.0)) * (sg_softLightD(b) - b);
  return mix(lo, hi, step(vec3<f32>(0.5), s));
}

fn sg_blendSoftLight(base: vec3<f32>, blend: vec4<f32>, opacity: f32) -> vec3<f32> {
  return mix(base, sg_softLightChannel(base, blend.rgb), opacity);
}

fn sg_blendSubtract(base: vec3<f32>, blend: vec4<f32>, opacity: f32) -> vec3<f32> {
  return mix(base, max(base - blend.rgb, vec3<f32>(0.0)), opacity);
}

fn sg_blendHeight(base: vec3<f32>, blend: vec4<f32>, opacity: f32) -> vec3<f32> {
  let h = clamp(blend.a + (opacity - 0.5) * 2.0, 0.0, 1.0);
  return mix(base, blend.rgb, h);
}
`.trim();

const BLEND_FN: Record<BlendMode, string> = {
  normal: 'sg_blendNormal',
  add: 'sg_blendAdd',
  multiply: 'sg_blendMultiply',
  screen: 'sg_blendScreen',
  overlay: 'sg_blendOverlay',
  softLight: 'sg_blendSoftLight',
  subtract: 'sg_blendSubtract',
  mix: 'sg_blendMix',
  height: 'sg_blendHeight',
  custom: 'sg_blendNormal',
};

function blendFunctionName(mode: BlendMode, diag: (d: Diagnostic) => void): string {
  if (mode === 'custom') {
    diag({
      level: 'warning',
      message:
        'Blend mode "custom" has no compiled blend-graph yet (only a mask graph exists on the model); falling back to Normal.',
    });
  }
  return BLEND_FN[mode] ?? 'sg_blendNormal';
}

/** Wraps an arbitrary node's sole output expression into a displayable
 *  vec4<f32> for `CompileOptions.previewNodeId`. WGSL port of `glsl-es.ts`'s
 *  `wrapForPreview`. */
function wrapForPreview(expr: string, type: SocketType, diag: (d: Diagnostic) => void): string {
  switch (type) {
    case 'vec4':
      return expr;
    case 'vec3':
    case 'color':
    case 'normal':
      return `vec4<f32>(${expr}, 1.0)`;
    case 'vec2':
      return `vec4<f32>(${expr}, 0.0, 1.0)`;
    case 'float':
      return `vec4<f32>(vec3<f32>(${expr}), 1.0)`;
    case 'int':
      return `vec4<f32>(vec3<f32>(f32(${expr})), 1.0)`;
    case 'bool':
      return `vec4<f32>(vec3<f32>(select(0.0, 1.0, ${expr})), 1.0)`;
    case 'sampler2D':
    case 'cubemap':
      diag({
        level: 'warning',
        message: `Cannot preview a "${type}" value directly; showing a placeholder.`,
      });
      return 'vec4<f32>(1.0, 0.0, 1.0, 1.0)';
  }
}

/** `sg_main`'s parameter list: `vUv` (the primary UV, three.js's `uv()` TSL
 *  node at bind time) followed by one parameter per declared uniform, in
 *  declaration order — the exact order `renderer.ts` must supply matching
 *  TSL argument nodes in. */
function functionParams(uniforms: { name: string; type: SocketType }[]): string {
  const params = ['vUv: vec2<f32>', ...uniforms.map((u) => `${u.name}: ${typeName(u.type)}`)];
  return params.join(', ');
}

function assembleModule(uniforms: { name: string; type: SocketType }[], body: string[]): string {
  const lines: string[] = [`fn sg_main(${functionParams(uniforms)}) -> vec4<f32> {`];
  for (const line of body) lines.push(`  ${line}`);
  lines.push('}', '', WGSL_PRELUDE);
  return lines.join('\n');
}

/** Number of source lines preceding the first body statement in
 *  `assembleModule`'s output (the `fn sg_main(...) -> vec4<f32> {` line, kept
 *  to exactly one line so this is always `1`) — mirrors `glsl-es.ts`'s
 *  `headerLineCount`, translating a `lowerGraph`-relative `sourceMap` line
 *  into an absolute, 1-indexed file line. */
function headerLineCount(): number {
  return 1;
}

/** Compiles a single graph (one layer, or a per-node/per-layer preview slice)
 *  to a self-contained WGSL module. */
function compileGraph(
  graph: ShaderGraph,
  opts?: CompileOptions,
  registry: NodeRegistry = defaultRegistry,
): CompiledProgram {
  const handle = createEmitSink();
  const effectiveGraph: ShaderGraph = opts?.previewNodeId
    ? { ...graph, outputNodeId: opts.previewNodeId }
    : graph;

  const result = lowerGraph(effectiveGraph, registry, HOOKS, handle.sink);

  if (opts?.previewNodeId) {
    if (result.outputExpr !== undefined) {
      const node = graph.nodes.find((n) => n.id === opts.previewNodeId);
      const def = node ? registry.get(node.type) : undefined;
      const outSocket = def?.outputs[0];
      const isTerminal = def ? def.outputs.length === 0 : false;
      const wrapped =
        outSocket && !isTerminal
          ? wrapForPreview(result.outputExpr, outSocket.type, handle.sink.diag)
          : result.outputExpr;
      handle.sink.emit(`return ${wrapped};`);
    } else {
      handle.sink.emit('return vec4<f32>(1.0, 0.0, 1.0, 1.0);');
    }
  } else {
    // Non-preview: the graph's own output node (`output.surface`) already
    // computed the final color as its returned expression — `sg_main` just
    // returns it. (Its `emit['wgsl']` deliberately does NOT emit a `return`
    // itself: this same node runs once per layer inside `compileDocument`'s
    // shared body, where an early `return` would abort compositing after the
    // first layer. See this file's task report.)
    const finalExpr = result.outputExpr ?? 'vec4<f32>(1.0, 0.0, 1.0, 1.0)';
    if (result.outputExpr === undefined) {
      handle.sink.diag({
        level: 'error',
        message: `Graph produced no output; returning a placeholder instead.`,
      });
    }
    handle.sink.emit(`return ${finalExpr};`);
  }

  const module = assembleModule(handle.uniforms, handle.body);
  const offset = headerLineCount();
  const sourceMap = result.sourceMap.map(({ line, nodeId }) => ({ line: offset + line + 1, nodeId }));

  return {
    target: 'wgsl',
    module,
    uniforms: handle.uniforms,
    diagnostics: handle.diagnostics,
    sourceMap,
  };
}

/** Compiles the whole document: every participating layer's graph, composited
 *  bottom-to-top with its own blend mode + opacity, exactly like
 *  `glsl-es.ts`'s `compileDocument` — same structure, WGSL syntax. */
function compileDocument(
  doc: ShaderDocument,
  opts?: CompileOptions,
  registry: NodeRegistry = defaultRegistry,
): CompiledProgram {
  if (opts?.previewNodeId) {
    const owner = doc.layerStack.layers.find((l) =>
      l.graph.nodes.some((n) => n.id === opts.previewNodeId),
    );
    if (!owner) {
      return {
        target: 'wgsl',
        module: '',
        uniforms: [],
        diagnostics: [
          {
            level: 'error',
            message: `No node "${opts.previewNodeId}" in document "${doc.id}".`,
          },
        ],
      };
    }
    return compileGraph(owner.graph, opts, registry);
  }

  if (opts?.previewLayerId) {
    const layer = doc.layerStack.layers.find((l) => l.id === opts.previewLayerId);
    if (!layer) {
      return {
        target: 'wgsl',
        module: '',
        uniforms: [],
        diagnostics: [
          {
            level: 'error',
            message: `No layer "${opts.previewLayerId}" in document "${doc.id}".`,
          },
        ],
      };
    }
    const { previewLayerId: _drop, ...rest } = opts;
    return compileGraph(layer.graph, rest, registry);
  }

  const soloed = doc.layerStack.layers.filter((l) => l.soloed);
  const participating = soloed.length > 0 ? soloed : doc.layerStack.layers.filter((l) => l.enabled);

  const handle = createEmitSink();
  let compositeVar = 'vec3<f32>(0.0)';
  const relativeSourceMap: Array<{ line: number; nodeId: string }> = [];

  for (const layer of participating) {
    const bodyOffset = handle.body.length;
    const result = lowerGraph(layer.graph, registry, HOOKS, handle.sink);
    for (const entry of result.sourceMap) {
      relativeSourceMap.push({ line: bodyOffset + entry.line, nodeId: entry.nodeId });
    }
    let layerColor = result.outputExpr;
    if (layerColor === undefined) {
      handle.sink.diag({
        level: 'error',
        message: `Layer "${layer.name}" (${layer.id}) produced no output; compositing a placeholder instead.`,
      });
      layerColor = 'vec4<f32>(1.0, 0.0, 1.0, 1.0)';
    }
    const blendFn = blendFunctionName(layer.blend, handle.sink.diag);
    const opacityUniform = handle.sink.uniform({
      name: layerOpacityUniformName(layer.id),
      type: 'float',
      paramId: 'opacity',
      default: layer.opacity,
    });
    const v = handle.sink.temp('layerComposite');
    handle.sink.emit(`let ${v}: vec3<f32> = ${blendFn}(${compositeVar}, (${layerColor}), ${opacityUniform});`);
    compositeVar = v;
  }

  handle.sink.emit(`return vec4<f32>(${compositeVar}, 1.0);`);

  const module = assembleModule(handle.uniforms, handle.body);
  const offset = headerLineCount();
  const sourceMap = relativeSourceMap.map(({ line, nodeId }) => ({ line: offset + line + 1, nodeId }));

  return {
    target: 'wgsl',
    module,
    uniforms: handle.uniforms,
    diagnostics: handle.diagnostics,
    sourceMap,
  };
}

export const wgslBackend: ShaderBackend = {
  id: 'wgsl',
  target: 'wgsl',
  headless: true,
  compileGraph: (graph, opts) => compileGraph(graph, opts),
  compileDocument: (doc, opts) => compileDocument(doc, opts),
};

// Side effect: register into the shared `backends` singleton on import, same
// pattern as `glslEsBackend`. `Map.set` makes re-import idempotent.
backends.register(wgslBackend);
