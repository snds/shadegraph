// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Inspector  ·  PLACEHOLDER
// ───────────────────────────────────────────────────────────────────────────
// Owned by the "Inspector panel" task. Fill THIS file in; `App.tsx` already
// mounts it and must not be edited.
//
// Contract (do not change, or App.tsx breaks):
//   • props-free — read everything from `useEditorStore` directly
//   • renders exactly one root element: the whole <aside className="sg-inspector">
//     (it is grid column 3 of `.sg-body`)
//   • named export `Inspector`
//
// To do here: render the selected node's `params` as controls driven by each
// param's `ui` hint (slider / number / color / toggle / select / vector) and
// commit through `setParam`. Below is a read-only stand-in so the shell renders.
// ═══════════════════════════════════════════════════════════════════════════

import { activeGraph, useEditorStore } from '../store';
import { nodes } from '../../nodes/registry';

export function Inspector() {
  const selectedNodeIds = useEditorStore((s) => s.selectedNodeIds);
  const graph = useEditorStore((s) => activeGraph(s.doc));

  const node = selectedNodeIds.length === 1 ? graph.nodes.find((n) => n.id === selectedNodeIds[0]) : undefined;
  const def = node ? nodes.get(node.type) : undefined;

  return (
    <aside className="sg-inspector" aria-label="Inspector">
      <h2 className="sg-pane__title">Inspector</h2>
      {!node ? (
        <p className="sg-pane__empty">
          {selectedNodeIds.length > 1 ? `${selectedNodeIds.length} nodes selected.` : 'No node selected.'}
        </p>
      ) : (
        <>
          <div className="sg-inspector__head">
            <strong>{node.title ?? def?.title ?? node.type}</strong>
            <code>{node.type}</code>
          </div>
          <ul className="sg-inspector__params">
            {node.params.length === 0 ? <li className="sg-pane__empty">No parameters.</li> : null}
            {node.params.map((p) => (
              <li key={p.id}>
                <span>{p.label}</span>
                <code>{JSON.stringify(p.value)}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="sg-pane__pending">param editing — pending</p>
    </aside>
  );
}
