// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Asset browser panel
// ───────────────────────────────────────────────────────────────────────────
// Bare content (no toggle, no overlay, no own `open` state) over the
// connected asset folder — mounted as the "Assets" pivot in the shell's
// pivot rail (`src/ui/shell/pivotItems.tsx`), which owns whether this is on
// screen. Reads/calls `src/storage`'s public surface only —
// `AssetTreeNode`'s plain `{ name, kind, preview? }`-shaped data and the
// store's action methods. Never imports a `FileSystemHandle`, a stream, or a
// blob URL directly; `preview` here is just the string URL the store already
// produced.
//
// Boots by calling `reconnectFromStorage()` once on mount, so a previously-
// connected folder (persisted handle, permission already granted) is ready
// without the user re-picking it every session, per the task's definition of
// done. Since the pivot host only mounts the active pivot's content, this
// effect re-runs each time the Assets pivot is (re-)selected — cheap and
// idempotent, so that's harmless.
//
// The "graph this" action (Phase 5 Wave 5b, the last missing link between
// `graphFromRecognizedObject()`/the manifest store and an actual user-facing
// feature) is wired here too. The orchestration itself is pure and lives in
// `./graphThis.ts` — this component only supplies the button, the real
// `useEditorStore`/`useManifestStore` getters, and surfacing the result.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { flattenVisibleTree, useAssetStore, type AssetTreeNode } from '../../storage';
import type { RecognizedShaderObject } from '../../storage/recognition';
import { Icon } from '../shell/Icon';
import { useManifestStore } from '../manifest/manifestStore';
import { useEditorStore } from '../store';
import { graphThis, type GraphThisResult } from './graphThis';
import { useVirtualRows } from './useVirtualRows';
import './assetBrowser.css';

const ROW_HEIGHT = 28;

/** A "graph this" outcome worth telling the user about. `missing-requires`
 *  is the one refusal this task's brief explicitly requires surfacing
 *  visibly (never a silent no-op); `success`/`error` are shown the same way
 *  for consistency, not because the brief asked for those specifically. */
interface GraphThisMessage {
  kind: 'success' | 'missing-requires' | 'error';
  text: string;
}

function messageFor(object: RecognizedShaderObject, result: GraphThisResult): GraphThisMessage {
  if (result.ok) {
    return { kind: 'success', text: `Graphed "${object.name}" — added to the document as a draft.` };
  }
  if (result.reason === 'missing-requires') {
    return {
      kind: 'missing-requires',
      text: `Can't graph "${object.name}" yet — it requires ${result.missing.join(', ')} to be graphed first.`,
    };
  }
  return { kind: 'error', text: `Couldn't graph "${object.name}": no active layer to add it to.` };
}

export function AssetBrowserPanel() {
  const status = useAssetStore((s) => s.status);
  const error = useAssetStore((s) => s.error);
  const rootName = useAssetStore((s) => s.rootName);
  const reconnectFromStorage = useAssetStore((s) => s.reconnectFromStorage);
  const connect = useAssetStore((s) => s.connect);
  const grantPermission = useAssetStore((s) => s.grantPermission);
  const disconnect = useAssetStore((s) => s.disconnect);

  const [graphThisMessage, setGraphThisMessage] = useState<GraphThisMessage | null>(null);

  // Not a hook-level selector: read fresh at click time, same treatment as
  // every other `useEditorStore`/`useManifestStore` access inside this
  // handler — `graphThis` itself decides exactly when each is read
  // (documented on `GraphThisDeps`), so nothing here should trigger a
  // re-render of its own.
  const handleGraphThis = useCallback((node: AssetTreeNode, object: RecognizedShaderObject) => {
    if (node.sourceText === undefined) return; // recognized nodes always carry this; defensive only
    const connectedFolderName = useAssetStore.getState().rootName ?? 'Connected folder';
    const result = graphThis(object, node.sourceText, connectedFolderName, {
      getDocument: () => useEditorStore.getState().doc,
      getManifest: () => useManifestStore.getState().manifest,
      addPreparedNode: (n) => useEditorStore.getState().addPreparedNode(n),
      ensureConnectedFolder: (name) => useManifestStore.getState().ensureConnectedFolder(name),
      ensureDiscoveredObject: (input) => useManifestStore.getState().ensureDiscoveredObject(input),
      setDiscoveredObjectDraft: (id, draft) => useManifestStore.getState().setDiscoveredObjectDraft(id, draft),
    });
    setGraphThisMessage(messageFor(object, result));
  }, []);

  useEffect(() => {
    // Once, at boot, regardless of whether the panel is open yet — so a
    // granted-permission root is already listed the first time the user
    // opens the panel, and a "grant permission" affordance is ready
    // immediately otherwise. `reconnectFromStorage` never prompts the
    // native picker itself (no user gesture available here).
    void reconnectFromStorage();
  }, [reconnectFromStorage]);

  return (
    <div className="sg-assets-panel-content" aria-label="Asset folder browser">
      <header className="sg-assets-panel__head">
        <span className="sg-assets-panel__title">{rootName ?? 'No folder connected'}</span>
      </header>

      <div className="sg-assets-panel__body">
        {status === 'disconnected' ? (
          <div className="sg-assets-empty">
            <p>Connect a local folder to browse reference media.</p>
            <button type="button" className="sg-assets-connect" onClick={() => void connect()}>
              Connect folder…
            </button>
          </div>
        ) : null}

        {status === 'connecting' ? <p className="sg-assets-empty">Connecting…</p> : null}

        {status === 'needsPermission' ? (
          <div className="sg-assets-empty">
            <p>Re-grant access to “{rootName}” to continue.</p>
            <button type="button" className="sg-assets-connect" onClick={() => void grantPermission()}>
              Grant permission
            </button>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className="sg-assets-empty">
            <p className="sg-assets-error">{error ?? 'Something went wrong.'}</p>
            <button type="button" className="sg-assets-connect" onClick={() => void connect()}>
              Connect a different folder…
            </button>
          </div>
        ) : null}

        {graphThisMessage ? (
          <div
            className={`sg-assets-graph-message sg-assets-graph-message--${graphThisMessage.kind}`}
            role={graphThisMessage.kind === 'missing-requires' ? 'alert' : 'status'}
          >
            <span>{graphThisMessage.text}</span>
            <button
              type="button"
              className="sg-assets-graph-message__dismiss"
              onClick={() => setGraphThisMessage(null)}
              aria-label="Dismiss"
            >
              <Icon name="close" />
            </button>
          </div>
        ) : null}

        {status === 'connected' ? <AssetTreeView onGraphThis={handleGraphThis} /> : null}
      </div>

      {status === 'connected' ? (
        <footer className="sg-assets-panel__foot">
          <button type="button" className="sg-assets-disconnect" onClick={() => void disconnect()}>
            Disconnect
          </button>
        </footer>
      ) : null}
    </div>
  );
}

/** The virtualized, lazily-expanding tree. Split out from `AssetBrowserPanel`
 *  so its mount/unmount lifecycle (tied to the `status === 'connected'`
 *  branch above) is what drives releasing every still-visible preview URL —
 *  disconnecting or closing the panel unmounts this and runs that cleanup. */
function AssetTreeView({
  onGraphThis,
}: {
  onGraphThis: (node: AssetTreeNode, object: RecognizedShaderObject) => void;
}) {
  const nodesById = useAssetStore((s) => s.nodesById);
  const rootIds = useAssetStore((s) => s.rootIds);
  const toggleExpand = useAssetStore((s) => s.toggleExpand);
  const loadPreview = useAssetStore((s) => s.loadPreview);
  const releasePreview = useAssetStore((s) => s.releasePreview);
  const recognizeNode = useAssetStore((s) => s.recognizeNode);

  const flat = useMemo(() => flattenVisibleTree(nodesById, rootIds), [nodesById, rootIds]);
  const { containerRef, range } = useVirtualRows(flat.length, ROW_HEIGHT);

  // Tracks which file rows were visible after the last effect run, so a
  // range/tree change only issues `loadPreview`/`releasePreview` for the
  // delta — never a duplicate acquire, never a leaked release.
  const visibleFileIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const nextVisible = new Set<string>();
    for (let i = range.startIndex; i < range.endIndex; i += 1) {
      const node = flat[i];
      if (node && node.kind === 'file') nextVisible.add(node.id);
    }
    const prevVisible = visibleFileIdsRef.current;
    for (const id of nextVisible) {
      if (!prevVisible.has(id)) {
        void loadPreview(id);
        // Recognition follows the same "dirty + visible only" discipline as
        // preview loading: a file's text is only ever read once it scrolls
        // into view, never as part of listing/expanding its parent folder.
        void recognizeNode(id);
      }
    }
    for (const id of prevVisible) {
      if (!nextVisible.has(id)) releasePreview(id);
    }
    visibleFileIdsRef.current = nextVisible;
  }, [flat, range.startIndex, range.endIndex, loadPreview, releasePreview, recognizeNode]);

  useEffect(
    () => () => {
      // Unmount cleanup only (panel closed / folder disconnected while
      // previews were on screen) — the per-render effect above already
      // handles ordinary scroll/expand deltas.
      for (const id of visibleFileIdsRef.current) releasePreview(id);
      visibleFileIdsRef.current = new Set();
    },
    [releasePreview],
  );

  if (flat.length === 0) {
    return <p className="sg-assets-empty">This folder is empty.</p>;
  }

  const rows = flat.slice(range.startIndex, range.endIndex);

  return (
    <div ref={containerRef} className="sg-assets-list" role="tree" aria-label="Connected folder contents">
      <div className="sg-assets-list__spacer" style={{ height: range.totalHeight }}>
        <div className="sg-assets-list__window" style={{ transform: `translateY(${range.offsetY}px)` }}>
          {rows.map((node) => (
            <AssetRow key={node.id} node={node} onToggle={toggleExpand} onGraphThis={onGraphThis} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AssetRow({
  node,
  onToggle,
  onGraphThis,
}: {
  node: AssetTreeNode;
  onToggle: (id: string) => Promise<void>;
  onGraphThis: (node: AssetTreeNode, object: RecognizedShaderObject) => void;
}) {
  const isFolder = node.kind === 'folder';
  const recognizedObjects = node.recognizedObjects ?? [];
  return (
    <div
      className="sg-assets-row"
      style={{ height: ROW_HEIGHT, paddingLeft: 8 + node.depth * 16 }}
      role="treeitem"
      aria-expanded={isFolder ? node.expanded : undefined}
    >
      {isFolder ? (
        <button
          type="button"
          className="sg-assets-row__disclosure"
          onClick={() => void onToggle(node.id)}
          aria-label={node.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
        >
          {node.loadingChildren ? (
            <Icon name="progress_activity" />
          ) : (
            <Icon name={node.expanded ? 'expand_more' : 'chevron_right'} />
          )}
        </button>
      ) : (
        <span className="sg-assets-row__spacer" aria-hidden="true" />
      )}

      {node.previewKind === 'image' && node.preview ? (
        <img className="sg-assets-row__thumb" src={node.preview} alt="" />
      ) : node.previewKind === 'video' && node.preview ? (
        <video className="sg-assets-row__thumb" src={node.preview} muted playsInline />
      ) : (
        <span className="sg-assets-row__icon" aria-hidden="true">
          <Icon name={isFolder ? 'folder' : 'draft'} />
        </span>
      )}

      <span className="sg-assets-row__name" title={node.name}>
        {node.name}
      </span>

      {node.recognized ? (
        <span className="sg-assets-row__recognized" title="Recognized as a shader object">
          shader
        </span>
      ) : null}

      {recognizedObjects.map((object) => (
        <button
          key={object.id}
          type="button"
          className="sg-assets-row__graph-btn"
          // Only ONE object graphed per click — never a bulk "graph all"
          // affordance, per this task's own scope. A row with more than one
          // recognized object (a bundled-chunk `RecognitionConfig`) gets one
          // button per object instead, each still a single-object action.
          onClick={(event) => {
            event.stopPropagation();
            onGraphThis(node, object);
          }}
          title={`Graph "${object.name}" into the active document`}
        >
          {recognizedObjects.length > 1 ? `Graph "${object.name}"` : 'Graph this'}
        </button>
      ))}
    </div>
  );
}
