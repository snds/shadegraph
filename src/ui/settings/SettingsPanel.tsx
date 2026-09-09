// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Project settings panel
// ───────────────────────────────────────────────────────────────────────────
// Tool-level configuration UI for the Phase 4 verification capabilities
// (reference critique, statistical performance budget). Reads/writes
// `ProjectSettings` via `useProjectSettings`; owns no document/store state.
//
// SECRET HYGIENE (verified explicitly, see task note):
//   • The API key field is `type="password"` — the browser renders it
//     masked; the raw value exists in the DOM only as that input's own
//     `value`, never anywhere else (no mirrored `<span>`, no title attr).
//   • Nothing in this file calls `console.*` with the settings object, the
//     api key, or any prop/state derived from it.
//   • The "show/hide" affordance flips `type` between `password`/`text` on
//     the SAME input — it never copies the value into a second element.
// ═══════════════════════════════════════════════════════════════════════════

import { useRef, useState } from 'react';

import type { PerformanceBudgetPopulationConfig, ReferenceCritiqueApiConfig } from '../../model/settings';
import { defaultRecognitionConfigId, recognitionConfigOptions, useAssetStore } from '../../storage';
import { useProjectSettings } from './useProjectSettings';
import './settings.css';

/** One `variationRanges` row, as an editable `[name, min, max]` triple. Kept
 *  as a local draft row shape (not `[number, number]` directly) so a row
 *  being renamed doesn't require a valid range yet.
 *
 *  `key` is a STABLE row identity assigned once at row creation — it must
 *  never be derived from `name`/`min`/`max`. Rows are held in local state
 *  (see `SettingsPanel`) precisely so editing `name` character-by-character
 *  never re-derives a new key from content and forces React to remount the
 *  row: that would drop focus and any Escape/undo-adjacent expectations for
 *  a plain text field mid-edit, on every keystroke. */
interface RangeRow {
  key: string;
  name: string;
  min: number;
  max: number;
}

function rangesToRows(ranges: Record<string, [number, number]> | undefined): RangeRow[] {
  if (!ranges) return [];
  return Object.entries(ranges).map(([name, [min, max]], i) => ({
    key: `row-${i}`,
    name,
    min,
    max,
  }));
}

function rowsToRanges(rows: RangeRow[]): Record<string, [number, number]> {
  const ranges: Record<string, [number, number]> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (name) ranges[name] = [row.min, row.max];
  }
  return ranges;
}

/** A repeatable param-range picker: add/remove rows of `{ name, min, max }`.
 *  Deliberately minimal per the task's "can be simple" note.
 *
 *  Takes explicit `onUpdate`/`onAdd`/`onRemove` callbacks (rather than a
 *  single `onChange(rows)`) so row-id assignment stays entirely in the
 *  parent's `nextRowId` counter — this component never invents a key. */
function VariationRangesEditor({
  rows,
  onUpdate,
  onAdd,
  onRemove,
}: {
  rows: RangeRow[];
  onUpdate: (key: string, patch: Partial<RangeRow>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
}) {
  return (
    <div className="sg-settings__ranges">
      {rows.length === 0 && <p className="sg-settings__hint">No param ranges configured yet.</p>}
      {rows.map((row) => (
        <div className="sg-settings__range-row" key={row.key}>
          <input
            type="text"
            className="sg-field sg-settings__range-name"
            placeholder="param name"
            aria-label="Param name"
            value={row.name}
            onChange={(e) => onUpdate(row.key, { name: e.target.value })}
          />
          <input
            type="number"
            className="sg-field sg-settings__range-num"
            aria-label={`${row.name || 'param'} min`}
            value={row.min}
            onChange={(e) => onUpdate(row.key, { min: Number(e.target.value) })}
          />
          <span className="sg-settings__range-sep">to</span>
          <input
            type="number"
            className="sg-field sg-settings__range-num"
            aria-label={`${row.name || 'param'} max`}
            value={row.max}
            onChange={(e) => onUpdate(row.key, { max: Number(e.target.value) })}
          />
          <button
            type="button"
            className="sg-btn sg-settings__range-remove"
            aria-label={`Remove ${row.name || 'param'} range`}
            onClick={() => onRemove(row.key)}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="sg-btn" onClick={onAdd}>
        + Add param range
      </button>
    </div>
  );
}

export function SettingsPanel() {
  const [settings, update] = useProjectSettings();
  const [apiKeyVisible, setApiKeyVisible] = useState(false);

  // The selector's initial value reflects whichever config is ACTUALLY active
  // on `useAssetStore` right now (falling back to the generic default id if
  // it doesn't match a known option, e.g. nothing has been set yet) — not a
  // fixed default — so reopening this panel after a switch shows the true
  // current selection rather than visually resetting to "Generic".
  const activeRecognitionConfig = useAssetStore((s) => s.recognitionConfig);
  const setStoreRecognitionConfig = useAssetStore((s) => s.setRecognitionConfig);
  const [recognitionConfigId, setRecognitionConfigId] = useState<string>(
    () =>
      recognitionConfigOptions.find((option) => option.config === activeRecognitionConfig)?.id ??
      defaultRecognitionConfigId,
  );

  function selectRecognitionConfig(id: string) {
    const option = recognitionConfigOptions.find((o) => o.id === id) ?? recognitionConfigOptions[0];
    setRecognitionConfigId(option.id);
    setStoreRecognitionConfig(option.config);
  }

  const critique = settings.referenceCritique;
  const critiqueIsApi = critique?.provider === 'api';
  const apiCritique: ReferenceCritiqueApiConfig | undefined = critiqueIsApi
    ? (critique as ReferenceCritiqueApiConfig)
    : undefined;

  const budget = settings.performanceBudget;
  const population: PerformanceBudgetPopulationConfig | undefined = budget?.population;

  // Rows live in LOCAL state, seeded once from whatever was loaded/persisted.
  // They are NOT re-derived from `settings` on every render — this component
  // is the one writer of `performanceBudget.population`, so re-deriving would
  // only ever reconstruct what it just wrote, at the cost of picking a new
  // (content-derived, in the old version of this file) `key` per edit and
  // thrashing row identity. See the `RangeRow.key` doc comment above.
  const [rangeRows, setRangeRowsState] = useState<RangeRow[]>(() =>
    rangesToRows(population?.variationRanges),
  );
  const nextRowId = useRef(rangeRows.length);

  function setApiCritique(patch: Partial<ReferenceCritiqueApiConfig>) {
    update((prev) => {
      const prevCritique = prev.referenceCritique?.provider === 'api' ? prev.referenceCritique : undefined;
      return {
        ...prev,
        referenceCritique: {
          provider: 'api',
          apiKeyRef: prevCritique?.apiKeyRef ?? '',
          model: prevCritique?.model,
          ...patch,
        },
      };
    });
  }

  function clearCritique() {
    update((prev) => {
      const next = { ...prev };
      delete next.referenceCritique;
      return next;
    });
  }

  function setBudget(patch: Partial<{ targetMsPerFrame: number }>) {
    update((prev) => ({
      ...prev,
      performanceBudget: {
        targetMsPerFrame: prev.performanceBudget?.targetMsPerFrame ?? 16.67,
        population: prev.performanceBudget?.population,
        ...patch,
      },
    }));
  }

  function setPopulationSize(size: number) {
    update((prev) => ({
      ...prev,
      performanceBudget: {
        targetMsPerFrame: prev.performanceBudget?.targetMsPerFrame ?? 16.67,
        population: { size, variationRanges: prev.performanceBudget?.population?.variationRanges ?? {} },
      },
    }));
  }

  function commitRangeRows(rows: RangeRow[]) {
    setRangeRowsState(rows);
    update((prev) => ({
      ...prev,
      performanceBudget: {
        targetMsPerFrame: prev.performanceBudget?.targetMsPerFrame ?? 16.67,
        population: {
          size: prev.performanceBudget?.population?.size ?? rows.length,
          variationRanges: rowsToRanges(rows),
        },
      },
    }));
  }

  function addRangeRow() {
    const key = `row-${nextRowId.current++}`;
    commitRangeRows([...rangeRows, { key, name: '', min: 0, max: 1 }]);
  }

  function updateRangeRow(key: string, patch: Partial<RangeRow>) {
    commitRangeRows(rangeRows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function removeRangeRow(key: string) {
    commitRangeRows(rangeRows.filter((r) => r.key !== key));
  }

  return (
    <div className="sg-settings">
      <h2 className="sg-pane__title">Project settings</h2>

      <section className="sg-settings__section">
        <h3 className="sg-settings__section-title">Reference critique</h3>
        <p className="sg-settings__hint">
          Direct API only for now — an LLM call to critique a render against reference media.
        </p>

        <label className="sg-settings__field" htmlFor="sg-settings-critique-key">
          API key
        </label>
        <div className="sg-settings__key-row">
          <input
            id="sg-settings-critique-key"
            className="sg-field sg-settings__key-input"
            type={apiKeyVisible ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            aria-label="Reference critique API key"
            value={apiCritique?.apiKeyRef ?? ''}
            onChange={(e) => setApiCritique({ apiKeyRef: e.target.value })}
          />
          <button
            type="button"
            className="sg-btn"
            onClick={() => setApiKeyVisible((v) => !v)}
            aria-label={apiKeyVisible ? 'Hide API key' : 'Show API key'}
          >
            {apiKeyVisible ? 'Hide' : 'Show'}
          </button>
        </div>

        <label className="sg-settings__field" htmlFor="sg-settings-critique-model">
          Model <span className="sg-settings__optional">(optional)</span>
        </label>
        <input
          id="sg-settings-critique-model"
          className="sg-field"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. a vision-capable model id"
          value={apiCritique?.model ?? ''}
          onChange={(e) => setApiCritique({ model: e.target.value || undefined })}
        />

        {critique && (
          <button type="button" className="sg-btn sg-linkbtn" onClick={clearCritique}>
            Clear reference critique config
          </button>
        )}
      </section>

      <section className="sg-settings__section">
        <h3 className="sg-settings__section-title">Performance budget</h3>

        <label className="sg-settings__field" htmlFor="sg-settings-target-ms">
          Target ms / frame
        </label>
        <input
          id="sg-settings-target-ms"
          className="sg-field"
          type="number"
          step="0.01"
          min="0"
          aria-label="Target milliseconds per frame"
          value={budget?.targetMsPerFrame ?? ''}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isFinite(value)) setBudget({ targetMsPerFrame: value });
          }}
        />

        <label className="sg-settings__field" htmlFor="sg-settings-population-size">
          Population size <span className="sg-settings__optional">(optional)</span>
        </label>
        <input
          id="sg-settings-population-size"
          className="sg-field"
          type="number"
          step="1"
          min="0"
          aria-label="Synthetic variant population size"
          value={population?.size ?? ''}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (Number.isFinite(value)) setPopulationSize(value);
          }}
        />

        <p className="sg-settings__field">Param variation ranges</p>
        <VariationRangesEditor
          rows={rangeRows}
          onUpdate={updateRangeRow}
          onAdd={addRangeRow}
          onRemove={removeRangeRow}
        />
      </section>

      <section className="sg-settings__section">
        <h3 className="sg-settings__section-title">Recognition config</h3>
        <p className="sg-settings__hint">
          Which shader-object pattern the asset browser checks files against on the next connect/expand. Already
          recognized files are not rechecked.
        </p>

        <label className="sg-settings__field" htmlFor="sg-settings-recognition-config">
          Active config
        </label>
        <select
          id="sg-settings-recognition-config"
          className="sg-field"
          aria-label="Active recognition config"
          value={recognitionConfigId}
          onChange={(e) => selectRecognitionConfig(e.target.value)}
        >
          {recognitionConfigOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </section>
    </div>
  );
}
