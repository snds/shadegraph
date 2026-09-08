// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Project settings React binding
// ───────────────────────────────────────────────────────────────────────────
// Thin glue between `src/model/settings.ts` (pure data + localStorage) and
// React. Mirrors the "load once on boot, write through on every change"
// treatment the document gets from `restoreAutosave`/`startAutosave`, just
// scoped to one component tree instead of the whole app: there is exactly one
// settings panel, so a plain `useState` + write-through is enough — no need
// for a zustand store shared across panes the way the document is.
//
// SECRET HYGIENE: this hook never logs `settings` and never includes it in a
// thrown/rejected value. `saveSettings`/`loadSettings` already fail closed
// (return `false`/`emptySettings()`) rather than throwing, so there is no
// catch block here that could be tempted to log the settings object "for
// debugging".
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useState } from 'react';

import { loadSettings, saveSettings, type ProjectSettings } from '../../model/settings';

export type SettingsUpdater = (prev: ProjectSettings) => ProjectSettings;

/**
 * `[settings, update]`. `update` takes an updater function (like
 * `setState`'s functional form) so callers never need to spread a
 * possibly-stale snapshot themselves.
 */
export function useProjectSettings(): [ProjectSettings, (updater: SettingsUpdater) => void] {
  const [settings, setSettings] = useState<ProjectSettings>(() => loadSettings());

  const update = useCallback((updater: SettingsUpdater) => {
    setSettings((prev) => {
      const next = updater(prev);
      saveSettings(next);
      return next;
    });
  }, []);

  return [settings, update];
}
