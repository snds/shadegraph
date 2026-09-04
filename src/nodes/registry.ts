// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Node Registry
// ───────────────────────────────────────────────────────────────────────────
// The catalogue of node *types* the editor can create. A definition is pure
// metadata (sockets, params, category) plus per-backend emitters. Adding a node
// = adding one definition; it immediately appears in the "add node" palette,
// validates connections, exposes params to the inspector, and compiles to every
// registered backend that supplies an emitter.
//
// Categories seed the palette: input · math · noise · color · sdf · lighting ·
// texture · util · legion (imported GLSL chunks) · output.
// ═══════════════════════════════════════════════════════════════════════════

import type { Socket, NodeParam, SocketType } from '../model/document';
import type { NodeEmitter, TargetLang } from '../compiler/backend';

export type NodeCategory =
  | 'input'
  | 'math'
  | 'noise'
  | 'color'
  | 'sdf'
  | 'lighting'
  | 'texture'
  | 'util'
  | 'legion'
  | 'output';

export interface NodeDefinition {
  type: string; // e.g. "math.mix"
  category: NodeCategory;
  title: string;
  description?: string;
  inputs: Omit<Socket, 'direction'>[];
  outputs: Omit<Socket, 'direction'>[];
  /** Default params instantiated on the node when created. */
  params?: NodeParam[];
  /** Can the runtime render a meaningful per-node thumbnail? (inputs like a raw
   *  sampler can; a pure `bool` constant is not worth a preview). */
  previewable?: boolean;
  /** Language emitters. A node need not support every backend; missing ones
   *  produce a diagnostic when that target is selected. */
  emit: Partial<Record<TargetLang, NodeEmitter>>;
  /** Primary in/out sockets used for bypass pass-through. */
  bypass?: { input: string; output: string };
}

export class NodeRegistry {
  private defs = new Map<string, NodeDefinition>();
  register(def: NodeDefinition) {
    if (this.defs.has(def.type)) {
      throw new Error(`Duplicate node type "${def.type}"`);
    }
    this.defs.set(def.type, def);
  }
  get(type: string): NodeDefinition | undefined {
    return this.defs.get(type);
  }
  all(): NodeDefinition[] {
    return [...this.defs.values()];
  }
  byCategory(): Record<NodeCategory, NodeDefinition[]> {
    const out = {} as Record<NodeCategory, NodeDefinition[]>;
    for (const d of this.defs.values()) (out[d.category] ??= []).push(d);
    return out;
  }
}

export const nodes = new NodeRegistry();

/** Socket helpers so definitions read cleanly. */
export const inp = (id: string, label: string, type: SocketType, def?: Socket['defaultValue']) =>
  ({ id, label, type, defaultValue: def }) as Omit<Socket, 'direction'>;
export const out = (id: string, label: string, type: SocketType) =>
  ({ id, label, type }) as Omit<Socket, 'direction'>;
