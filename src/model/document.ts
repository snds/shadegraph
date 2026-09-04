// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Document Model
// ───────────────────────────────────────────────────────────────────────────
// The single durable artifact of the whole tool. Everything else (the React
// Flow view, the compiler backends, the preview runtime, the Legion adapter)
// is a *projection* of this model. It is intentionally:
//
//   • Pure data      — no framework types, no GPU handles, no DOM. Serializes
//                       to JSON and round-trips losslessly.
//   • Backend-neutral — describes intent (nodes, params, layers), never a
//                       specific shading language. Compiler backends lower it
//                       to GLSL ES / GLSL3 / WGSL / TSL.
//   • View-neutral    — node positions live here, but nothing about *how* the
//                       editor draws them. Swap React Flow for a canvas
//                       renderer without touching this file.
//
// Two coordinated surfaces, mirroring Unreal Material Layers + Substance:
//   1. LayerStack — the Photoshop-like vertical stack of shader layers.
//   2. ShaderGraph — the node graph *inside* one layer (or a shared subgraph).
// ═══════════════════════════════════════════════════════════════════════════

/** Semver of the document schema itself, for migrations. */
export const SCHEMA_VERSION = '0.1.0' as const;

// ── Socket / value typing ──────────────────────────────────────────────────
// Color-coded, validated connection types. `color` is a semantic alias of
// vec3/vec4 so the UI can render a swatch and the compiler can apply colour-
// space intent; `normal` is a semantic vec3 in tangent/world space.
export type SocketType =
  | 'float'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'color'
  | 'bool'
  | 'int'
  | 'sampler2D'
  | 'cubemap'
  | 'normal';

/** Which socket types may connect into which. Superset rules live in the
 *  compiler; this is the fast editor-side validation table. */
export const SOCKET_COMPATIBILITY: Record<SocketType, SocketType[]> = {
  float: ['float', 'int'],
  vec2: ['vec2'],
  vec3: ['vec3', 'color', 'normal'],
  vec4: ['vec4', 'color'],
  color: ['vec3', 'vec4', 'color'],
  bool: ['bool'],
  int: ['int', 'float'],
  sampler2D: ['sampler2D'],
  cubemap: ['cubemap'],
  normal: ['vec3', 'normal'],
};

export type SocketDirection = 'in' | 'out';

export interface Socket {
  /** Stable within a node (e.g. "a", "uv", "color"). */
  id: string;
  label: string;
  type: SocketType;
  direction: SocketDirection;
  /** Fallback literal used when no edge is connected (inputs only). */
  defaultValue?: ScalarOrVector;
}

export type ScalarOrVector =
  | number
  | boolean
  | [number, number]
  | [number, number, number]
  | [number, number, number, number];

// ── Exposed parameters (the "blackboard" / uniforms) ───────────────────────
// A node exposes params that become uniforms in the compiled shader and dials
// in the inspector. This is the bridge to Legion's uniform-driven materials
// and its per-archetype lab-store.
export type ParamUiHint =
  | 'slider'
  | 'number'
  | 'color'
  | 'toggle'
  | 'select'
  | 'texture'
  | 'vector';

export interface NodeParam {
  id: string;
  label: string;
  type: SocketType;
  value: ScalarOrVector | string; // string = asset id for texture/cubemap
  ui: ParamUiHint;
  min?: number;
  max?: number;
  step?: number;
  options?: string[]; // for `select`
  /** When true this param is promoted to the document-level blackboard and can
   *  be exported to Legion's lab-store as a live dial. */
  exposed?: boolean;
  /** Maps this param to a target uniform name when the doc drives an existing
   *  material (e.g. Legion's `uNormalStrength`). */
  bindUniform?: string;
}

// ── Nodes ──────────────────────────────────────────────────────────────────
export interface ShaderNode {
  id: string;
  /** Key into the NodeRegistry (e.g. "math.mix", "noise.fbm", "input.uv",
   *  "legion.chunk.GLSL_TERRAIN", "output.surface"). */
  type: string;
  title?: string; // user override of the registry title
  position: { x: number; y: number };
  params: NodeParam[];
  /** Bypass: the node is skipped and its primary input passes through to its
   *  primary output (Blender mute / Nuke disable). */
  bypassed?: boolean;
  /** Per-node preview thumbnail on/off (perf + focus control). */
  previewEnabled?: boolean;
  collapsed?: boolean;
  /** Optional group/frame membership for organising large graphs. */
  groupId?: string;
}

export interface Edge {
  id: string;
  source: { node: string; socket: string };
  target: { node: string; socket: string };
}

/** A comment frame / group box for organising large diagrams. */
export interface NodeGroup {
  id: string;
  title: string;
  color?: string;
  bounds: { x: number; y: number; w: number; h: number };
}

export interface ShaderGraph {
  nodes: ShaderNode[];
  edges: Edge[];
  groups?: NodeGroup[];
  /** The node whose output represents this graph's result (feeds a layer). */
  outputNodeId: string;
}

// ── Subgraphs (reuse) ──────────────────────────────────────────────────────
// Unity sub-graphs / Unreal material functions / Houdini HDAs. A reusable graph
// with a typed interface, referenced by an "instance" node in a parent graph.
export interface SubGraph {
  id: string;
  name: string;
  inputs: Socket[]; // exposed input sockets
  outputs: Socket[]; // exposed output sockets
  graph: ShaderGraph;
}

// ── Layer stack ────────────────────────────────────────────────────────────
export type BlendMode =
  | 'normal'
  | 'add'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'softLight'
  | 'subtract'
  | 'mix' // straight opacity lerp
  | 'height' // height-based blend (terrain/biome masking)
  | 'custom'; // blend defined by the layer's own blend graph

export interface ShaderLayer {
  id: string;
  name: string;
  /** The graph that produces this layer's contribution. */
  graph: ShaderGraph;
  blend: BlendMode;
  /** 0..1. */
  opacity: number;
  /** Participates in the compiled output (Photoshop layer eye ≈ enabled). */
  enabled: boolean;
  /** Rendered in the editor preview even if disabled — lets you inspect a
   *  layer in isolation without contributing it to the composite. */
  visible: boolean;
  /** Solo: when any layer is soloed, only soloed layers composite. */
  soloed?: boolean;
  /** Optional per-layer mask graph. */
  maskGraphId?: string;
}

export interface LayerStack {
  /** Bottom-to-top compositing order == array order (index 0 = base). */
  layers: ShaderLayer[];
  activeLayerId?: string;
}

// ── Document ───────────────────────────────────────────────────────────────
/** The kind of surface this document targets, so previews use the right
 *  geometry/lighting rig (a planet sphere vs a full-screen quad vs a mesh). */
export type PreviewRig = 'sphere' | 'fullscreen' | 'mesh' | 'skybox';

export interface ShaderDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  name: string;
  /** Free-form tag for Legion archetype mapping (rocky/continuum/star/…). */
  archetype?: string;
  previewRig: PreviewRig;
  layerStack: LayerStack;
  subGraphs: SubGraph[];
  /** Document-level exposed params (the blackboard) aggregated from nodes
   *  plus any global dials. Source of truth for Legion lab-store export. */
  blackboard: NodeParam[];
  meta: {
    created: string;
    updated: string;
    author?: string;
    /** Which backends this doc has been validated to compile against. */
    validatedTargets?: string[];
  };
}

/** Create an empty, valid document. */
export function emptyDocument(name = 'Untitled'): ShaderDocument {
  const now = new Date().toISOString();
  const outId = 'output';
  const baseGraph: ShaderGraph = {
    nodes: [
      {
        id: outId,
        type: 'output.surface',
        position: { x: 640, y: 200 },
        params: [],
        previewEnabled: true,
      },
    ],
    edges: [],
    outputNodeId: outId,
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name,
    previewRig: 'sphere',
    layerStack: {
      layers: [
        {
          id: crypto.randomUUID(),
          name: 'Base',
          graph: baseGraph,
          blend: 'normal',
          opacity: 1,
          enabled: true,
          visible: true,
        },
      ],
    },
    subGraphs: [],
    blackboard: [],
    meta: { created: now, updated: now },
  };
}
