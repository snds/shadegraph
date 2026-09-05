// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Param value coercion
// ───────────────────────────────────────────────────────────────────────────
// `NodeParam.value` is `ScalarOrVector | string` — deliberately loose, because
// the document model is backend-neutral and must round-trip whatever a node
// definition declares. The inspector's controls, by contrast, are strict: a
// range input wants one finite number, a swatch wants "#rrggbb", a component
// grid wants exactly N numbers.
//
// Every lossy conversion between those two worlds lives HERE, as pure
// functions, so the widgets stay dumb and the rules stay unit-testable without
// a DOM. Nothing in this file imports React or touches the store.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeParam, ScalarOrVector, SocketType } from '../../model/document';

/** How many number fields a param of this type needs. */
export function vectorArity(type: SocketType): number {
  switch (type) {
    case 'vec2':
      return 2;
    case 'vec3':
    case 'color':
    case 'normal':
      return 3;
    case 'vec4':
      return 4;
    default:
      return 1;
  }
}

/** Component captions: colours read R/G/B/A, everything else X/Y/Z/W. */
export function componentLabels(type: SocketType): string[] {
  const arity = vectorArity(type);
  const source = type === 'color' ? ['R', 'G', 'B', 'A'] : ['X', 'Y', 'Z', 'W'];
  return source.slice(0, arity);
}

// ── Coercion ───────────────────────────────────────────────────────────────

export function toNumber(value: ScalarOrVector | string, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return value.trim() !== '' && Number.isFinite(parsed) ? parsed : fallback;
  }
  return Array.isArray(value) && typeof value[0] === 'number' ? value[0] : fallback;
}

export function toBoolean(value: ScalarOrVector | string): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '' && value !== 'false' && value !== '0';
  return false;
}

export function toText(value: ScalarOrVector | string): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

/** Exactly `arity` finite numbers — padded, truncated, or splatted as needed. */
export function toVector(value: ScalarOrVector | string, arity: number, fill = 0): number[] {
  const out = new Array<number>(arity).fill(fill);
  if (Array.isArray(value)) {
    for (let i = 0; i < arity; i += 1) {
      const raw = value[i];
      if (typeof raw === 'number' && Number.isFinite(raw)) out[i] = raw;
    }
    return out;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return out.fill(value);
  return out;
}

/** Narrow a component list back to the model's tuple union. */
export function asScalarOrVector(components: number[]): ScalarOrVector {
  switch (components.length) {
    case 2:
      return [components[0], components[1]];
    case 3:
      return [components[0], components[1], components[2]];
    case 4:
      return [components[0], components[1], components[2], components[3]];
    default:
      return components[0] ?? 0;
  }
}

/** Immutably replace one component. Out-of-range indexes are ignored. */
export function setComponent(components: number[], index: number, next: number): number[] {
  if (index < 0 || index >= components.length) return components;
  const out = components.slice();
  out[index] = next;
  return out;
}

// ── Numeric entry ──────────────────────────────────────────────────────────

/** Clamp to the param's declared range, rounding `int` params. */
export function clampToParam(value: number, param: Pick<NodeParam, 'type' | 'min' | 'max'>): number {
  let out = Number.isFinite(value) ? value : 0;
  if (param.type === 'int') out = Math.round(out);
  if (typeof param.min === 'number') out = Math.max(param.min, out);
  if (typeof param.max === 'number') out = Math.min(param.max, out);
  return out;
}

/** Parse typed text. `null` means "not a number" — the caller reverts. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Significant decimals implied by a param's `step` (used for display only). */
export function decimalsFor(step?: number): number {
  if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) return 6;
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(6, text.length - dot - 1);
}

/** Display text for a number field: no float noise, no trailing zeros. */
export function formatNumber(value: number, step?: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Number(value.toFixed(decimalsFor(step))));
}

// ── Colour ─────────────────────────────────────────────────────────────────

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
const byte = (channel: number) => Math.round(clamp01(channel) * 255);

/** Linear-ish 0..1 channels → the `#rrggbb` an `<input type="color">` wants. */
export function rgbToHex(components: number[]): string {
  const [r = 0, g = 0, b = 0] = components;
  return `#${[r, g, b].map((c) => byte(c).toString(16).padStart(2, '0')).join('')}`;
}

/** `#rgb` / `#rrggbb` → 0..1 channels. `null` for anything else. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const text = hex.trim().replace(/^#/, '');
  const expanded =
    text.length === 3
      ? text
          .split('')
          .map((c) => c + c)
          .join('')
      : text;
  if (!/^[0-9a-fA-F]{6}$/.test(expanded)) return null;
  const int = parseInt(expanded, 16);
  return [((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255];
}

/** Apply a swatch/hex edit while preserving any 4th (alpha) component. */
export function applyHex(current: number[], hex: string): number[] | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  return current.length > 3 ? [...rgb, current[3]] : rgb;
}

// ── Read-only display ──────────────────────────────────────────────────────

/** Compact, human-readable value — used by the blackboard list. */
export function formatParamValue(param: Pick<NodeParam, 'value' | 'step'>): string {
  const { value } = param;
  if (typeof value === 'string') return value === '' ? '—' : value;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return formatNumber(value, param.step);
  if (Array.isArray(value)) return value.map((n) => formatNumber(n, param.step)).join(', ');
  return '—';
}
