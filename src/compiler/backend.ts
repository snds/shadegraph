// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Compiler Backend Contract
// ───────────────────────────────────────────────────────────────────────────
// Lowers the backend-neutral ShaderDocument into an actual runnable program for
// a specific shading language. This is the abstraction that makes ShadeGraph
// "scale for any WebGPU work": add a backend, and every existing graph compiles
// to it. Day-one targets:
//
//   • glsl-es  — GLSL ES 1.0 (varying/gl_FragColor). Drives Legion *today*.
//   • wgsl     — raw WGSL for vgpu / native WebGPU.
//   • tsl      — Three.js TSL node material (WebGPURenderer) for a Three-native
//                path that Legion can adopt as it moves off r171 GLSL.
//
// A backend is a pure function of (document, target-options) → CompiledProgram.
// No GPU device is required to *compile* (headless/CI/agentic use per vgpu);
// the preview runtime is what binds the result to a device.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShaderDocument, ShaderGraph, ShaderNode, SocketType } from '../model/document';

export type TargetLang = 'glsl-es' | 'glsl3' | 'wgsl' | 'tsl';

export interface UniformSpec {
  name: string;
  type: SocketType;
  /** Back-reference to the NodeParam / blackboard entry that owns it. */
  paramId?: string;
  default?: unknown;
}

export interface Diagnostic {
  level: 'error' | 'warning' | 'info';
  message: string;
  nodeId?: string;
  edgeId?: string;
}

/** Result of compiling a whole document (layer stack composited). */
export interface CompiledProgram {
  target: TargetLang;
  /** For glsl-es/glsl3: vertex + fragment source. */
  vertex?: string;
  fragment?: string;
  /** For wgsl: a single module string. For tsl: a serialised node tree the
   *  runtime rehydrates into a NodeMaterial. */
  module?: string;
  tsl?: unknown;
  uniforms: UniformSpec[];
  diagnostics: Diagnostic[];
  /** Source map: output line → nodeId, for click-to-source in the code panel. */
  sourceMap?: Array<{ line: number; nodeId: string }>;
}

/** Per-node emission: how a single node contributes source in a target lang.
 *  Registered per node-type per backend, so node definitions stay data and the
 *  language-specific text lives beside the backend. */
export interface EmitContext {
  /** Emit a fresh unique identifier for a temp/var. */
  temp(prefix?: string): string;
  /** Resolve the emitted expression for an input socket (walks the edge). */
  input(nodeId: string, socket: string): string;
  /** Declare a uniform, deduped. Returns the in-shader name. */
  uniform(spec: UniformSpec): string;
  /** Append a statement to the current function body. */
  emit(line: string): void;
  diag(d: Diagnostic): void;
  target: TargetLang;
}

export type NodeEmitter = (node: ShaderNode, ctx: EmitContext) => string; // returns output expr

export interface ShaderBackend {
  id: string;
  target: TargetLang;
  /** True if this backend can run without a GPU device (headless compile). */
  headless: boolean;
  /** Compile a single-graph layer (used for per-node/layer previews too). */
  compileGraph(graph: ShaderGraph, opts?: CompileOptions): CompiledProgram;
  /** Compile the full document: every enabled layer + blend composite. */
  compileDocument(doc: ShaderDocument, opts?: CompileOptions): CompiledProgram;
}

export interface CompileOptions {
  /** Stop the graph at this node and output it directly — powers per-node
   *  preview thumbnails and Nuke-style "solo this node to the viewer". */
  previewNodeId?: string;
  /** Preview only this layer in isolation. */
  previewLayerId?: string;
  /** Emit debug annotations / source map. */
  debug?: boolean;
  precision?: 'highp' | 'mediump';
}

/** Backends self-register here; the UI picks a target and the same document
 *  compiles to all registered ones. */
export class BackendRegistry {
  private backends = new Map<TargetLang, ShaderBackend>();
  register(b: ShaderBackend) {
    this.backends.set(b.target, b);
  }
  get(target: TargetLang): ShaderBackend {
    const b = this.backends.get(target);
    if (!b) throw new Error(`No ShadeGraph backend registered for target "${target}"`);
    return b;
  }
  targets(): TargetLang[] {
    return [...this.backends.keys()];
  }
}

export const backends = new BackendRegistry();
