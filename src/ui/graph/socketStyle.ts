// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Socket colour language
// ───────────────────────────────────────────────────────────────────────────
// One colour per `SocketType`, used identically by node handles, edges, and the
// legend, so "what plugs into what" is readable at a glance. Pure data: no
// React, no DOM — the model stays unaware that colour exists at all.
//
// Semantically related types are visually related: `color` sits next to vec3/
// vec4 in hue, `normal` next to vec3, `int` next to `float`, mirroring
// SOCKET_COMPATIBILITY without duplicating it.
// ═══════════════════════════════════════════════════════════════════════════

import type { SocketType } from '../../model/document';

export const SOCKET_COLORS: Record<SocketType, string> = {
  float: '#a3adbb',
  int: '#4fd6be',
  vec2: '#7cd3ff',
  vec3: '#ffb454',
  vec4: '#ff8fa3',
  color: '#ffd866',
  bool: '#c792ea',
  sampler2D: '#4ea1ff',
  cubemap: '#5b7cff',
  normal: '#a5e34a',
};

const FALLBACK = '#7c8798';

/** Colour for a socket type; never throws on an unknown/future type. */
export function socketColor(type: SocketType | undefined): string {
  return (type && SOCKET_COLORS[type]) || FALLBACK;
}

/** Legend order — scalars, vectors, semantic aliases, then resources. */
export const SOCKET_LEGEND: SocketType[] = [
  'float',
  'int',
  'bool',
  'vec2',
  'vec3',
  'vec4',
  'color',
  'normal',
  'sampler2D',
  'cubemap',
];
