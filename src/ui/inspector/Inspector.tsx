// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Inspector
// ───────────────────────────────────────────────────────────────────────────
// Floating panel (see `inspector.css` / `../app.css`'s `.sg-inspector` rule)
// anchored to the right edge of the main content region, sized to its own
// content rather than a fixed-height column — it grows and shrinks with the
// selection below.
//
// Selection states, in priority order:
//   • multiple nodes selected → just a count; editing multiple nodes' params
//                            at once is out of scope for Phase 1
//   • one node selected   → its params, each rendered through `ParamControl`
//                            and pairable with an "Expose" toggle — EXCEPT a
//                            subgraph-instance node (special-cased, no
//                            registry def, no `NodeParam`s of its own), which
//                            shows its sockets (read live from the referenced
//                            `SubGraph`) instead — see `SubGraphInstancePane`.
//   • diving into a subgraph's own graph (canvas dive-in, no node selected)
//                          → its exposed interface (add/remove an
//                            input/output), so it stays editable somewhere —
//                            see `SubGraphInterfacePane`. Takes priority over
//                            a stale Layers-panel selection from before the
//                            dive-in, since `editingTarget` is the more
//                            explicit, more recent navigation.
//   • multiple layers/groups selected (Layers panel) → just a count, same
//                            treatment as multi-node
//   • one layer OR group selected (Layers panel, `selectedLayerIds`) → the
//                            "layer controls" section: blend/opacity/toggles/
//                            mask/delete, plus Ungroup for a group — see
//                            `LayerControlsPane`. Relocated here from
//                            `LayerStack.tsx` (Phase 6 "Layers panel" task)
//                            verbatim in behavior.
//   • none of the above    → document properties (`describeDocument`) plus
//                            the Blackboard.
//
// Contract (do not change, or App.tsx breaks):
//   • props-free — read everything from `useEditorStore` directly
//   • renders exactly one root element: the whole <aside className="sg-inspector">
//     (floats over the main content region, positioned by `../app.css`)
//   • named export `Inspector`
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';

import type { EditingTarget } from '../store';
import type { NodeParam, ShaderDocument, SocketType, StackNode, SubGraph } from '../../model/document';
import { findStackNode, flattenLayers, isGroupNode, isLayerNode } from '../../model/layerTree';
import { findSubGraph, isSubGraphInstanceNode } from '../../model/subgraph';
import { nodes } from '../../nodes/registry';
import { activeGraph, activeGraphKind, useEditorStore, type LayerPatch } from '../store';
import { BLEND_MODES, BLEND_MODE_LABELS, isBlendMode } from '../layers/blendModes';
import { collectExposedParams, describeDocument, type BlackboardEntry } from './blackboard';
import { formatParamValue } from './paramValues';
import { ParamControl } from './ParamControl';
import './inspector.css';

const titleOf = (type: string) => nodes.get(type)?.title;

export function Inspector() {
  const doc = useEditorStore((s) => s.doc);
  const selectedNodeIds = useEditorStore((s) => s.selectedNodeIds);
  const selectedLayerIds = useEditorStore((s) => s.selectedLayerIds);
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

  // Only consulted once every node/subgraph-diving state above has fallen
  // through — see the priority list in the header comment.
  const noNodeSelected = selectedNodeIds.length === 0;
  const stackNode =
    noNodeSelected && !editingSubGraphId && selectedLayerIds.length === 1
      ? findStackNode(doc.layerStack.layers, selectedLayerIds[0])
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
      ) : noNodeSelected && selectedLayerIds.length > 1 ? (
        <p className="sg-pane__empty">{selectedLayerIds.length} layers selected.</p>
      ) : stackNode ? (
        <LayerControlsPane stackNode={stackNode} doc={doc} editingTarget={editingTarget} />
      ) : (
        <DocumentPane doc={doc} />
      )}
    </aside>
  );
}

/** Layer-controls section for the Layers panel's current single selection —
 *  a leaf `ShaderLayer` or a `LayerGroup`, both handled the same way except
 *  where noted (mask controls, Ungroup). Relocated verbatim (same store
 *  actions, same behavior) from `LayerStack.tsx`'s old inline per-row
 *  controls — see that file's Phase 6 "Layers panel" rewrite, which removes
 *  them there. */
function LayerControlsPane({
  stackNode,
  doc,
  editingTarget,
}: {
  stackNode: StackNode;
  doc: ShaderDocument;
  editingTarget: EditingTarget;
}) {
  const setLayerProp = useEditorStore((s) => s.setLayerProp);
  const removeLayer = useEditorStore((s) => s.removeLayer);
  const ungroupLayer = useEditorStore((s) => s.ungroupLayer);
  const addMaskToLayer = useEditorStore((s) => s.addMaskToLayer);
  const removeMaskFromLayer = useEditorStore((s) => s.removeMaskFromLayer);
  const enterMaskEditing = useEditorStore((s) => s.enterMaskEditing);
  const exitMaskEditing = useEditorStore((s) => s.exitMaskEditing);

  const isGroup = isGroupNode(stackNode);
  const isLeaf = isLayerNode(stackNode);
  // Same "would this empty the document of layers?" check `removeLayer`
  // itself enforces — reimplemented here only to disable the button up
  // front, matching the old `LayerStack.tsx` row's UX; the store's own
  // rejection (surfaced via `lastError`/`NoticeToast`) is still the real
  // guard, not this.
  const totalLeaves = flattenLayers(doc.layerStack.layers).length;
  const removedLeaves = isGroupNode(stackNode) ? flattenLayers(stackNode.children).length : 1;
  const onlyLayer = totalLeaves - removedLeaves < 1;

  const hasMask = !!stackNode.maskGraph;
  const editingMask = editingTarget.kind === 'mask' && editingTarget.layerId === stackNode.id;

  const patch = (p: LayerPatch) => setLayerProp(stackNode.id, p);

  return (
    <div className="sg-inspector__layerctl">
      <div className="sg-inspector__head">
        <strong>{stackNode.name}</strong>
        <code>{isGroup ? 'Group' : 'Layer'}</code>
      </div>

      <div className="sg-layerctl__row">
        <LayerToggle
          label="out"
          on={stackNode.enabled}
          title="Contributes to the compiled output"
          name={stackNode.name}
          onToggle={() => patch({ enabled: !stackNode.enabled })}
        />
        <LayerToggle
          label="prev"
          on={stackNode.visible}
          title="Drawn in the editor preview, even when not in the output"
          name={stackNode.name}
          onToggle={() => patch({ visible: !stackNode.visible })}
        />
        <LayerToggle
          label="solo"
          on={stackNode.soloed ?? false}
          title="Solo: while any sibling is soloed, only soloed siblings composite"
          name={stackNode.name}
          onToggle={() => patch({ soloed: !stackNode.soloed })}
        />

        {/* A group's `maskGraph` masks its already-folded composite exactly
            like a leaf layer's masks its own graph (`document.ts`'s
            `LayerGroup.maskGraph` doc comment, `foldStack` in both compiler
            backends) — same control, same store actions, for either kind. */}
        <>
          <button
            type="button"
            className="sg-layerctl__mask"
            data-on={hasMask}
            data-editing={editingMask || undefined}
            aria-pressed={editingMask}
            aria-label={
              !hasMask
                ? `Add a mask to ${stackNode.name}`
                : editingMask
                  ? `Stop editing ${stackNode.name}'s mask`
                  : `Edit ${stackNode.name}'s mask`
            }
            title={
              !hasMask
                ? `Add a mask (multiplies a grayscale graph result into this ${isGroup ? 'group' : 'layer'} per-pixel)`
                : editingMask
                  ? `Back to ${isLeaf ? "this layer's main graph" : 'the layer stack'}`
                  : `Edit this ${isGroup ? 'group' : 'layer'}'s mask graph`
            }
            onClick={() => {
              if (!hasMask) addMaskToLayer(stackNode.id);
              else if (editingMask) exitMaskEditing();
              else enterMaskEditing(stackNode.id);
            }}
          >
            {hasMask ? 'mask' : '+ mask'}
          </button>
          {hasMask ? (
            <button
              type="button"
              className="sg-layerctl__maskRemove"
              onClick={() => removeMaskFromLayer(stackNode.id)}
              aria-label={`Remove ${stackNode.name}'s mask`}
              title={`Remove this ${isGroup ? 'group' : 'layer'}'s mask`}
            >
              ×
            </button>
          ) : null}
        </>
      </div>

      <div className="sg-layerctl__row sg-layerctl__row--mix">
        <label className="sg-layerctl__field">
          <span className="sg-layerctl__fieldLabel">Blend</span>
          <select
            className="sg-layerctl__select"
            value={stackNode.blend}
            onChange={(e) => {
              if (isBlendMode(e.target.value)) patch({ blend: e.target.value });
            }}
            aria-label={`Blend mode for ${stackNode.name}`}
          >
            {BLEND_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {BLEND_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>

        <label className="sg-layerctl__field sg-layerctl__field--opacity">
          <span className="sg-layerctl__fieldLabel">Opacity</span>
          <input
            className="sg-layerctl__slider"
            type="range"
            min={0}
            max={100}
            step={1}
            value={Math.round(stackNode.opacity * 100)}
            onChange={(e) => patch({ opacity: Number(e.target.value) / 100 })}
            aria-label={`Opacity for ${stackNode.name}`}
          />
          <output className="sg-layerctl__pct">{Math.round(stackNode.opacity * 100)}%</output>
        </label>
      </div>

      <div className="sg-layerctl__actions">
        {isGroup ? (
          <button
            type="button"
            className="sg-btn sg-btn--mini"
            onClick={() => ungroupLayer(stackNode.id)}
            title="Ungroup: splice this group's children back into its parent"
          >
            Ungroup
          </button>
        ) : null}
        <button
          type="button"
          className="sg-layerctl__delete"
          onClick={() => removeLayer(stackNode.id)}
          disabled={onlyLayer}
          aria-label={`Delete ${stackNode.name}`}
          title={onlyLayer ? 'A document needs at least one layer' : `Delete ${stackNode.name}`}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ── Small pressed-state toggle, same look as the old `LayerStack.tsx` one
//    (`.sg-layerctl__toggle` in `inspector.css` mirrors `.sg-layers__toggle`
//    in `../layers/layers.css`) — duplicated rather than imported cross-pane,
//    since the Layers panel task owns (and is actively rewriting) that file.

interface LayerToggleProps {
  label: string;
  name: string;
  title: string;
  on: boolean;
  onToggle: () => void;
}

function LayerToggle({ label, name, title, on, onToggle }: LayerToggleProps) {
  return (
    <button
      type="button"
      className="sg-layerctl__toggle"
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
