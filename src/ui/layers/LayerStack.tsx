// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Layer stack
// ───────────────────────────────────────────────────────────────────────────
// The Photoshop-like surface: an ordered stack of layers, each owning its own
// node graph. This pane picks WHICH graph the canvas edits (`setActiveLayer`)
// and how each layer composites (blend / opacity / enabled / visible / solo).
// It never touches nodes or edges — that is the graph surface's job, and the
// two surfaces stay deliberately separate.
//
// Contract with `App.tsx` (unchanged from the placeholder): props-free, one
// root element `<aside className="sg-layers">`, named export `LayerStack`.
//
// Order: `layerStack.layers` is BOTTOM-TO-TOP; this list renders TOP-FIRST.
// That inversion lives entirely in `./reorder`, never inline here.
//
// Rejections (deleting the last layer, unknown ids) are surfaced by the store's
// `lastError` → `NoticeToast` channel, so nothing here invents its own errors.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';

import type { ShaderLayer } from '../../model/document';
import { activeLayerId, useEditorStore } from '../store';
import { BLEND_MODES, BLEND_MODE_LABELS, isBlendMode } from './blendModes';
import { canMoveLayer, topFirst, type StackDirection } from './reorder';
import './layers.css';

/** Percent, for display and for the opacity slider. */
const pct = (opacity: number) => Math.round(opacity * 100);

export function LayerStack() {
  const layers = useEditorStore((s) => s.doc.layerStack.layers);
  const activeId = useEditorStore((s) => activeLayerId(s.doc));
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const setLayerProp = useEditorStore((s) => s.setLayerProp);
  const addLayer = useEditorStore((s) => s.addLayer);
  const removeLayer = useEditorStore((s) => s.removeLayer);
  const reorderLayer = useEditorStore((s) => s.reorderLayer);
  const editingTarget = useEditorStore((s) => s.editingTarget);
  const addMaskToLayer = useEditorStore((s) => s.addMaskToLayer);
  const removeMaskFromLayer = useEditorStore((s) => s.removeMaskFromLayer);
  const enterMaskEditing = useEditorStore((s) => s.enterMaskEditing);
  const exitMaskEditing = useEditorStore((s) => s.exitMaskEditing);

  // When any layer is soloed, only soloed layers composite — so the panel must
  // show the other rows as inert, or the enabled toggles look like they lie.
  const soloing = layers.some((l) => l.soloed);

  return (
    <aside className="sg-layers" aria-label="Layer stack">
      <header className="sg-layers__head">
        <h2 className="sg-pane__title">Layers</h2>
        <button
          type="button"
          className="sg-btn sg-btn--mini"
          onClick={() => addLayer()}
          title="Add a layer above the stack"
        >
          + Layer
        </button>
      </header>

      <ul className="sg-layers__list">
        {topFirst(layers).map((layer) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            active={layer.id === activeId}
            dimmed={soloing && !layer.soloed}
            canMoveUp={canMoveLayer(layers, layer.id, 'up')}
            canMoveDown={canMoveLayer(layers, layer.id, 'down')}
            onlyLayer={layers.length <= 1}
            onActivate={setActiveLayer}
            onPatch={setLayerProp}
            onMove={reorderLayer}
            onRemove={removeLayer}
            editingMask={editingTarget.kind === 'mask' && editingTarget.layerId === layer.id}
            onAddMask={addMaskToLayer}
            onEditMask={enterMaskEditing}
            onExitMask={exitMaskEditing}
            onRemoveMask={removeMaskFromLayer}
          />
        ))}
      </ul>

      <p className="sg-layers__legend">
        Top of the stack composites last. <b>out</b> = in the compiled output,{' '}
        <b>prev</b> = drawn in the editor preview, <b>solo</b> = only soloed layers composite,{' '}
        <b>mask</b> = dive in to edit this layer's mask graph.
      </p>
    </aside>
  );
}

// ── One row ────────────────────────────────────────────────────────────────

interface LayerRowProps {
  layer: ShaderLayer;
  active: boolean;
  dimmed: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onlyLayer: boolean;
  onActivate: (id: string) => void;
  onPatch: (id: string, patch: Partial<Omit<ShaderLayer, 'id' | 'graph'>>) => void;
  onMove: (id: string, direction: StackDirection) => void;
  onRemove: (id: string) => void;
  /** Whether the canvas is currently dived into THIS layer's mask graph. */
  editingMask: boolean;
  /** Give this layer an empty mask and start editing it (no-op if it already
   *  has one — the mask button below handles enter/exit for that case). */
  onAddMask: (id: string) => void;
  /** Dive into an existing mask graph. */
  onEditMask: (id: string) => void;
  /** Return to the layer's main graph (used when toggling off `editingMask`). */
  onExitMask: () => void;
  /** Delete this layer's mask graph entirely. */
  onRemoveMask: (id: string) => void;
}

function LayerRow({
  layer,
  active,
  dimmed,
  canMoveUp,
  canMoveDown,
  onlyLayer,
  onActivate,
  onPatch,
  onMove,
  onRemove,
  editingMask,
  onAddMask,
  onEditMask,
  onExitMask,
  onRemoveMask,
}: LayerRowProps) {
  const nodeCount = layer.graph.nodes.length;
  const hasMask = !!layer.maskGraph;

  // Buffered draft, same pattern as the document name field in `DocToolbar`:
  // the field only diverges from the store while it has focus, so an
  // external rename (e.g. undo, later multi-user edits) is never clobbered.
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(layer.name);

  useEffect(() => {
    if (!renaming) setDraftName(layer.name);
  }, [layer.name, renaming]);

  function commitRename() {
    setRenaming(false);
    const next = draftName.trim();
    if (next && next !== layer.name) onPatch(layer.id, { name: next });
    else setDraftName(layer.name);
  }

  return (
    <li
      className="sg-layers__item"
      data-active={active}
      data-dimmed={dimmed || undefined}
      data-disabled={!layer.enabled || undefined}
    >
      <div className="sg-layers__row">
        {renaming ? (
          <input
            className="sg-layers__nameInput"
            value={draftName}
            autoFocus
            aria-label={`Rename ${layer.name}`}
            onChange={(e) => setDraftName(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setDraftName(layer.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          // The row header doubles as the "edit this layer's graph" control;
          // double-click switches to renaming instead of activating the layer.
          <button
            type="button"
            className="sg-layers__name"
            onClick={() => onActivate(layer.id)}
            onDoubleClick={() => setRenaming(true)}
            aria-pressed={active}
            title={`Edit ${layer.name}'s graph (double-click to rename)`}
          >
            <span className="sg-layers__label">{layer.name}</span>
            <span className="sg-layers__count">{nodeCount}</span>
          </button>
        )}

        <div className="sg-layers__moves">
          <button
            type="button"
            className="sg-layers__move"
            onClick={() => onMove(layer.id, 'up')}
            disabled={!canMoveUp}
            aria-label={`Move ${layer.name} up`}
            title="Move up (composites later)"
          >
            ▲
          </button>
          <button
            type="button"
            className="sg-layers__move"
            onClick={() => onMove(layer.id, 'down')}
            disabled={!canMoveDown}
            aria-label={`Move ${layer.name} down`}
            title="Move down (composites earlier)"
          >
            ▼
          </button>
        </div>
      </div>

      <div className="sg-layers__row sg-layers__row--toggles">
        <Toggle
          label="out"
          on={layer.enabled}
          title="Contributes to the compiled output"
          name={layer.name}
          onToggle={() => onPatch(layer.id, { enabled: !layer.enabled })}
        />
        <Toggle
          label="prev"
          on={layer.visible}
          title="Drawn in the editor preview, even when not in the output"
          name={layer.name}
          onToggle={() => onPatch(layer.id, { visible: !layer.visible })}
        />
        <Toggle
          label="solo"
          on={layer.soloed ?? false}
          title="Solo: while any layer is soloed, only soloed layers composite"
          name={layer.name}
          onToggle={() => onPatch(layer.id, { soloed: !layer.soloed })}
        />
        <button
          type="button"
          className="sg-layers__toggle sg-layers__mask"
          data-on={hasMask}
          data-editing={editingMask || undefined}
          aria-pressed={editingMask}
          aria-label={
            !hasMask
              ? `Add a mask to ${layer.name}`
              : editingMask
                ? `Stop editing ${layer.name}'s mask`
                : `Edit ${layer.name}'s mask`
          }
          title={
            !hasMask
              ? 'Add a mask (multiplies a grayscale graph result into this layer per-pixel)'
              : editingMask
                ? "Back to this layer's main graph"
                : "Edit this layer's mask graph"
          }
          onClick={() => {
            if (!hasMask) onAddMask(layer.id);
            else if (editingMask) onExitMask();
            else onEditMask(layer.id);
          }}
        >
          {hasMask ? 'mask' : '+ mask'}
        </button>
        {hasMask ? (
          <button
            type="button"
            className="sg-layers__maskRemove"
            onClick={() => onRemoveMask(layer.id)}
            aria-label={`Remove ${layer.name}'s mask`}
            title="Remove this layer's mask"
          >
            ✕
          </button>
        ) : null}
        <button
          type="button"
          className="sg-layers__remove"
          onClick={() => onRemove(layer.id)}
          disabled={onlyLayer}
          aria-label={`Delete ${layer.name}`}
          title={onlyLayer ? 'A document needs at least one layer' : 'Delete this layer'}
        >
          ✕
        </button>
      </div>

      <div className="sg-layers__row sg-layers__row--mix">
        <label className="sg-layers__field">
          <span className="sg-layers__fieldLabel">Blend</span>
          <select
            className="sg-layers__select"
            value={layer.blend}
            onChange={(e) => {
              if (isBlendMode(e.target.value)) onPatch(layer.id, { blend: e.target.value });
            }}
            aria-label={`Blend mode for ${layer.name}`}
          >
            {BLEND_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {BLEND_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>

        <label className="sg-layers__field sg-layers__field--opacity">
          <span className="sg-layers__fieldLabel">Opacity</span>
          <input
            className="sg-layers__slider"
            type="range"
            min={0}
            max={100}
            step={1}
            value={pct(layer.opacity)}
            onChange={(e) => onPatch(layer.id, { opacity: Number(e.target.value) / 100 })}
            aria-label={`Opacity for ${layer.name}`}
          />
          <output className="sg-layers__pct">{pct(layer.opacity)}%</output>
        </label>
      </div>
    </li>
  );
}

// ── Small pressed-state toggle ─────────────────────────────────────────────

interface ToggleProps {
  label: string;
  name: string;
  title: string;
  on: boolean;
  onToggle: () => void;
}

function Toggle({ label, name, title, on, onToggle }: ToggleProps) {
  return (
    <button
      type="button"
      className="sg-layers__toggle"
      data-on={on}
      aria-pressed={on}
      aria-label={`${title} — ${name}`}
      title={title}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}
