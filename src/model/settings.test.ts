// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — ProjectSettings persistence tests
// ───────────────────────────────────────────────────────────────────────────
// Node environment: no DOM. Storage is injected, so nothing here needs
// `localStorage` — mirrors the discipline in `src/ui/persistence.test.ts`.
// ═══════════════════════════════════════════════════════════════════════════

import { describe, expect, it } from 'vitest';

import {
  SETTINGS_STORAGE_KEY,
  clearSettings,
  emptySettings,
  loadSettings,
  parseSettingsText,
  saveSettings,
  serializeSettings,
  type ProjectSettings,
  type StorageLike,
} from './settings';

/** A tiny in-memory `StorageLike` — no `localStorage`/DOM required. */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe('emptySettings', () => {
  it('has no configured fields', () => {
    expect(emptySettings()).toEqual({});
  });
});

describe('save/load round-trip', () => {
  it('round-trips a fully populated ProjectSettings', () => {
    const storage = memoryStorage();
    const settings: ProjectSettings = {
      referenceCritique: { provider: 'api', apiKeyRef: 'sk-test-not-a-real-key', model: 'vision-model' },
      performanceBudget: {
        targetMsPerFrame: 16.67,
        population: {
          size: 20,
          variationRanges: { seed: [0, 1], scale: [0.5, 2] },
        },
      },
    };

    expect(saveSettings(settings, storage)).toBe(true);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it('round-trips settings with only performanceBudget set', () => {
    const storage = memoryStorage();
    const settings: ProjectSettings = { performanceBudget: { targetMsPerFrame: 33.3 } };
    saveSettings(settings, storage);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it('round-trips the documented-but-unimplemented mcp provider shape', () => {
    const storage = memoryStorage();
    const settings: ProjectSettings = {
      referenceCritique: { provider: 'mcp', mcpServerId: 'local-bridge', model: 'vision-model' },
    };
    saveSettings(settings, storage);
    expect(loadSettings(storage)).toEqual(settings);
  });

  it('loadSettings returns emptySettings() when nothing is stored', () => {
    const storage = memoryStorage();
    expect(loadSettings(storage)).toEqual(emptySettings());
  });

  it('loadSettings returns emptySettings() for an unavailable storage', () => {
    expect(loadSettings(null)).toEqual(emptySettings());
  });

  it('saveSettings/loadSettings use SETTINGS_STORAGE_KEY, not the autosave key', () => {
    const storage = memoryStorage();
    saveSettings({ performanceBudget: { targetMsPerFrame: 16.67 } }, storage);
    expect(storage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();
    expect(storage.getItem('shadegraph.autosave.v1')).toBeNull();
  });

  it('clearSettings drops the slot', () => {
    const storage = memoryStorage();
    saveSettings({ performanceBudget: { targetMsPerFrame: 16.67 } }, storage);
    clearSettings(storage);
    expect(storage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(loadSettings(storage)).toEqual(emptySettings());
  });
});

describe('parseSettingsText', () => {
  it('parses a well-formed envelope produced by serializeSettings', () => {
    const settings: ProjectSettings = { performanceBudget: { targetMsPerFrame: 16.67 } };
    expect(parseSettingsText(serializeSettings(settings))).toEqual(settings);
  });

  it('falls back to emptySettings() for invalid JSON', () => {
    expect(parseSettingsText('{not json')).toEqual(emptySettings());
  });

  it('falls back to emptySettings() for a JSON array', () => {
    expect(parseSettingsText('[]')).toEqual(emptySettings());
  });

  it('drops an unrecognised referenceCritique shape without throwing', () => {
    const result = parseSettingsText(JSON.stringify({ referenceCritique: { provider: 'bogus' } }));
    expect(result.referenceCritique).toBeUndefined();
  });

  it('drops a referenceCritique missing its required field for its provider', () => {
    const result = parseSettingsText(JSON.stringify({ referenceCritique: { provider: 'api' } }));
    expect(result.referenceCritique).toBeUndefined();
  });

  it('drops a performanceBudget missing targetMsPerFrame', () => {
    const result = parseSettingsText(JSON.stringify({ performanceBudget: { population: { size: 5 } } }));
    expect(result.performanceBudget).toBeUndefined();
  });

  it('drops individual malformed variation ranges but keeps well-formed ones', () => {
    const result = parseSettingsText(
      JSON.stringify({
        performanceBudget: {
          targetMsPerFrame: 16.67,
          population: { size: 10, variationRanges: { good: [0, 1], bad: 'nope' } },
        },
      }),
    );
    expect(result.performanceBudget?.population?.variationRanges).toEqual({ good: [0, 1] });
  });

  it('never throws on unexpected input shapes', () => {
    expect(() => parseSettingsText('null')).not.toThrow();
    expect(() => parseSettingsText('42')).not.toThrow();
    expect(() => parseSettingsText('"a string"')).not.toThrow();
  });
});
