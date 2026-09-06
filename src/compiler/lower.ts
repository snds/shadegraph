// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Lowering pass (backend-neutral)
// ───────────────────────────────────────────────────────────────────────────
// Resolves a `ShaderGraph` from its output node backwards into a deterministic,
// acyclic emission order, then dispatches each node's `NodeEmitter` through the
// shared `EmitContext` contract. This file knows nothing about any particular
// shading language: everything language-specific (the actual coercion
// expressions, default-value literal syntax, the target enum) is supplied by
// the caller as `LowerHooks`. A backend (e.g. `backends/glsl-es.ts`) owns that
// vocabulary; this file owns graph topology and dispatch order only. That
// split is what lets a second backend (wgsl, tsl) reuse this pass unchanged.
// ═══════════════════════════════════════════════════════════════════════════

import {
  SOCKET_COMPATIBILITY,
  type ScalarOrVector,
  type ShaderGraph,
  type SocketType,
} from '../model/document';
import type { NodeRegistry } from '../nodes/registry';
import type { Diagnostic, EmitContext, TargetLang, UniformSpec } from './backend';

// ── Emission sink ────────────────────────────────────────────────────────────
// The mutable, language-neutral bits every `EmitContext` needs: a temp-name
// counter, a deduped uniform table, an ordered statement buffer, and a
// diagnostics sink. Shared across every graph compiled into one program (e.g.
// every layer in a document composite) so names and uniforms never collide.
export interface EmitSink {
  temp(prefix?: string): string;
  uniform(spec: UniformSpec): string;
  emit(line: string): void;
  diag(d: Diagnostic): void;
}

export interface EmitSinkHandle {
  sink: EmitSink;
  body: string[];
  uniforms: UniformSpec[];
  diagnostics: Diagnostic[];
}

/** Fresh, empty sink. `uniforms`/`body`/`diagnostics` are live references —
 *  read them any time; they mutate as `sink` is used. */
export function createEmitSink(): EmitSinkHandle {
  let counter = 0;
  const body: string[] = [];
  const diagnostics: Diagnostic[] = [];
  const uniforms: UniformSpec[] = [];
  const uniformNames = new Set<string>();

  const sink: EmitSink = {
    temp(prefix = 't') {
      return `${prefix}_${counter++}`;
    },
    uniform(spec) {
      if (!uniformNames.has(spec.name)) {
        uniformNames.add(spec.name);
        uniforms.push(spec);
      }
      return spec.name;
    },
    emit(line) {
      body.push(line);
    },
    diag(d) {
      diagnostics.push(d);
    },
  };

  return { sink, body, uniforms, diagnostics };
}

// ── Backend hooks ────────────────────────────────────────────────────────────
// The language-specific vocabulary a backend supplies. `coerce` returns
// `undefined` when it has genuinely no conversion for a pair (which should
// never happen for a `SOCKET_COMPATIBILITY`-permitted pair — see the backend's
// own coercion table); the resolver falls back to passing the value through
// unconverted and raises a diagnostic so the gap is visible, not silent.
export interface LowerHooks {
  target: TargetLang;
  /** Convert an already-emitted expression of type `from` into type `to`. */
  coerce(expr: string, from: SocketType, to: SocketType): string | undefined;
  /** Render an unconnected input socket's default value as a language literal. */
  literal(value: ScalarOrVector | string | undefined, type: SocketType): string;
}

// ── Topology: reachability, dead-node pruning, cycle detection ─────────────
export interface ResolveOrderResult {
  /** Dependency-first node ids, live and acyclic — safe to dispatch in order. */
  order: string[];
  /** Nodes not reachable backwards from the output node. Excluded, not an error. */
  pruned: string[];
  /** Reachable nodes excluded because they sit in a dependency cycle. */
  cyclic: string[];
  diagnostics: Diagnostic[];
}

/** Walks `graph` backwards from `outputNodeId`, topologically sorts the
 *  reachable subgraph (Kahn's algorithm, deterministic id-order tie-break),
 *  and reports anything left over as a cycle — never throws. Pure: no node
 *  registry, no emission. */
export function resolveOrder(graph: ShaderGraph): ResolveOrderResult {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));

  if (!nodeIds.has(graph.outputNodeId)) {
    return {
      order: [],
      pruned: [...nodeIds],
      cyclic: [],
      diagnostics: [
        {
          level: 'error',
          message: `Graph output node "${graph.outputNodeId}" does not exist in this graph.`,
        },
      ],
    };
  }

  // Reachability: walk backwards (target -> source) from the output.
  const reachable = new Set<string>([graph.outputNodeId]);
  const stack: string[] = [graph.outputNodeId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const edge of graph.edges) {
      if (
        edge.target.node === current &&
        nodeIds.has(edge.source.node) &&
        !reachable.has(edge.source.node)
      ) {
        reachable.add(edge.source.node);
        stack.push(edge.source.node);
      }
    }
  }
  const pruned = [...nodeIds].filter((id) => !reachable.has(id));

  // Kahn's algorithm over the reachable subgraph only.
  const subEdges = graph.edges.filter(
    (e) => reachable.has(e.source.node) && reachable.has(e.target.node),
  );
  const indegree = new Map<string, number>();
  for (const id of reachable) indegree.set(id, 0);
  for (const e of subEdges) indegree.set(e.target.node, (indegree.get(e.target.node) ?? 0) + 1);

  const ready = [...reachable].filter((id) => indegree.get(id) === 0).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    ready.sort();
    const current = ready.shift() as string;
    order.push(current);
    for (const e of subEdges) {
      if (e.source.node !== current) continue;
      const remaining = (indegree.get(e.target.node) ?? 0) - 1;
      indegree.set(e.target.node, remaining);
      if (remaining === 0) ready.push(e.target.node);
    }
  }

  const emitted = new Set(order);
  const cyclic = [...reachable].filter((id) => !emitted.has(id));
  const diagnostics: Diagnostic[] = cyclic.map((id) => ({
    level: 'error',
    message: `Node "${id}" is part of a dependency cycle and was excluded from compilation.`,
    nodeId: id,
  }));

  return { order, pruned, cyclic, diagnostics };
}

// ── Per-node dispatch ────────────────────────────────────────────────────────
export interface LowerGraphResult {
  /** The expression the graph's output node emitted, if it could be resolved. */
  outputExpr?: string;
  order: string[];
  pruned: string[];
  cyclic: string[];
}

/** Resolves the emitted expression for one input socket, walking its edge (if
 *  any), validating the connection against `SOCKET_COMPATIBILITY`, and
 *  applying `hooks.coerce` when the source and target types differ. Falls back
 *  to the socket's own default literal when unconnected, or a diagnostic +
 *  literal when the graph data is malformed (unknown node/socket, dangling
 *  edge to a pruned/cyclic source). */
function makeInputResolver(
  graph: ShaderGraph,
  registry: NodeRegistry,
  hooks: LowerHooks,
  sink: EmitSink,
  outputCache: Map<string, string>,
): EmitContext['input'] {
  return (nodeId: string, socket: string): string => {
    const node = graph.nodes.find((n) => n.id === nodeId);
    const def = node ? registry.get(node.type) : undefined;
    const socketDef = def?.inputs.find((s) => s.id === socket);

    if (!socketDef) {
      sink.diag({
        level: 'error',
        message: `Unknown input socket "${socket}" on node "${nodeId}".`,
        nodeId,
      });
      return hooks.literal(undefined, 'float');
    }

    const edge = graph.edges.find((e) => e.target.node === nodeId && e.target.socket === socket);
    if (!edge) {
      return hooks.literal(socketDef.defaultValue, socketDef.type);
    }

    const sourceNode = graph.nodes.find((n) => n.id === edge.source.node);
    const sourceDef = sourceNode ? registry.get(sourceNode.type) : undefined;
    const sourceSocketDef = sourceDef?.outputs.find((s) => s.id === edge.source.socket);
    const sourceType = sourceSocketDef?.type;
    const sourceExpr = outputCache.get(edge.source.node);

    if (sourceExpr === undefined || !sourceType) {
      sink.diag({
        level: 'error',
        message: `Edge "${edge.id}" source node "${edge.source.node}" produced no output (pruned, cyclic, or malformed); using the default for "${socket}" instead.`,
        edgeId: edge.id,
        nodeId,
      });
      return hooks.literal(socketDef.defaultValue, socketDef.type);
    }

    if (sourceType === socketDef.type) return sourceExpr;

    if (!SOCKET_COMPATIBILITY[socketDef.type]?.includes(sourceType)) {
      sink.diag({
        level: 'error',
        message: `Edge "${edge.id}" connects incompatible types ${sourceType} -> ${socketDef.type}; using the default for "${socket}" instead.`,
        edgeId: edge.id,
        nodeId,
      });
      return hooks.literal(socketDef.defaultValue, socketDef.type);
    }

    const coerced = hooks.coerce(sourceExpr, sourceType, socketDef.type);
    if (coerced === undefined) {
      sink.diag({
        level: 'warning',
        message: `No ${hooks.target} coercion registered for ${sourceType} -> ${socketDef.type} on edge "${edge.id}"; passing the value through unconverted.`,
        edgeId: edge.id,
        nodeId,
      });
      return sourceExpr;
    }
    return coerced;
  };
}

/** Lowers one graph: resolves order, then dispatches each live node's
 *  `NodeDefinition.emit[hooks.target]` through an `EmitContext` backed by
 *  `sink`. Bypassed nodes skip their emitter entirely and pass their primary
 *  input straight through (coerced if the bypass's input/output types
 *  differ), per `NodeDefinition.bypass`. Never throws — every failure mode
 *  becomes a `Diagnostic` on `sink` and a safe literal fallback so downstream
 *  nodes still get syntactically valid source. */
export function lowerGraph(
  graph: ShaderGraph,
  registry: NodeRegistry,
  hooks: LowerHooks,
  sink: EmitSink,
): LowerGraphResult {
  const topo = resolveOrder(graph);
  for (const d of topo.diagnostics) sink.diag(d);

  const outputCache = new Map<string, string>();
  const input = makeInputResolver(graph, registry, hooks, sink, outputCache);

  for (const nodeId of topo.order) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) continue; // unreachable: nodeId came from this graph's own node list
    const def = registry.get(node.type);

    if (!def) {
      sink.diag({
        level: 'error',
        message: `Unknown node type "${node.type}" (node "${nodeId}"); no ${hooks.target} definition registered.`,
        nodeId,
      });
      outputCache.set(nodeId, hooks.literal(undefined, 'float'));
      continue;
    }

    if (node.bypassed && def.bypass) {
      const inSocket = def.inputs.find((s) => s.id === def.bypass?.input);
      const outSocket = def.outputs.find((s) => s.id === def.bypass?.output);
      if (!inSocket || !outSocket) {
        sink.diag({
          level: 'error',
          message: `Node "${nodeId}" (${node.type}) declares an invalid bypass mapping.`,
          nodeId,
        });
        outputCache.set(nodeId, hooks.literal(undefined, 'float'));
        continue;
      }
      const resolved = input(nodeId, inSocket.id);
      const passthrough =
        inSocket.type === outSocket.type
          ? resolved
          : (hooks.coerce(resolved, inSocket.type, outSocket.type) ?? resolved);
      outputCache.set(nodeId, passthrough);
      continue;
    }

    const emitter = def.emit[hooks.target];
    if (!emitter) {
      sink.diag({
        level: 'error',
        message: `Node "${node.type}" has no ${hooks.target} emitter (node "${nodeId}").`,
        nodeId,
      });
      const outType = def.outputs[0]?.type ?? 'float';
      outputCache.set(nodeId, hooks.literal(undefined, outType));
      continue;
    }

    const ctx: EmitContext = {
      target: hooks.target,
      temp: sink.temp,
      uniform: sink.uniform,
      emit: sink.emit,
      diag: sink.diag,
      input,
    };
    outputCache.set(nodeId, emitter(node, ctx));
  }

  return {
    outputExpr: outputCache.get(graph.outputNodeId),
    order: topo.order,
    pruned: topo.pruned,
    cyclic: topo.cyclic,
  };
}
