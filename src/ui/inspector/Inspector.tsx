// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Inspector
// ───────────────────────────────────────────────────────────────────────────
// Three selection states:
//   • one node selected   → its params, each rendered through `ParamControl`
//                            and pairable with an "Expose" toggle
//   • multiple selected   → just a count; editing multiple nodes' params at
//                            once is out of scope for Phase 1
//   • none selected       → document properties (`describeDocument`) plus the
//                            Blackboard: every exposed param in the document
//                            (`collectExposedParams`), derived — not mirrored
//
// Contract (do not change, or App.tsx breaks):
//   • props-free — read everything from `useEditorStore` directly
//   • renders exactly one root element: the whole <aside className="sg-inspector">
//     (it is grid column 3 of `.sg-body`)
//   • named export `Inspector`
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeParam, ShaderDocument } from '../../model/document';
import { nodes } from '../../nodes/registry';
import { activeGraph, useEditorStore } from '../store';
import { collectExposedParams, describeDocument, type BlackboardEntry } from './blackboard';
import { formatParamValue } from './paramValues';
import { ParamControl } from './ParamControl';
import './inspector.css';

const titleOf = (type: string) => nodes.get(type)?.title;

export function Inspector() {
  const doc = useEditorStore((s) => s.doc);
  const selectedNodeIds = useEditorStore((s) => s.selectedNodeIds);
  const setParamExposed = useEditorStore((s) => s.setParamExposed);
  const graph = activeGraph(doc);

  const node = selectedNodeIds.length === 1 ? graph.nodes.find((n) => n.id === selectedNodeIds[0]) : undefined;
  const def = node ? nodes.get(node.type) : undefined;

  return (
    <aside className="sg-inspector" aria-label="Inspector">
      <h2 className="sg-pane__title">Inspector</h2>

      {selectedNodeIds.length > 1 ? (
        <p className="sg-pane__empty">{selectedNodeIds.length} nodes selected.</p>
      ) : node ? (
        <>
          <div className="sg-inspector__head">
            <strong>{node.title ?? def?.title ?? node.type}</strong>
            <code>{node.type}</code>
          </div>
          <ul className="sg-inspector__params">
            {node.params.length === 0 ? <li className="sg-pane__empty">No parameters.</li> : null}
            {node.params.map((param: NodeParam) => (
              <li key={param.id} className="sg-param">
                <div className="sg-param__row">
                  <label className="sg-param__label" htmlFor={`param-${node.id}-${param.id}`}>
                    {param.label}
                  </label>
                  <label className="sg-param__expose">
                    <input
                      type="checkbox"
                      checked={param.exposed ?? false}
                      onChange={(event) => setParamExposed(node.id, param.id, event.target.checked)}
                    />
                    Expose
                  </label>
                </div>
                <ParamControl node={node} param={param} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <DocumentPane doc={doc} />
      )}
    </aside>
  );
}

function DocumentPane({ doc }: { doc: ShaderDocument }) {
  const summary = describeDocument(doc);
  const entries = collectExposedParams(doc, titleOf);
  const setParamExposed = useEditorStore((s) => s.setParamExposed);

  return (
    <>
      <p className="sg-pane__empty">No node selected.</p>
      <div className="sg-doc-summary">
        <h3 className="sg-pane__subtitle">Document</h3>
        <dl className="sg-doc-summary__list">
          <dt>Name</dt>
          <dd>{summary.name}</dd>
          <dt>Archetype</dt>
          <dd>{summary.archetype}</dd>
          <dt>Preview rig</dt>
          <dd>{summary.previewRig}</dd>
          <dt>Layers</dt>
          <dd>{summary.layerCount}</dd>
          <dt>Exposed params</dt>
          <dd>{summary.exposedCount}</dd>
        </dl>
      </div>

      <div className="sg-blackboard">
        <h3 className="sg-pane__subtitle">Blackboard</h3>
        {entries.length === 0 ? (
          <p className="sg-pane__empty">No exposed params yet.</p>
        ) : (
          <ul className="sg-blackboard__list">
            {entries.map((entry: BlackboardEntry) => (
              <li key={entry.key} className="sg-blackboard__row">
                <div className="sg-blackboard__meta">
                  <span className="sg-blackboard__label">{entry.param.label}</span>
                  <span className="sg-blackboard__source">
                    {entry.nodeTitle ? `${entry.layerName ?? ''} · ${entry.nodeTitle}` : 'global'}
                  </span>
                </div>
                <code className="sg-blackboard__value">{formatParamValue(entry.param)}</code>
                {entry.nodeId ? (
                  <button
                    type="button"
                    className="sg-blackboard__unexpose"
                    title="Remove from blackboard"
                    onClick={() => setParamExposed(entry.nodeId as string, entry.param.id, false)}
                  >
                    ×
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
