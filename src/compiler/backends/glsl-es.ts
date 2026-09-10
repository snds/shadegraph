// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — GLSL ES 1.0 backend
// ───────────────────────────────────────────────────────────────────────────
// Lowers a `ShaderGraph`/`ShaderDocument` into a real, self-contained GLSL ES
// 1.0 vertex + fragment pair (varying/gl_FragColor, no #version 300 syntax) —
// the target that drives Legion today. All graph topology, dispatch order,
// and default-value/coercion diagnostics come from `../lower`; this file only
// supplies the GLSL-specific vocabulary: type names, literal syntax, the
// coercion table, the shared function prelude, and layer compositing.
//
// Color-space note: every socket typed `color` is treated as a plain linear
// vec3 throughout — there is no implicit sRGB<->linear conversion anywhere in
// this backend, because `ShaderDocument` carries no color-space metadata to
// convert from. That is a deliberate simplification, not an oversight; see
// the task note for this file's follow-up discussion.
// ═══════════════════════════════════════════════════════════════════════════

import type {
  BlendMode,
  ScalarOrVector,
  ShaderDocument,
  ShaderGraph,
  SocketType,
  StackNode,
} from '../../model/document';
import { sanitizeIdent } from '../../model/ids';
import { findLayer, findLayerOwningNode } from '../../model/layerTree';
import { nodes as defaultRegistry, type NodeRegistry } from '../../nodes/registry';
import {
  backends,
  type CompileOptions,
  type CompiledProgram,
  type Diagnostic,
  type ShaderBackend,
} from '../backend';
import { createEmitSink, lowerGraph, type EmitSinkHandle, type LowerHooks } from '../lower';

// A layer's opacity is a dial, not a topology choice — it must drive a
// uniform (see `paramUniform` in `nodes/definitions/helpers.ts` for the
// per-node-param convention this mirrors) rather than being baked in as a
// GLSL literal, or dragging the opacity slider would force a recompile.
// `ShaderLayer` has no owning `ShaderNode`/param id of its own, so this is a
// synthetic, layer-level uniform name. Exported so `src/preview/topology.ts`
// can predict this exact name at bind time (to resolve its uniform location)
// without duplicating the naming scheme and risking drift.
export function layerOpacityUniformName(layerId: string): string {
  return `u_layer_${sanitizeIdent(layerId)}_opacity`;
}

// ── GLSL type-name mapping ──────────────────────────────────────────────────
// `color`/`normal` are semantic aliases of `vec3` in this backend: every
// starter node emitter already treats them as plain vec3s (see
// `color.ramp`/`output.surface`), so the declared GLSL type follows suit.
function typeName(type: SocketType): string {
  switch (type) {
    case 'float':
      return 'float';
    case 'int':
      return 'int';
    case 'bool':
      return 'bool';
    case 'vec2':
      return 'vec2';
    case 'vec3':
    case 'color':
    case 'normal':
      return 'vec3';
    case 'vec4':
      return 'vec4';
    case 'sampler2D':
      return 'sampler2D';
    case 'cubemap':
      return 'samplerCube';
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

/** Renders an unconnected input socket's default value as a GLSL ES literal. */
export function glslLiteral(value: ScalarOrVector | string | undefined, type: SocketType): string {
  switch (type) {
    case 'float':
      return fmtNum(typeof value === 'number' ? value : 0);
    case 'int':
      return String(Math.trunc(typeof value === 'number' ? value : 0));
    case 'bool':
      return value ? 'true' : 'false';
    case 'vec2': {
      const [x, y] = asComponents(value, 2);
      return `vec2(${fmtNum(x)}, ${fmtNum(y)})`;
    }
    case 'vec3':
    case 'color':
    case 'normal': {
      const [x, y, z] = asComponents(value, 3);
      return `vec3(${fmtNum(x)}, ${fmtNum(y)}, ${fmtNum(z)})`;
    }
    case 'vec4': {
      const [x, y, z, w] = asComponents(value ?? [0, 0, 0, 1], 4);
      return `vec4(${fmtNum(x)}, ${fmtNum(y)}, ${fmtNum(z)}, ${fmtNum(w)})`;
    }
    case 'sampler2D':
    case 'cubemap':
      // No starter node currently uses a texture input; an unconnected sampler
      // has no valid literal. Flagged by the caller, not silently accepted.
      return '/* unbound sampler */';
  }
}

// ── Type-coercion table ──────────────────────────────────────────────────────
// Keyed by every (from, to) pair `SOCKET_COMPATIBILITY` permits where the two
// types are NOT already identical. This is exhaustive against the current
// model (see `lower.test.ts` for the cross-check against `SOCKET_COMPATIBILITY`
// itself) — a new socket-compatibility rule that isn't the same GLSL shape
// needs a new entry here, and the test will fail loudly if one is missing.
//
//   int    -> float   numeric widen: `float(x)`
//   float  -> int     numeric narrow (truncates): `int(x)`
//   color  -> vec3    identity: both are plain vec3 in this backend
//   normal -> vec3    identity: both are plain vec3 in this backend
//   vec3   -> color   identity: both are plain vec3 in this backend
//   vec4   -> color   drop alpha: `x.rgb` (NOT gamma-corrected — see file header)
//   color  -> vec4    add opaque alpha: `vec4(x, 1.0)`
//   vec3   -> normal  renormalize: `normalize(x)` — a `normal` socket is a unit
//                      vector by contract; a plain vec3 arriving here (e.g. from
//                      a math node) is not guaranteed unit length, so this is a
//                      real conversion, not just a relabel.
type Pair = `${SocketType}->${SocketType}`;

const GLSL_COERCIONS: Partial<Record<Pair, (expr: string) => string>> = {
  'int->float': (e) => `float(${e})`,
  'float->int': (e) => `int(${e})`,
  'color->vec3': (e) => e,
  'normal->vec3': (e) => e,
  'vec3->color': (e) => e,
  'vec4->color': (e) => `${e}.rgb`,
  'color->vec4': (e) => `vec4(${e}, 1.0)`,
  'vec3->normal': (e) => `normalize(${e})`,
};

export function coerceGlsl(expr: string, from: SocketType, to: SocketType): string | undefined {
  if (from === to) return expr;
  const fn = GLSL_COERCIONS[`${from}->${to}` as Pair];
  return fn ? fn(expr) : undefined;
}

const HOOKS: LowerHooks = { target: 'glsl-es', coerce: coerceGlsl, literal: glslLiteral };

// ── Shared prelude ───────────────────────────────────────────────────────────
// Function library every compiled program includes once, regardless of how
// many nodes/layers reference it. Never inlined per call site.
const SG_MAX_OCTAVES = 8;

const GLSL_PRELUDE = `
// ── sg_fbm: value noise + fractal brownian motion ──────────────────────────
// GLSL ES 1.0 requires for-loop bounds to be constant expressions, so octave
// count (a runtime int parameter) cannot drive the loop directly. Instead the
// loop always runs to a fixed maximum and each iteration is masked to zero
// once it passes the caller's requested octave count.
float sg_hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float sg_valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = sg_hash(i);
  float b = sg_hash(i + vec2(1.0, 0.0));
  float c = sg_hash(i + vec2(0.0, 1.0));
  float d = sg_hash(i + vec2(1.0, 1.0));
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
}

float sg_fbm(vec2 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < ${SG_MAX_OCTAVES}; i++) {
    float active = step(float(i), float(octaves) - 0.5);
    sum += active * amp * sg_valueNoise(p * freq);
    freq *= lacunarity;
    amp *= gain;
  }
  return sum;
}

// ── Blend-mode library ──────────────────────────────────────────────────────
// One shared function per BlendMode, called once per layer during document
// compositing rather than inlined. Every function shares the signature
// (vec3 base, vec4 blend, float opacity) -> vec3 so sg_blendHeight can read
// the incoming layer's own alpha as a height/mask signal without a special
// case in the caller.
vec3 sg_blendNormal(vec3 base, vec4 blend, float opacity) {
  return mix(base, blend.rgb, opacity);
}

vec3 sg_blendMix(vec3 base, vec4 blend, float opacity) {
  return mix(base, blend.rgb, opacity);
}

vec3 sg_blendAdd(vec3 base, vec4 blend, float opacity) {
  return mix(base, base + blend.rgb, opacity);
}

vec3 sg_blendMultiply(vec3 base, vec4 blend, float opacity) {
  return mix(base, base * blend.rgb, opacity);
}

vec3 sg_blendScreen(vec3 base, vec4 blend, float opacity) {
  return mix(base, 1.0 - (1.0 - base) * (1.0 - blend.rgb), opacity);
}

vec3 sg_overlayChannel(vec3 b, vec3 s) {
  vec3 lo = 2.0 * b * s;
  vec3 hi = 1.0 - 2.0 * (1.0 - b) * (1.0 - s);
  return mix(lo, hi, step(0.5, b));
}

vec3 sg_blendOverlay(vec3 base, vec4 blend, float opacity) {
  return mix(base, sg_overlayChannel(base, blend.rgb), opacity);
}

vec3 sg_softLightD(vec3 x) {
  vec3 lo = ((16.0 * x - 12.0) * x + 4.0) * x;
  vec3 hi = sqrt(max(x, 0.0));
  return mix(lo, hi, step(0.25, x));
}

vec3 sg_softLightChannel(vec3 b, vec3 s) {
  vec3 lo = b - (1.0 - 2.0 * s) * b * (1.0 - b);
  vec3 hi = b + (2.0 * s - 1.0) * (sg_softLightD(b) - b);
  return mix(lo, hi, step(0.5, s));
}

vec3 sg_blendSoftLight(vec3 base, vec4 blend, float opacity) {
  return mix(base, sg_softLightChannel(base, blend.rgb), opacity);
}

vec3 sg_blendSubtract(vec3 base, vec4 blend, float opacity) {
  return mix(base, max(base - blend.rgb, 0.0), opacity);
}

// Height-based blend: uses the incoming layer's own alpha as a mask, biased by
// its opacity dial, so a fully-opaque layer with alpha 1 always shows through
// and a lower opacity narrows the mask toward the base.
vec3 sg_blendHeight(vec3 base, vec4 blend, float opacity) {
  float h = clamp(blend.a + (opacity - 0.5) * 2.0, 0.0, 1.0);
  return mix(base, blend.rgb, h);
}
`.trim();

const VERTEX_SHADER = `
precision highp float;
attribute vec3 position;
attribute vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`.trim();

// `custom` has no compiled blend-graph field on `ShaderLayer` yet (only
// `maskGraph`, which is a mask, not a blend function) — falls back to Normal
// with a diagnostic rather than silently guessing at semantics.
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

/** Wraps an arbitrary node's sole output expression into a displayable vec4
 *  for `CompileOptions.previewNodeId` (per-node preview thumbnails). */
function wrapForPreview(expr: string, type: SocketType, diag: (d: Diagnostic) => void): string {
  switch (type) {
    case 'vec4':
      return expr;
    case 'vec3':
    case 'color':
    case 'normal':
      return `vec4(${expr}, 1.0)`;
    case 'vec2':
      return `vec4(${expr}, 0.0, 1.0)`;
    case 'float':
      return `vec4(vec3(${expr}), 1.0)`;
    case 'int':
      return `vec4(vec3(float(${expr})), 1.0)`;
    case 'bool':
      return `vec4(vec3(${expr} ? 1.0 : 0.0), 1.0)`;
    case 'sampler2D':
    case 'cubemap':
      diag({
        level: 'warning',
        message: `Cannot preview a "${type}" value directly; showing a placeholder.`,
      });
      return 'vec4(1.0, 0.0, 1.0, 1.0)';
  }
}

/** Builds the fixed portion of the fragment header ahead of `void main() {`:
 *  precision/varying, deduped uniform declarations, the shared function
 *  library, then every node-contributed `EmitContext.prelude` text (e.g. a
 *  `chunk.raw` node's imported `uniform`/function declarations — see
 *  `src/nodes/definitions/chunk.ts`) in dispatch order. Shared by
 *  `assembleFragment` and `headerLineCount` so the two can never drift. */
function buildHeaderLines(uniformDecls: string[], preludes: string[]): string[] {
  const lines: string[] = ['precision highp float;', 'varying vec2 vUv;', ...uniformDecls, ''];
  lines.push(GLSL_PRELUDE, '');
  for (const p of preludes) lines.push(p, '');
  lines.push('void main() {');
  return lines;
}

function assembleFragment(uniformDecls: string[], body: string[], preludes: string[] = []): string {
  const lines = buildHeaderLines(uniformDecls, preludes);
  for (const line of body) lines.push(`  ${line}`);
  lines.push('}');
  return lines.join('\n');
}

/** Number of source lines that precede the first body statement inside
 *  `assembleFragment`'s output (i.e. the 0-based line index of `void main()
 *  {` plus one). Shared by `compileGraph`/`compileDocument` to translate a
 *  `lowerGraph`-relative `sourceMap` line into an absolute, 1-indexed file
 *  line for `CompiledProgram.sourceMap` (code-panel click-to-source). Derived
 *  the same way `assembleFragment` builds its header, rather than duplicating
 *  a hand-counted constant, so it can never drift from the real prelude. */
function headerLineCount(uniformDecls: string[], preludes: string[] = []): number {
  return buildHeaderLines(uniformDecls, preludes).join('\n').split('\n').length;
}

/** Compiles a single graph (one layer, or a per-node/per-layer preview slice)
 *  to a self-contained GLSL ES vertex + fragment pair. */
function compileGraph(
  graph: ShaderGraph,
  opts?: CompileOptions,
  registry: NodeRegistry = defaultRegistry,
): CompiledProgram {
  const handle = createEmitSink();
  const effectiveGraph: ShaderGraph = opts?.previewNodeId
    ? { ...graph, outputNodeId: opts.previewNodeId }
    : graph;

  const result = lowerGraph(effectiveGraph, registry, HOOKS, handle.sink, opts?.subGraphs ?? []);

  if (opts?.previewNodeId && result.outputExpr !== undefined) {
    const node = graph.nodes.find((n) => n.id === opts.previewNodeId);
    const def = node ? registry.get(node.type) : undefined;
    const outSocket = def?.outputs[0];
    const isTerminal = def ? def.outputs.length === 0 : false;
    if (outSocket && !isTerminal) {
      const wrapped = wrapForPreview(result.outputExpr, outSocket.type, handle.sink.diag);
      handle.sink.emit(`gl_FragColor = ${wrapped};`);
    }
  }

  const uniformDecls = handle.uniforms.map((u) => `uniform ${typeName(u.type)} ${u.name};`);
  const fragment = assembleFragment(uniformDecls, handle.body, handle.preludes);
  const offset = headerLineCount(uniformDecls, handle.preludes);
  const sourceMap = result.sourceMap.map(({ line, nodeId }) => ({ line: offset + line + 1, nodeId }));

  return {
    target: 'glsl-es',
    vertex: VERTEX_SHADER,
    fragment,
    uniforms: handle.uniforms,
    diagnostics: handle.diagnostics,
    sourceMap,
  };
}

/** Folds one sibling array of the layer-stack tree (the document root, or one
 *  `LayerGroup.children`) bottom-to-top into a single `vec3` composite
 *  expression, recursing into any nested group EXACTLY the same way before
 *  treating its folded result as one blend contribution to its own parent —
 *  see `LayerGroup`'s own doc comment in `src/model/document.ts`. `enabled`/
 *  `soloed` are scoped to THIS sibling array only (soloing something inside a
 *  group never mutes anything outside it), mirroring
 *  `document.ts`: "when any layer is soloed, only soloed layers composite". */
function foldStack(
  nodes: StackNode[],
  handle: EmitSinkHandle,
  registry: NodeRegistry,
  subGraphs: ShaderDocument['subGraphs'],
  relativeSourceMap: Array<{ line: number; nodeId: string }>,
): string {
  const soloed = nodes.filter((n) => n.soloed);
  const participating = soloed.length > 0 ? soloed : nodes.filter((n) => n.enabled);

  let compositeVar = 'vec3(0.0)';

  for (const node of participating) {
    let layerColor: string;
    if (node.kind === 'group') {
      const localComposite = foldStack(node.children, handle, registry, subGraphs, relativeSourceMap);
      layerColor = `vec4(${localComposite}, 1.0)`;
    } else {
      const bodyOffset = handle.body.length;
      const result = lowerGraph(node.graph, registry, HOOKS, handle.sink, subGraphs);
      for (const entry of result.sourceMap) {
        relativeSourceMap.push({ line: bodyOffset + entry.line, nodeId: entry.nodeId });
      }
      layerColor = result.outputExpr ?? '';
      if (result.outputExpr === undefined) {
        handle.sink.diag({
          level: 'error',
          message: `Layer "${node.name}" (${node.id}) produced no output; compositing a placeholder instead.`,
        });
        layerColor = 'vec4(1.0, 0.0, 1.0, 1.0)';
      }
    }

    const blendFn = blendFunctionName(node.blend, handle.sink.diag);
    const opacityUniform = handle.sink.uniform({
      name: layerOpacityUniformName(node.id),
      type: 'float',
      paramId: 'opacity',
      default: node.opacity,
    });

    // A mask graph is compiled through the same `lowerGraph` path as the
    // node's own graph (sharing `handle.sink`, so its uniforms/temps/prelude
    // dedup exactly like any other node), terminating at its `output.mask`
    // node instead of `output.surface`. Its float result multiplies into the
    // opacity term passed to the blend function — a per-pixel modulation,
    // not a flat scalar, unlike the opacity uniform alone. Applies identically
    // to a group's own `maskGraph` — it masks the group's ALREADY-folded
    // local composite, not any one child.
    let opacityExpr = opacityUniform;
    if (node.maskGraph) {
      const maskBodyOffset = handle.body.length;
      const maskResult = lowerGraph(node.maskGraph, registry, HOOKS, handle.sink, subGraphs);
      for (const entry of maskResult.sourceMap) {
        relativeSourceMap.push({ line: maskBodyOffset + entry.line, nodeId: entry.nodeId });
      }
      if (maskResult.outputExpr === undefined) {
        handle.sink.diag({
          level: 'error',
          message: `Layer "${node.name}" (${node.id})'s mask graph produced no output; ignoring the mask for this layer.`,
        });
      } else {
        opacityExpr = `(${opacityUniform} * ${maskResult.outputExpr})`;
      }
    }

    const v = handle.sink.temp('layerComposite');
    handle.sink.emit(`vec3 ${v} = ${blendFn}(${compositeVar}, (${layerColor}), ${opacityExpr});`);
    compositeVar = v;
  }

  return compositeVar;
}

/** Compiles the whole document: every participating layer's graph, composited
 *  bottom-to-top with its own blend mode + opacity against an implicit black
 *  canvas beneath the stack. `enabled`/`soloed` follow the model's own
 *  semantics (`document.ts`: "when any layer is soloed, only soloed layers
 *  composite"). */
function compileDocument(
  doc: ShaderDocument,
  opts?: CompileOptions,
  registry: NodeRegistry = defaultRegistry,
): CompiledProgram {
  if (opts?.previewNodeId) {
    // Solo-a-node-to-the-main-viewer (`ViewerSource: {kind:'node'}`): resolve
    // which layer owns the node, then delegate to that layer's own graph —
    // same isolation strategy as `previewLayerId` just below, one level
    // deeper. Was previously unhandled here (only `compileGraph` honored
    // `previewNodeId`), so soloing a node to the main viewer silently fell
    // through to the full composite instead of showing that node's output.
    const owner = findLayerOwningNode(doc.layerStack.layers, opts.previewNodeId);
    if (!owner) {
      return {
        target: 'glsl-es',
        vertex: VERTEX_SHADER,
        fragment: '',
        uniforms: [],
        diagnostics: [
          {
            level: 'error',
            message: `No node "${opts.previewNodeId}" in document "${doc.id}".`,
          },
        ],
      };
    }
    return compileGraph(owner.graph, { ...opts, subGraphs: doc.subGraphs }, registry);
  }

  if (opts?.previewLayerId) {
    const layer = findLayer(doc.layerStack.layers, opts.previewLayerId);
    if (!layer) {
      return {
        target: 'glsl-es',
        vertex: VERTEX_SHADER,
        fragment: '',
        uniforms: [],
        diagnostics: [
          {
            level: 'error',
            message: `No layer "${opts.previewLayerId}" in document "${doc.id}".`,
          },
        ],
      };
    }
    // Isolated single-layer preview bypasses compositing entirely, per
    // `CompileOptions.previewLayerId`'s contract ("preview only this layer").
    const { previewLayerId: _drop, ...rest } = opts;
    return compileGraph(layer.graph, { ...rest, subGraphs: doc.subGraphs }, registry);
  }

  const handle = createEmitSink();
  const relativeSourceMap: Array<{ line: number; nodeId: string }> = [];
  const compositeVar = foldStack(doc.layerStack.layers, handle, registry, doc.subGraphs, relativeSourceMap);

  handle.sink.emit(`gl_FragColor = vec4(${compositeVar}, 1.0);`);

  const uniformDecls = handle.uniforms.map((u) => `uniform ${typeName(u.type)} ${u.name};`);
  const fragment = assembleFragment(uniformDecls, handle.body, handle.preludes);
  const offset = headerLineCount(uniformDecls, handle.preludes);
  const sourceMap = relativeSourceMap.map(({ line, nodeId }) => ({ line: offset + line + 1, nodeId }));

  return {
    target: 'glsl-es',
    vertex: VERTEX_SHADER,
    fragment,
    uniforms: handle.uniforms,
    diagnostics: handle.diagnostics,
    sourceMap,
  };
}

export const glslEsBackend: ShaderBackend = {
  id: 'glsl-es',
  target: 'glsl-es',
  headless: true,
  compileGraph: (graph, opts) => compileGraph(graph, opts),
  compileDocument: (doc, opts) => compileDocument(doc, opts),
};

// Side effect: register into the shared `backends` singleton on import, same
// pattern as `registerStarterNodes` in `nodes/definitions/index.ts`. `Map.set`
// makes re-import idempotent (last registration wins, harmlessly).
backends.register(glslEsBackend);
