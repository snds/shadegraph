// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Node definition helpers
// ───────────────────────────────────────────────────────────────────────────
// Small, shared utilities used by the starter node definitions. These are NOT a
// compiler backend: they only help individual `NodeEmitter`s build identifiers
// and read a node's own params. The backend that consumes emitters (and the
// GLSL prelude that supplies `sg_*` helper functions) is Phase 2.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeParam, ParamUiHint, ScalarOrVector, ShaderNode, SocketType } from '../../model/document';
import type { EmitContext } from '../../compiler/backend';

/** Node ids are UUID-ish; shading languages want plain identifiers. */
export const ident = (raw: string): string => raw.replace(/[^A-Za-z0-9_]/g, '_');

/** Read a param off an instantiated node, falling back to the definition default. */
export function paramValue<T extends ScalarOrVector | string>(
  node: ShaderNode,
  id: string,
  fallback: T,
): T {
  const found = node.params.find((p) => p.id === id);
  return (found === undefined ? fallback : (found.value as T));
}

/** Declare (deduped) the uniform backing one of this node's params. */
export function paramUniform(
  ctx: EmitContext,
  node: ShaderNode,
  id: string,
  type: SocketType,
  fallback: ScalarOrVector,
): string {
  return ctx.uniform({
    name: `u_${ident(node.id)}_${id}`,
    type,
    paramId: id,
    default: paramValue(node, id, fallback),
  });
}

/** Terse `NodeParam` constructor so definitions stay readable. */
export function param(
  id: string,
  label: string,
  type: SocketType,
  value: ScalarOrVector | string,
  ui: ParamUiHint,
  extra: Partial<Pick<NodeParam, 'min' | 'max' | 'step' | 'options' | 'exposed' | 'bindUniform'>> = {},
): NodeParam {
  return { id, label, type, value, ui, ...extra };
}
