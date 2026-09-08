// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Inspector
// ───────────────────────────────────────────────────────────────────────────
// Three selection states:
//   • one node selected   → its params, each rendered through `ParamControl`
//                            and pairable with an "Expose" toggle — EXCEPT a
//                            subgraph-instance node (special-cased, no
//                            registry def, no `NodeParam`s of its own), which
//                            shows its sockets (read live from the referenced
//                            `SubGraph`) instead — see `SubGraphInstancePane`.
//   • multiple selected   → just a count; editing multiple nodes' params at
//                            once is out of scope for Phase 1
//   • none selected       → document properties (`describeDocument`) plus the
//                            Blackboard — UNLESS the canvas is currently
//                            diving into a subgraph's own graph, in which
//                            case its exposed interface (add/remove an
//                            input/output) is shown instead, so it stays
//                            editable somewhere — see `SubGraphInterfacePane`.
//
// Contract (do not change, or App.tsx breaks):
//   • props-free — read everything from `useEditorStore` directly
//   • renders exactly one root element: the whole <aside className="sg-inspector">
//     (it is grid column 3 of `.sg-body`)
//   • named export `Inspector`
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';

import type { NodeParam, ShaderDocument, SocketType, SubGraph } from '../../model/document';
import { findSubGraph, isSubGraphInstanceNode } from '../../model/subgraph';
import { nodes } from '../../nodes/registry';
import { activeGraph, activeGraphKind, useEditorStore } from '../store';
import { collectExposedParams, describeDocument, type BlackboardEntry } from './blackboard';
import { formatParamValue } from './paramValues';
import { ParamControl } from './ParamControl';
import './inspector.css';

const titleOf = (type: string) => nodes.get(type)?.title;

export function Inspector() {
  const doc = useEditorStore((s) => s.doc);
  const selectedNodeIds = useEditorStore((s) => s.selectedNodeIds);
  const setParamExposed = useEditorStore((s) => s.setParamExposed);
  const editingTarget = useEditorStore((s) => s.editingTarget);
  const graph = activeGraph(doc, editingTarget);

  const node = selectedNodeIds.length === 1 ? graph.nodes.find((n) => n.id === selectedNodeIds[0]) : undefined;
  const subGraph = node && isSubGraphInstanceNode(node) ? findSubGraph(doc.subGraphs, node.subGraphId) : undefined;
  const def = node && !isSubGraphInstanceNode(node) ? nodes.get(node.type) : undefined;
  const editingSubGraphId =
    editingTarget.kind === 'subgraph' && activeGraphKind(doc, editingTarget) === 'subgraph'
      ? editingTarget.subGraphId
      : undefined;

  return (
    <aside className="sg-inspector" aria-label="Inspector">
      <h2 className="sg-pane__title">Inspector</h2>

      {selectedNodeIds.length > 1 ? (
        <p className="sg-pane__empty">{selectedNodeIds.length} nodes selected.</p>
      ) : node ? (
        <>
          <div className="sg-inspector__head">
            <strong>{node.title ?? subGraph?.name ?? def?.title ?? node.type}</strong>
            <code>{node.type}</code>
          </div>
          {subGraph ? (
            <SubGraphInstancePane subGraph={subGraph} />
          ) : (
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
          )}
        </>
      ) : editingSubGraphId ? (
        <SubGraphInterfacePane subGraphId={editingSubGraphId} />
      ) : (
        <DocumentPane doc={doc} />
      )}
    </aside>
  );
}

/** Selected-node view for a subgraph instance: read-only, since a subgraph
 *  instance carries no `NodeParam`s of its own — its interface is edited via
 *  `SubGraphInterfacePane`, from inside the subgraph itself, not here. */
function SubGraphInstancePane({ subGraph }: { subGraph: SubGraph }) {
  return (
    <div className="sg-inspector__params">
      <p className="sg-pane__empty">
        Subgraph instance — sockets come from &quot;{subGraph.name}&quot; and update live if it changes.
      </p>
      {subGraph.outputs.length === 0 && subGraph.inputs.length === 0 ? (
        <p className="sg-pane__empty">No exposed sockets yet.</p>
      ) : (
        <ul className="sg-blackboard__list">
          {subGraph.outputs.map((s) => (
            <li key={`out:${s.id}`} className="sg-blackboard__row">
              <span className="sg-blackboard__label">{s.label}</span>
              <span className="sg-blackboard__source">output · {s.type}</span>
            </li>
          ))}
          {subGraph.inputs.map((s) => (
            <li key={`in:${s.id}`} className="sg-blackboard__row">
              <span className="sg-blackboard__label">{s.label}</span>
              <span className="sg-blackboard__source">input · {s.type}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The "nothing selected" view while diving into a subgraph's own graph
 *  (`EditingTarget`'s `'subgraph'` kind) — the subgraph analogue of
 *  `DocumentPane` below. Editing here (add/remove an input/output) is
 *  visible immediately on every instance elsewhere in the document, since
 *  instances resolve sockets live from this same `SubGraph` (see
 *  `subGraphInstanceSocket`) rather than a copy. */
function SubGraphInterfacePane({ subGraphId }: { subGraphId: string }) {
  const doc = useEditorStore((s) => s.doc);
  const renameSubGraph = useEditorStore((s) => s.renameSubGraph);
  const addSubGraphInput = useEditorStore((s) => s.addSubGraphInput);
  const addSubGraphOutput = useEditorStore((s) => s.addSubGraphOutput);
  const removeSubGraphInput = useEditorStore((s) => s.removeSubGraphInput);
  const removeSubGraphOutput = useEditorStore((s) => s.removeSubGraphOutput);
  const subGraph = doc.subGraphs.find((sg) => sg.id === subGraphId);

  if (!subGraph) return <p className="sg-pane__empty">This subgraph no longer exists.</p>;

  return (
    <>
      <p className="sg-pane__empty">No node selected.</p>
      <div className="sg-doc-summary">
        <h3 className="sg-pane__subtitle">Subgraph</h3>
        <div className="sg-inspector__head">
          <input
            className="sg-param__label"
            value={subGraph.name}
            onChange={(event) => renameSubGraph(subGraph.id, event.target.value)}
            aria-label="Subgraph name"
          />
        </div>
        <p className="sg-pane__empty">
          Every instance of this subgraph shares this interface — adding or removing a socket here shows up on all
          of them.
        </p>
      </div>

      <SubGraphSocketList
        title="Inputs"
        sockets={subGraph.inputs}
        onAdd={(label, type) => addSubGraphInput(subGraph.id, label, type)}
        onRemove={(socketId) => removeSubGraphInput(subGraph.id, socketId)}
      />
      <SubGraphSocketList
        title="Outputs"
        sockets={subGraph.outputs}
        onAdd={(label, type) => addSubGraphOutput(subGraph.id, label, type)}
        onRemove={(socketId) => removeSubGraphOutput(subGraph.id, socketId)}
      />
    </>
  );
}

const SOCKET_TYPES: SocketType[] = [
  'float',
  'vec2',
  'vec3',
  'vec4',
  'color',
  'bool',
  'int',
  'sampler2D',
  'cubemap',
  'normal',
];

function SubGraphSocketList({
  title,
  sockets,
  onAdd,
  onRemove,
}: {
  title: string;
  sockets: SubGraph['inputs'];
  onAdd: (label: string, type: SocketType) => void;
  onRemove: (socketId: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<SocketType>('float');

  return (
    <div className="sg-blackboard">
      <h3 className="sg-pane__subtitle">{title}</h3>
      {sockets.length === 0 ? (
        <p className="sg-pane__empty">None yet.</p>
      ) : (
        <ul className="sg-blackboard__list">
          {sockets.map((s) => (
            <li key={s.id} className="sg-blackboard__row">
              <div className="sg-blackboard__meta">
                <span className="sg-blackboard__label">{s.label}</span>
                <span className="sg-blackboard__source">{s.type}</span>
              </div>
              <button
                type="button"
                className="sg-blackboard__unexpose"
                title={`Remove "${s.label}"`}
                onClick={() => onRemove(s.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="sg-param__row"
        onSubmit={(event) => {
          event.preventDefault();
          if (!label.trim()) return;
          onAdd(label.trim(), type);
          setLabel('');
        }}
      >
        <input
          className="sg-param__label"
          placeholder={`New ${title.toLowerCase().slice(0, -1)} label`}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <select value={type} onChange={(event) => setType(event.target.value as SocketType)}>
          {SOCKET_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button type="submit" className="sg-param__expose">
          + Add
        </button>
      </form>
    </div>
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
