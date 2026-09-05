// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Layer stack  ·  PLACEHOLDER
// ───────────────────────────────────────────────────────────────────────────
// Owned by the "Layer stack panel" task. Fill THIS file in; `App.tsx` already
// mounts it and must not be edited.
//
// Contract (do not change, or App.tsx breaks):
//   • props-free — read everything from `useEditorStore` directly
//   • renders exactly one root element: the whole <aside className="sg-layers">
//     (it is grid column 1 of `.sg-body`)
//   • named export `LayerStack`
//
// To do here: add / remove / reorder layers, blend mode, opacity, enabled +
// visible + solo toggles — all via `addLayer`, `removeLayer`, `setLayerProp`,
// `setActiveLayer`. Below is a read-only stand-in so the shell renders.
// ═══════════════════════════════════════════════════════════════════════════

import { activeLayerId, useEditorStore } from '../store';

export function LayerStack() {
  const layers = useEditorStore((s) => s.doc.layerStack.layers);
  const activeId = useEditorStore((s) => activeLayerId(s.doc));

  return (
    <aside className="sg-layers" aria-label="Layer stack">
      <h2 className="sg-pane__title">Layers</h2>
      <ul className="sg-layers__list">
        {/* Array order is bottom-to-top; show the stack the way it composites. */}
        {[...layers].reverse().map((layer) => (
          <li key={layer.id} className="sg-layers__item" data-active={layer.id === activeId}>
            <span className="sg-layers__name">{layer.name}</span>
            <span className="sg-layers__meta">
              {layer.blend} · {Math.round(layer.opacity * 100)}%
            </span>
          </li>
        ))}
      </ul>
      <p className="sg-pane__pending">layer editing — pending</p>
    </aside>
  );
}
