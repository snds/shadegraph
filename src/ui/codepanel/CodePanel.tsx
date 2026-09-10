// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Code panel
// ───────────────────────────────────────────────────────────────────────────
// Read-only view of the compiler's actual output: whatever `CompiledProgram`
// the shared `PreviewRenderer` last produced for the current `ViewerSource`
// (full composite, a soloed node, or a soloed layer — see `store.ts`). Never a
// re-derived or approximated source: `store.compiledProgram` is set from the
// SAME compile the renderer used to bind the GPU program (`MainViewer`'s
// `onCompiled` bridge), so the panel can never drift from what is actually
// rendering.
//
// Click-to-source: `CompiledProgram.sourceMap` names, for a given output
// line, the node whose emitter produced it. Clicking such a line selects that
// node — switching the active layer first if the node lives in a different
// one, since the graph canvas only ever shows the active layer's graph.
//
// Diagnostics live elsewhere on purpose (not duplicated here): a `nodeId`
// diagnostic is a badge on that node's card (`ShaderNodeCard.tsx`); a
// document-level one (no `nodeId`) is already the toast (`NoticeToast`, via
// the existing `store.lastError` channel). This panel only shows source.
//
// Contract with `App.tsx` (mount-point-only, per its own header comment):
// this is the one other sanctioned exception (alongside `MainViewer`) — a
// toggleable, props-free, self-mounting pane.
// ═══════════════════════════════════════════════════════════════════════════

import { useMemo, useState } from 'react';

import { activeLayerId, useEditorStore } from '../store';
import { findLayerOwningNode } from '../../model/layerTree';
import type { ViewerSource } from '../../preview/scheduler';
import './codePanel.css';

function viewerSourceLabel(src: ViewerSource): string {
  if (src.kind === 'node') return `Node: ${src.nodeId}`;
  if (src.kind === 'layer') return `Layer: ${src.layerId}`;
  return 'Full composite';
}

/** Selects `nodeId` in the graph, switching the active layer first if the
 *  node lives in a different one (the canvas only ever renders the active
 *  layer's graph — see `GraphCanvas.tsx`). */
function selectNodeAcrossLayers(nodeId: string): void {
  const { doc, setActiveLayer, selectNodes } = useEditorStore.getState();
  const owner = findLayerOwningNode(doc.layerStack.layers, nodeId);
  if (owner && owner.id !== activeLayerId(doc)) setActiveLayer(owner.id);
  selectNodes([nodeId]);
}

export function CodePanel() {
  const [open, setOpen] = useState(false);
  const program = useEditorStore((s) => s.compiledProgram);
  const viewerSource = useEditorStore((s) => s.viewerSource);

  const lineToNodeId = useMemo(() => {
    const map = new Map<number, string>();
    for (const entry of program?.sourceMap ?? []) map.set(entry.line, entry.nodeId);
    return map;
  }, [program]);

  const hasErrors = program?.diagnostics.some((d) => d.level === 'error') ?? false;
  const lines = (program?.fragment ?? '').split('\n');

  return (
    <div className="sg-codepanel-dock">
      <button
        type="button"
        className="sg-codepanel-toggle"
        aria-pressed={open}
        aria-label={open ? 'Hide compiled source' : 'Show compiled source'}
        onClick={() => setOpen((v) => !v)}
      >
        {'</>'} Code
        {hasErrors ? (
          <span className="sg-codepanel-toggle__dot" aria-hidden="true" />
        ) : null}
      </button>

      {open ? (
        <aside className="sg-codepanel" aria-label="Compiled GLSL ES source">
          <header className="sg-codepanel__head">
            <span className="sg-codepanel__title">GLSL ES — {viewerSourceLabel(viewerSource)}</span>
            <button
              type="button"
              className="sg-codepanel__close"
              onClick={() => setOpen(false)}
              aria-label="Close code panel"
            >
              ×
            </button>
          </header>

          {program ? (
            <ol className="sg-codepanel__lines">
              {lines.map((text, index) => {
                const lineNumber = index + 1;
                const nodeId = lineToNodeId.get(lineNumber);
                return (
                  <li key={lineNumber} className="sg-codepanel__line" data-clickable={nodeId ? true : undefined}>
                    {nodeId ? (
                      <button
                        type="button"
                        className="sg-codepanel__line-btn"
                        title={`Select node "${nodeId}"`}
                        onClick={() => selectNodeAcrossLayers(nodeId)}
                      >
                        <code>{text}</code>
                      </button>
                    ) : (
                      <code>{text}</code>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="sg-codepanel__empty">No compiled source yet.</p>
          )}
        </aside>
      ) : null}
    </div>
  );
}
