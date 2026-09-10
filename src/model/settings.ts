// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Project settings (tool-level config, NOT document data)
// ───────────────────────────────────────────────────────────────────────────
// `ProjectSettings` configures HOW the tool is used (an LLM provider for
// reference critique, a performance budget target) — never WHAT is being
// edited. It therefore has nothing to do with `ShaderDocument`/`serialize.ts`
// and is never written into a `.shadegraph.json` file. It lives in its own
// `localStorage` slot, deliberately separate from the document autosave slot
// (`src/ui/persistence.ts`'s `AUTOSAVE_KEY`) so the two can evolve, clear, or
// version independently.
//
// This module owns BOTH the type and the persistence for settings (unlike the
// document, whose persistence lives in `src/ui/persistence.ts`) per the Phase
// 4 task scope: settings are simple enough, and few enough consumers exist,
// that one small pure module covers both without a UI-layer split.
//
// SECRET HYGIENE: `ReferenceCritiqueApiConfig.apiKeyRef` holds a user-supplied
// API key. This module never logs it, never includes it in a thrown error
// message, and never echoes it back in any diagnostic string — every error
// path below reports only shape/kind, never field values.
//
// No React, no DOM assumptions beyond an injectable `Storage`-shaped object,
// so this stays importable from the (node-environment) test runner — same
// discipline as `src/ui/persistence.ts`.
// ═══════════════════════════════════════════════════════════════════════════

// ── Reference critique ──────────────────────────────────────────────────────

/** Direct-API path — the only implemented provider for v1 (Phase 4 sketch,
 *  "Open questions — SETTLED": API-first, confirmed). */
export interface ReferenceCritiqueApiConfig {
  provider: 'api';
  /** The API key (or a reference to one). Treated as a secret everywhere it
   *  is handled — never logged, never surfaced in an error/diagnostic. */
  apiKeyRef: string;
  model?: string;
}

/** Documented-but-unimplemented per the Phase 4 sketch's API-first decision:
 *  MCP stays a stretch goal until a browser↔MCP bridge is actually needed.
 *  Nothing in this codebase constructs or reads this variant today. */
export interface ReferenceCritiqueMcpConfig {
  provider: 'mcp';
  mcpServerId: string;
  model?: string;
}

export type ReferenceCritiqueConfig = ReferenceCritiqueApiConfig | ReferenceCritiqueMcpConfig;

// ── Statistical performance budget ─────────────────────────────────────────

/** One exposed param's sampling range for synthetic-variant generation,
 *  keyed by param name. `[min, max]`, inclusive. */
export type VariationRanges = Record<string, [number, number]>;

export interface PerformanceBudgetPopulationConfig {
  /** How many synthetic variants to generate per run. */
  size: number;
  variationRanges: VariationRanges;
}

export interface PerformanceBudgetConfig {
  /** The aggregate frame-time target (e.g. 16.67 for a 60fps budget). */
  targetMsPerFrame: number;
  population?: PerformanceBudgetPopulationConfig;
}

// ── ProjectSettings ─────────────────────────────────────────────────────────

/** Where the main preview (`MainViewer`) docks relative to the node graph
 *  (`GraphCanvas`) within their shared main content region. `'bottom'` is the
 *  pre-existing default (preview as a footer under the graph); `'top'` swaps
 *  the two. See `src/ui/MainContentRegion.tsx`, the one place that reads
 *  this field. */
export type PreviewDockPosition = 'top' | 'bottom';

export interface ProjectSettings {
  referenceCritique?: ReferenceCritiqueConfig;
  performanceBudget?: PerformanceBudgetConfig;
  previewDockPosition?: PreviewDockPosition;
}

/** The settings equivalent of `emptyDocument()` — every field genuinely
 *  optional, so "nothing configured yet" is just `{}`. */
export function emptySettings(): ProjectSettings {
  return {};
}

// ── Storage ─────────────────────────────────────────────────────────────────

/** localStorage key for project settings. Deliberately its OWN key, distinct
 *  from `AUTOSAVE_KEY` — settings and the open document clear/version on
 *  independent schedules. Versioned for the same reason as the autosave key:
 *  a future shape break ships a new key rather than migrating in place. */
export const SETTINGS_STORAGE_KEY = 'shadegraph.settings.v1';

/** The slice of the `Storage` interface this module needs. Injectable so
 *  persistence is testable without a DOM (mirrors `StorageLike` in
 *  `src/ui/persistence.ts`; duplicated rather than imported so this model
 *  module has zero dependency on the UI layer). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `localStorage` when it exists and is usable — Safari private mode and
 *  sandboxed iframes throw on mere access, so this is defensive. */
export function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

// ── Validation (untrusted JSON → ProjectSettings) ──────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isRange(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

function readReferenceCritique(value: unknown): ReferenceCritiqueConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  const model = typeof value.model === 'string' ? value.model : undefined;

  if (value.provider === 'api' && typeof value.apiKeyRef === 'string') {
    return { provider: 'api', apiKeyRef: value.apiKeyRef, model };
  }
  if (value.provider === 'mcp' && typeof value.mcpServerId === 'string') {
    return { provider: 'mcp', mcpServerId: value.mcpServerId, model };
  }
  // Unrecognised shape — dropped rather than trusted. Never echoes `value`
  // itself into any message, since an `apiKeyRef` may be sitting inside it.
  return undefined;
}

function readPopulation(value: unknown): PerformanceBudgetPopulationConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  if (!isFiniteNumber(value.size) || !isPlainObject(value.variationRanges)) return undefined;

  const variationRanges: VariationRanges = {};
  for (const [key, range] of Object.entries(value.variationRanges)) {
    if (isRange(range)) variationRanges[key] = range;
  }
  return { size: value.size, variationRanges };
}

function readPerformanceBudget(value: unknown): PerformanceBudgetConfig | undefined {
  if (!isPlainObject(value)) return undefined;
  if (!isFiniteNumber(value.targetMsPerFrame)) return undefined;

  const population = readPopulation(value.population);
  return { targetMsPerFrame: value.targetMsPerFrame, population };
}

function readPreviewDockPosition(value: unknown): PreviewDockPosition | undefined {
  return value === 'top' || value === 'bottom' ? value : undefined;
}

/**
 * Untrusted JSON text → a best-effort `ProjectSettings`. Never throws and
 * never reports *why* a sub-field was dropped (that could mean echoing a
 * secret) — a malformed slot degrades to "that field is simply unset"
 * rather than blocking the rest of settings from loading.
 */
export function parseSettingsText(text: string): ProjectSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptySettings();
  }
  if (!isPlainObject(parsed)) return emptySettings();

  const settings: ProjectSettings = {};
  const referenceCritique = readReferenceCritique(parsed.referenceCritique);
  if (referenceCritique) settings.referenceCritique = referenceCritique;
  const performanceBudget = readPerformanceBudget(parsed.performanceBudget);
  if (performanceBudget) settings.performanceBudget = performanceBudget;
  const previewDockPosition = readPreviewDockPosition(parsed.previewDockPosition);
  if (previewDockPosition) settings.previewDockPosition = previewDockPosition;
  return settings;
}

/** `ProjectSettings` → the exact string stored under `SETTINGS_STORAGE_KEY`. */
export function serializeSettings(settings: ProjectSettings): string {
  return JSON.stringify(settings);
}

/** Read + validate the settings slot. Always returns a usable value —
 *  `emptySettings()` when nothing is stored or the slot is unreadable. */
export function loadSettings(storage: StorageLike | null = defaultStorage()): ProjectSettings {
  if (!storage) return emptySettings();
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null || raw === '') return emptySettings();
    return parseSettingsText(raw);
  } catch {
    return emptySettings();
  }
}

/** Persist settings. Returns false when storage is unavailable or full —
 *  same "convenience, never a hard failure" policy as `writeAutosave`. */
export function saveSettings(
  settings: ProjectSettings,
  storage: StorageLike | null = defaultStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, serializeSettings(settings));
    return true;
  } catch {
    return false;
  }
}

/** Drop the settings slot entirely. */
export function clearSettings(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(SETTINGS_STORAGE_KEY);
  } catch {
    /* nothing to do — the slot is already unusable */
  }
}
