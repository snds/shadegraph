// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique panel
// ───────────────────────────────────────────────────────────────────────────
// Wires the pure `src/critique/` pipeline (screenshot capture → reference
// still(s) → Anthropic call → parsed verdict) to the UI. Owns no critique
// LOGIC itself — every step below delegates to a `src/critique/` function
// that already has its own unit tests; this component is just the glue
// (asset-tree selection, local run state, error display) around them.
//
// Reads (never writes) `ProjectSettings.referenceCritique` via the existing
// `useProjectSettings` hook, and reads/drives `useAssetStore` for reference
// media the same way `AssetBrowserPanel.tsx` does — both per the task's
// explicit "may read from src/storage/ and src/model/settings.ts" scope.
// Neither `src/ui/settings/` nor `src/ui/assets/` is edited by this task.
//
// `useAssetStore` supports multiple simultaneously-connected folders
// (`AssetRoot[]`) — this picker browses EVERY connected one, one section per
// root, since a reference still can live in any of them. Deliberately NOT
// filtered to `root.visibleIds` (the Assets panel's shader-recognition
// filter): a reference image/video is never itself a recognized shader
// object, so that filter would hide every pickable file here.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';

import { flattenVisibleTree, useAssetStore, type AssetTreeNode } from '../../storage';
import { CritiqueError } from '../../critique/errors';
import { loadImageStill } from '../../critique/referenceImage';
import { runCritique } from '../../critique/runCritique';
import { captureMainViewerStill } from '../../critique/screenshot';
import { parseTimestampSeconds } from '../../critique/timestamps';
import type { CritiqueResult, StillImage } from '../../critique/types';
import { createBrowserVideoFrameExtractorDeps, extractVideoStills } from '../../critique/videoFrames';
import { Icon } from '../shell/Icon';
import { useProjectSettings } from '../settings/useProjectSettings';
import './critique.css';

type RunState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: CritiqueResult }
  | { kind: 'error'; message: string };

/** The reference-media tree picker. Deliberately simpler than
 *  `AssetBrowserPanel`'s `AssetTreeView` (no virtualization) — this panel
 *  only ever needs to pick ONE file, not browse a whole folder's contents,
 *  so a plain scrollable list is enough. One section per connected root
 *  (`AssetRoot`), since the reference file could live in any of them; each
 *  section still reads through the same `flattenVisibleTree`/`toggleExpand`
 *  public surface `AssetBrowserPanel.tsx` does, just unfiltered (see this
 *  file's header comment on why `visibleIds` is not applied here). */
function ReferencePicker({
  selectedRootId,
  selectedNodeId,
  onSelect,
}: {
  selectedRootId: string | null;
  selectedNodeId: string | null;
  onSelect: (rootId: string, node: AssetTreeNode) => void;
}) {
  const roots = useAssetStore((s) => s.roots);
  const toggleExpand = useAssetStore((s) => s.toggleExpand);

  const connectedRoots = roots.filter((r) => r.status === 'connected');

  if (connectedRoots.length === 0) {
    return <p className="sg-critique__hint">Connect an asset folder (the Assets panel) to pick reference media.</p>;
  }

  return (
    <div className="sg-critique__tree-group">
      {connectedRoots.map((root) => {
        const flat = flattenVisibleTree(root.nodesById, root.rootIds);
        return (
          <div key={root.id} className="sg-critique__tree-section">
            <p className="sg-critique__tree-heading">{root.rootName}</p>
            {flat.length === 0 ? (
              <p className="sg-critique__hint">This folder is empty.</p>
            ) : (
              <ul className="sg-critique__tree" role="tree" aria-label={`${root.rootName ?? 'Reference media'}`}>
                {flat.map((node) => (
                  <li key={node.id} style={{ paddingLeft: 4 + node.depth * 14 }}>
                    {node.kind === 'folder' ? (
                      <button
                        type="button"
                        className="sg-critique__disclosure"
                        onClick={() => void toggleExpand(root.id, node.id)}
                      >
                        {node.loadingChildren ? (
                          <Icon name="progress_activity" />
                        ) : (
                          <Icon name={node.expanded ? 'expand_more' : 'chevron_right'} />
                        )}{' '}
                        {node.name}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={
                          root.id === selectedRootId && node.id === selectedNodeId
                            ? 'sg-critique__file sg-critique__file--selected'
                            : 'sg-critique__file'
                        }
                        aria-pressed={root.id === selectedRootId && node.id === selectedNodeId}
                        onClick={() => onSelect(root.id, node)}
                      >
                        {node.name}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function CritiquePanel() {
  const [settings] = useProjectSettings();
  const loadPreview = useAssetStore((s) => s.loadPreview);
  const releasePreview = useAssetStore((s) => s.releasePreview);
  const roots = useAssetStore((s) => s.roots);

  const [selectedRef, setSelectedRef] = useState<{ rootId: string; nodeId: string } | null>(null);
  const [timestampsInput, setTimestampsInput] = useState('0, 1, 2');
  const [renderStill, setRenderStill] = useState<StillImage | null>(null);
  const [state, setState] = useState<RunState>({ kind: 'idle' });

  const critique = settings.referenceCritique;
  const hasApiKey = critique?.provider === 'api' && critique.apiKeyRef.trim().length > 0;
  const selectedNode = selectedRef
    ? roots.find((r) => r.id === selectedRef.rootId)?.nodesById[selectedRef.nodeId]
    : undefined;

  // Loads the newly-selected node's preview and releases the PREVIOUSLY
  // selected one on every change (and on unmount) — one effect owns the
  // whole acquire/release lifecycle, mirroring `AssetTreeView`'s treatment
  // of preview refcounting in `AssetBrowserPanel.tsx`.
  useEffect(() => {
    if (!selectedRef) return;
    const { rootId, nodeId } = selectedRef;
    void loadPreview(rootId, nodeId);
    return () => releasePreview(rootId, nodeId);
  }, [selectedRef, loadPreview, releasePreview]);

  const handleSelect = useCallback((rootId: string, node: AssetTreeNode) => {
    setSelectedRef({ rootId, nodeId: node.id });
    setState({ kind: 'idle' });
  }, []);

  const handleCapture = useCallback(() => {
    try {
      setRenderStill(captureMainViewerStill());
      setState({ kind: 'idle' });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Could not capture the current render.',
      });
    }
  }, []);

  const handleRun = useCallback(async () => {
    setState({ kind: 'running' });
    try {
      if (!renderStill) {
        throw new CritiqueError('missing-render', 'Capture the current render first.');
      }
      if (!selectedNode || selectedNode.kind !== 'file' || !selectedNode.preview || !selectedNode.previewKind) {
        throw new CritiqueError('missing-reference', 'Select a reference image or video first.');
      }

      let references: StillImage[];
      if (selectedNode.previewKind === 'image') {
        references = [await loadImageStill(selectedNode.preview, selectedNode.name)];
      } else {
        const timestamps = parseTimestampSeconds(timestampsInput);
        if (timestamps.length === 0) {
          throw new CritiqueError(
            'missing-reference',
            'Enter at least one sample timestamp (seconds) for the reference video.',
          );
        }
        references = await extractVideoStills(selectedNode.preview, timestamps, createBrowserVideoFrameExtractorDeps());
      }

      const result = await runCritique({ config: critique, render: renderStill, references });
      setState({ kind: 'done', result });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'The critique run failed.',
      });
    }
  }, [renderStill, selectedNode, timestampsInput, critique]);

  const running = state.kind === 'running';

  return (
    <div className="sg-critique">
      <h2 className="sg-critique__title">Reference critique</h2>

      {!hasApiKey && (
        <p className="sg-critique__hint sg-critique__hint--warn">
          No Anthropic API key configured — add one under Project Settings → Reference critique before running.
        </p>
      )}

      <section className="sg-critique__section">
        <h3 className="sg-critique__section-title">1. Render</h3>
        <button type="button" className="sg-btn" onClick={handleCapture}>
          Capture current render
        </button>
        {renderStill && <img className="sg-critique__preview" src={renderStill.dataUrl} alt="Captured render" />}
      </section>

      <section className="sg-critique__section">
        <h3 className="sg-critique__section-title">2. Reference</h3>
        <ReferencePicker
          selectedRootId={selectedRef?.rootId ?? null}
          selectedNodeId={selectedRef?.nodeId ?? null}
          onSelect={handleSelect}
        />
        {selectedNode?.previewKind === 'image' && selectedNode.preview && (
          <img className="sg-critique__preview" src={selectedNode.preview} alt={selectedNode.name} />
        )}
        {selectedNode?.previewKind === 'video' && selectedNode.preview && (
          <>
            {/* This ON-SCREEN video is purely for the human to preview their
                choice — an entirely separate element from the OFFSCREEN
                video `extractVideoStills` creates internally for frame
                extraction (see `videoFrames.ts`); this one is never used as
                a frame-extraction source. */}
            <video className="sg-critique__preview" src={selectedNode.preview} muted playsInline controls />
            <label className="sg-critique__field-label">
              Sample timestamps (seconds, comma-separated)
              <input
                type="text"
                className="sg-field"
                value={timestampsInput}
                onChange={(e) => setTimestampsInput(e.target.value)}
              />
            </label>
          </>
        )}
      </section>

      <button
        type="button"
        className="sg-btn sg-critique__run"
        onClick={() => void handleRun()}
        disabled={running || !renderStill || !selectedNode}
      >
        {running ? 'Running critique…' : 'Run critique'}
      </button>

      {state.kind === 'error' && <p className="sg-critique__error">{state.message}</p>}

      {state.kind === 'done' && (
        <div className="sg-critique__result">
          <p
            className={`sg-critique__verdict sg-critique__verdict--${state.result.verdict}`}
          >
            {state.result.verdict.toUpperCase()}
          </p>
          <p className="sg-critique__reasoning">{state.result.reasoning}</p>
        </div>
      )}
    </div>
  );
}
