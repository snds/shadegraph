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
//
// Subgraph instances (`src/model/subgraph.ts`) are INLINED here, not compiled
// as a separate program: a `subgraph.instance` node's referenced `SubGraph.graph`
// is recursively dispatched into the SAME `EmitSink` (so its statements land in
// the same body, sharing the temp-name counter and uniform table), with the
// instance's real incoming edges substituted for the subgraph's exposed input
// sockets. A subgraph that (directly or transitively) instances itself would
// recurse forever without a guard; `expandingSubGraphIds` tracks the chain of
// subgraphs currently being inlined and turns a repeat into a `Diagnostic`
// instead of a stack overflow — see `dispatchSubGraphInstance`.
// ═══════════════════════════════════════════════════════════════════════════

import {
  SOCKET_COMPATIBILITY,
  type ScalarOrVector,
  type ShaderGraph,
  type ShaderNode,
  type SocketType,
  type SubGraph,
} from '../model/document';
import { findSubGraph, isSubGraphInstanceNode, subGraphInstanceSocket } from '../model/subgraph';
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

/** Walks `graph` backwards from `rootNodeIds` (defaults to `[graph.outputNodeId]`,
 *  the original single-root behaviour), topologically sorts the reachable
 *  subgraph (Kahn's algorithm, deterministic id-order tie-break), and reports
 *  anything left over as a cycle — never throws. Pure: no node registry, no
 *  emission.
 *
 *  The optional multi-root form is what lets a `SubGraph`'s internal graph be
 *  resolved for inlining: an extracted subgraph can expose SEVERAL independent
 *  output sockets, each pointing at a different internal node (see
 *  `src/model/subgraph.ts`'s `${internalNodeId}:${internalSocketId}` id
 *  convention), and `graph.outputNodeId` on that internal graph is just a
 *  schema placeholder (not a real "the" result) — so reachability must be
 *  seeded from every exposed output's internal node, not from it alone. */
export function resolveOrder(graph: ShaderGraph, rootNodeIds?: string[]): ResolveOrderResult {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const roots = rootNodeIds ?? [graph.outputNodeId];
  const validRoots = roots.filter((id) => nodeIds.has(id));
  const missingRootDiagnostics: Diagnostic[] = roots
    .filter((id) => !nodeIds.has(id))
    .map((id) => ({
      level: 'error',
      message:
        rootNodeIds === undefined
          ? `Graph output node "${id}" does not exist in this graph.`
          : `Referenced root node "${id}" does not exist in this graph.`,
    }));

  if (validRoots.length === 0) {
    return { order: [], pruned: [...nodeIds], cyclic: [], diagnostics: missingRootDiagnostics };
  }

  // Reachability: walk backwards (target -> source) from every root.
  const reachable = new Set<string>(validRoots);
  const stack: string[] = [...validRoots];
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
  const diagnostics: Diagnostic[] = [
    ...missingRootDiagnostics,
    ...cyclic.map((id) => ({
      level: 'error' as const,
      message: `Node "${id}" is part of a dependency cycle and was excluded from compilation.`,
      nodeId: id,
    })),
  ];

  return { order, pruned, cyclic, diagnostics };
}

// ── Subgraph inlining helpers ────────────────────────────────────────────────

/** `"mul1:result"` -> `{ nodeId: "mul1", socketId: "result" }`. A `SubGraph`
 *  interface socket auto-detected by `extractSubGraph` always has this shape
 *  (node ids never contain `:`); a socket added by hand later via the
 *  interface editor might not, and there is then no internal node to recover —
 *  callers treat `undefined` as "unmapped", not a crash. */
function parseInternalSocketPointer(socketId: string): { nodeId: string; socketId: string } | undefined {
  const idx = socketId.indexOf(':');
  if (idx === -1) return undefined;
  return { nodeId: socketId.slice(0, idx), socketId: socketId.slice(idx + 1) };
}

/** Shared, mutable state threaded through one whole `lowerGraph` call,
 *  including every subgraph it recursively inlines — this is what makes
 *  nested subgraph statements land in the same body/temp-counter/uniform
 *  table/diagnostics/source-map as everything else (true inlining, not a
 *  separately-compiled nested program). */
interface LowerRunState {
  registry: NodeRegistry;
  hooks: LowerHooks;
  sink: EmitSink;
  subGraphs: SubGraph[];
  sourceMap: Array<{ line: number; nodeId: string }>;
  emittedLines: { count: number };
  /** Ids of `SubGraph`s currently being inlined, outermost-first — a repeat
   *  means a subgraph (directly or transitively) instances itself. */
  expanding: string[];
}

// ── Per-node dispatch ────────────────────────────────────────────────────────
export interface LowerGraphResult {
  /** The expression the graph's output node emitted, if it could be resolved. */
  outputExpr?: string;
  order: string[];
  pruned: string[];
  cyclic: string[];
  /** Which node produced each statement `sink.emit()`ed during this call,
   *  keyed by a 0-based index into JUST this call's own emissions (not the
   *  shared sink's absolute body position, since one sink can be reused
   *  across several `lowerGraph` calls — e.g. one per document layer). The
   *  caller (a backend) knows its own body offset and header-line count, so
   *  it converts this into an absolute file line for `CompiledProgram.sourceMap`
   *  (click-to-source in the code panel). Nodes inlined from a subgraph
   *  instance appear here too, keyed by their own (internal) node id. */
  sourceMap: Array<{ line: number; nodeId: string }>;
}

/** Resolves the emitted expression for one input socket, walking its edge (if
 *  any), validating the connection against `SOCKET_COMPATIBILITY`, and
 *  applying `hooks.coerce` when the source and target types differ. Falls back
 *  to the socket's own default literal when unconnected, or a diagnostic +
 *  literal when the graph data is malformed (unknown node/socket, dangling
 *  edge to a pruned/cyclic source).
 *
 *  A subgraph-instance node is special-cased on BOTH ends: as the socket's
 *  OWNER its socket definition is resolved live from the referenced
 *  `SubGraph.inputs`/`outputs` (`subGraphInstanceSocket`) instead of the node
 *  registry (it is never registered there — see `src/model/subgraph.ts`); as
 *  the socket's SOURCE its emitted expression comes from `outputSocketCache`
 *  (per-socket, since one instance can expose several outputs) rather than
 *  `outputCache` (per-node, the single-output convention every registered
 *  node type follows today).
 *
 *  `overrides`, when supplied, is consulted FIRST for the exact
 *  `${nodeId}:${socket}` key: this is how an inlined subgraph's internal graph
 *  gets the instance's real incoming edges substituted for its own exposed
 *  input sockets (see `dispatchSubGraphInstance`) — those sockets have no edge
 *  of their own inside `SubGraph.graph` (extraction strips crossing-in edges
 *  out into the interface), so without the override they would silently
 *  resolve to their default literal instead of the caller's actual value. */
function makeInputResolver(
  graph: ShaderGraph,
  state: LowerRunState,
  outputCache: Map<string, string>,
  outputSocketCache: Map<string, string>,
  overrides?: Map<string, string>,
): EmitContext['input'] {
  const { registry, hooks, sink, subGraphs } = state;
  return (nodeId: string, socket: string): string => {
    const overrideKey = `${nodeId}:${socket}`;
    if (overrides?.has(overrideKey)) return overrides.get(overrideKey) as string;

    const node = graph.nodes.find((n) => n.id === nodeId);
    const socketDef =
      node && isSubGraphInstanceNode(node)
        ? subGraphInstanceSocket(subGraphs, node, socket, 'in')
        : (registry.get(node?.type ?? '')?.inputs.find((s) => s.id === socket) ?? undefined);

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
    const sourceSocketDef =
      sourceNode && isSubGraphInstanceNode(sourceNode)
        ? subGraphInstanceSocket(subGraphs, sourceNode, edge.source.socket, 'out')
        : registry.get(sourceNode?.type ?? '')?.outputs.find((s) => s.id === edge.source.socket);
    const sourceType = sourceSocketDef?.type;
    const sourceExpr =
      outputSocketCache.get(`${edge.source.node}:${edge.source.socket}`) ??
      outputCache.get(edge.source.node);

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

/** Inlines one subgraph-instance node: resolves the subgraph's exposed inputs
 *  from the instance's REAL incoming edges in `outerGraph` (via `outerInput`,
 *  the outer graph's own resolver), recursively dispatches `SubGraph.graph`
 *  into the same `state` (same sink, so its statements land right in this
 *  call's body), then publishes each exposed output's resolved expression
 *  into `outerOutputSocketCache` keyed by `${instanceNodeId}:${outputSocketId}`
 *  — exactly the key `makeInputResolver` looks up when something downstream in
 *  `outerGraph` reads that socket.
 *
 *  Guards against a subgraph that (directly or transitively, through nested
 *  instances) references itself: `state.expanding` is the chain of subgraph
 *  ids currently being inlined, outermost first. Finding this instance's
 *  target already in that chain means expanding it would recurse forever, so
 *  it is reported as one `Diagnostic` and skipped — never recursed into.
 *  Because `state.subGraphs` is finite and a cycle is only ever declared when
 *  an id repeats, a non-cyclic instance chain is always finite too: this is
 *  what makes the guard a proof of termination, not just a spot fix. */
function dispatchSubGraphInstance(
  node: ShaderNode,
  outerGraph: ShaderGraph,
  outerInput: EmitContext['input'],
  outerOutputCache: Map<string, string>,
  outerOutputSocketCache: Map<string, string>,
  state: LowerRunState,
): void {
  void outerGraph; // resolution happens through `outerInput`; kept for signature symmetry/future use
  const subGraph = findSubGraph(state.subGraphs, node.subGraphId);
  if (!subGraph) {
    state.sink.diag({
      level: 'error',
      message: `Subgraph instance "${node.id}" references unknown subgraph "${node.subGraphId ?? '(none)'}".`,
      nodeId: node.id,
    });
    return;
  }

  if (state.expanding.includes(subGraph.id)) {
    state.sink.diag({
      level: 'error',
      message:
        `Subgraph "${subGraph.name}" (${subGraph.id}) references itself, directly or ` +
        `transitively, forming a cycle: ${[...state.expanding, subGraph.id].join(' -> ')}. ` +
        `Instance "${node.id}" was skipped to avoid infinite recursion.`,
      nodeId: node.id,
    });
    return;
  }

  // The actual "inlining" substitution: each exposed input resolves to
  // whatever expression the INSTANCE's real incoming edge (or its own
  // default) produces in the outer graph, keyed by the exposed input socket's
  // own id — which, for an extracted subgraph, IS `${internalNodeId}:${internalSocketId}`,
  // the exact key `makeInputResolver`'s override lookup will probe for that
  // internal node/socket once we recurse into `subGraph.graph` below.
  const overrides = new Map<string, string>();
  for (const inputSocket of subGraph.inputs) {
    overrides.set(inputSocket.id, outerInput(node.id, inputSocket.id));
  }

  // Every exposed output is a valid, independent result (see the comment on
  // `SubGraph.graph.outputNodeId`) — resolve reachability from all of them,
  // not from the internal graph's own (placeholder) `outputNodeId`.
  const roots: string[] = [];
  for (const outputSocket of subGraph.outputs) {
    const pointer = parseInternalSocketPointer(outputSocket.id);
    if (pointer) roots.push(pointer.nodeId);
  }

  state.expanding.push(subGraph.id);
  const { outputCache: internalOutputCache, outputSocketCache: internalOutputSocketCache } = dispatchGraph(
    subGraph.graph,
    roots,
    state,
    overrides,
  );
  state.expanding.pop();

  for (const outputSocket of subGraph.outputs) {
    const key = `${node.id}:${outputSocket.id}`;
    const pointer = parseInternalSocketPointer(outputSocket.id);
    if (!pointer) {
      state.sink.diag({
        level: 'error',
        message: `Subgraph "${subGraph.name}" output "${outputSocket.id}" has no recoverable internal node; using the default value on instance "${node.id}".`,
        nodeId: node.id,
      });
      outerOutputSocketCache.set(key, state.hooks.literal(outputSocket.defaultValue, outputSocket.type));
      continue;
    }
    const expr =
      internalOutputSocketCache.get(`${pointer.nodeId}:${pointer.socketId}`) ??
      internalOutputCache.get(pointer.nodeId);
    if (expr === undefined) {
      state.sink.diag({
        level: 'error',
        message: `Subgraph "${subGraph.name}" output "${outputSocket.id}" could not be resolved (internal node "${pointer.nodeId}" pruned, cyclic, or malformed); using the default value on instance "${node.id}".`,
        nodeId: node.id,
      });
      outerOutputSocketCache.set(key, state.hooks.literal(outputSocket.defaultValue, outputSocket.type));
      continue;
    }
    outerOutputSocketCache.set(key, expr);
  }

  // Convenience mirror for the (uncommon) single-output case so a graph whose
  // own `outputNodeId` happens to BE a subgraph-instance node still resolves
  // an `outputExpr` — every real document graph terminates at a well-known
  // `output.*` node instead, so this never fires in practice.
  if (subGraph.outputs.length === 1) {
    const only = `${node.id}:${subGraph.outputs[0].id}`;
    const expr = outerOutputSocketCache.get(only);
    if (expr !== undefined) outerOutputCache.set(node.id, expr);
  }
}

/** Dispatches one graph scope — either the top-level graph passed to
 *  `lowerGraph`, or (recursively) a `SubGraph.graph` being inlined for a
 *  `subgraph.instance` node. Each scope gets its OWN fresh `outputCache` /
 *  `outputSocketCache` (so the same subgraph instanced twice never collides on
 *  its internal node ids), while `state` — the sink, registry, hooks, source
 *  map, and the subgraph-expansion guard — stays shared across every scope in
 *  this call, which is what makes nested subgraph statements land in the same
 *  program rather than a separately-compiled one. */
function dispatchGraph(
  graph: ShaderGraph,
  roots: string[] | undefined,
  state: LowerRunState,
  inputOverrides?: Map<string, string>,
): { outputCache: Map<string, string>; outputSocketCache: Map<string, string>; topo: ResolveOrderResult } {
  const topo = resolveOrder(graph, roots);
  for (const d of topo.diagnostics) state.sink.diag(d);

  const outputCache = new Map<string, string>();
  const outputSocketCache = new Map<string, string>();
  const input = makeInputResolver(graph, state, outputCache, outputSocketCache, inputOverrides);

  for (const nodeId of topo.order) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) continue; // unreachable: nodeId came from this graph's own node list

    if (isSubGraphInstanceNode(node)) {
      dispatchSubGraphInstance(node, graph, input, outputCache, outputSocketCache, state);
      continue;
    }

    const def = state.registry.get(node.type);

    if (!def) {
      state.sink.diag({
        level: 'error',
        message: `Unknown node type "${node.type}" (node "${nodeId}"); no ${state.hooks.target} definition registered.`,
        nodeId,
      });
      outputCache.set(nodeId, state.hooks.literal(undefined, 'float'));
      continue;
    }

    if (node.bypassed && def.bypass) {
      const inSocket = def.inputs.find((s) => s.id === def.bypass?.input);
      const outSocket = def.outputs.find((s) => s.id === def.bypass?.output);
      if (!inSocket || !outSocket) {
        state.sink.diag({
          level: 'error',
          message: `Node "${nodeId}" (${node.type}) declares an invalid bypass mapping.`,
          nodeId,
        });
        outputCache.set(nodeId, state.hooks.literal(undefined, 'float'));
        continue;
      }
      const resolved = input(nodeId, inSocket.id);
      const passthrough =
        inSocket.type === outSocket.type
          ? resolved
          : (state.hooks.coerce(resolved, inSocket.type, outSocket.type) ?? resolved);
      outputCache.set(nodeId, passthrough);
      continue;
    }

    const emitter = def.emit[state.hooks.target];
    if (!emitter) {
      state.sink.diag({
        level: 'error',
        message: `Node "${node.type}" has no ${state.hooks.target} emitter (node "${nodeId}").`,
        nodeId,
      });
      const outType = def.outputs[0]?.type ?? 'float';
      outputCache.set(nodeId, state.hooks.literal(undefined, outType));
      continue;
    }

    const ctx: EmitContext = {
      target: state.hooks.target,
      temp: state.sink.temp,
      uniform: state.sink.uniform,
      emit: (line: string) => {
        state.sourceMap.push({ line: state.emittedLines.count, nodeId });
        state.emittedLines.count++;
        state.sink.emit(line);
      },
      diag: state.sink.diag,
      input,
    };
    outputCache.set(nodeId, emitter(node, ctx));
  }

  return { outputCache, outputSocketCache, topo };
}

/** Backend-neutral compile-time check for `ShaderNode.chunkSource.requires`
 *  (Phase 5 selective graphing, `src/model/document.ts`): a `NodeEmitter` only
 *  ever sees its own node, so it has no way to tell whether a chunk it
 *  declares it requires is present elsewhere in the same graph, let alone
 *  ordered before it — this pass has the whole graph in scope and runs once
 *  per `lowerGraph` call to catch both. Diagnostics only (`warning`, not
 *  `error`): the raw-passthrough emitter still emits regardless, since an
 *  incomplete/misordered chunk set is a target-language compile failure the
 *  target's own compiler will report more precisely than a guess made here —
 *  this pass exists to make the CAUSE visible up front, not to block or
 *  auto-fix it (see `graphFromRecognizedObject`'s own, earlier and stricter,
 *  gate on ungraphed requires for the tradeoff notes on why that one blocks
 *  instead of warning). */
export function checkChunkRequires(graph: ShaderGraph, order: string[], sink: EmitSink): void {
  const nodeIdByChunkName = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.chunkSource) nodeIdByChunkName.set(node.chunkSource.name, node.id);
  }
  const positionInOrder = new Map(order.map((id, i) => [id, i]));

  for (const node of graph.nodes) {
    if (!node.chunkSource) continue;
    for (const requiredName of node.chunkSource.requires) {
      const requiredNodeId = nodeIdByChunkName.get(requiredName);
      if (requiredNodeId === undefined) {
        sink.diag({
          level: 'warning',
          message: `Chunk "${node.chunkSource.name}" requires chunk "${requiredName}", which is not present in this graph.`,
          nodeId: node.id,
        });
        continue;
      }
      const requiredPos = positionInOrder.get(requiredNodeId);
      const ownPos = positionInOrder.get(node.id);
      if (requiredPos !== undefined && ownPos !== undefined && requiredPos > ownPos) {
        sink.diag({
          level: 'warning',
          message: `Chunk "${node.chunkSource.name}" requires chunk "${requiredName}" to come before it, but it is emitted after.`,
          nodeId: node.id,
        });
      }
    }
  }
}

/** Lowers one graph: resolves order, then dispatches each live node's
 *  `NodeDefinition.emit[hooks.target]` through an `EmitContext` backed by
 *  `sink`. Bypassed nodes skip their emitter entirely and pass their primary
 *  input straight through (coerced if the bypass's input/output types
 *  differ), per `NodeDefinition.bypass`. A `subgraph.instance` node is
 *  inlined instead (see `dispatchSubGraphInstance`) — pass the document's
 *  `subGraphs` so instances can be resolved; omit it (or pass `[]`) to leave
 *  any instance node unresolved exactly like an unknown node type today.
 *  Never throws — every failure mode becomes a `Diagnostic` on `sink` and a
 *  safe literal fallback so downstream nodes still get syntactically valid
 *  source. */
export function lowerGraph(
  graph: ShaderGraph,
  registry: NodeRegistry,
  hooks: LowerHooks,
  sink: EmitSink,
  subGraphs: SubGraph[] = [],
): LowerGraphResult {
  const state: LowerRunState = {
    registry,
    hooks,
    sink,
    subGraphs,
    sourceMap: [],
    emittedLines: { count: 0 },
    expanding: [],
  };
  const { outputCache, topo } = dispatchGraph(graph, undefined, state);
  checkChunkRequires(graph, topo.order, sink);

  return {
    outputExpr: outputCache.get(graph.outputNodeId),
    order: topo.order,
    pruned: topo.pruned,
    cyclic: topo.cyclic,
    sourceMap: state.sourceMap,
  };
}
