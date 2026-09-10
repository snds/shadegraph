// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Asset browser panel
// ───────────────────────────────────────────────────────────────────────────
// Bare content (no toggle, no overlay, no own `open` state) over the
// connected asset folder(s) — mounted as the "Assets" pivot in the shell's
// pivot rail (`src/ui/shell/pivotItems.tsx`), which owns whether this is on
// screen. Reads/calls `src/storage`'s public surface only —
// `AssetTreeNode`'s plain `{ name, kind, preview? }`-shaped data and the
// store's action methods. Never imports a `FileSystemHandle`, a stream, or a
// blob URL directly; `preview` here is just the string URL the store already
// produced.
//
// MULTIPLE folders can be connected at once (`useAssetStore`'s `roots`).
// `AssetRootStrip` below is the Figma-"Pages"-tab-like affordance: one entry
// per connected folder, independently addable (its own "+") and removable
// (its own "×"). Only one root's tree renders at a time — `activeRootId` is
// local UI state, not store state, since "which folder is currently being
// browsed" has no bearing on the document/manifest.
//
// The tree itself is additionally filtered to "only folders that lead to a
// recognized file, and only recognized files themselves" — `root.visibleIds`,
// computed by the store's connect-time structural scan
// (`src/storage/recognitionVisibility.ts`) — passed straight through to
// `flattenVisibleTree`'s third argument.
//
// Boots by calling `reconnectFromStorage()` once on mount, so every
// previously-connected folder (persisted handle, permission already granted)
// is ready without the user re-picking it every session, per the task's
// definition of done. Since the pivot host only mounts the active pivot's
// content, this effect re-runs each time the Assets pivot is (re-)selected —
// `reconnectFromStorage` is itself idempotent per root id, so that's harmless.
//
// The "graph this" action (Phase 5 Wave 5b, the last missing link between
// `graphFromRecognizedObject()`/the manifest store and an actual user-facing
// feature) is wired here too. The orchestration itself is pure and lives in
// `./graphThis.ts` — this component only supplies the button, the real
// `useEditorStore`/`useManifestStore` getters, and surfacing the result.
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { flattenVisibleTree, useAssetStore, type AssetRoot, type AssetTreeNode } from '../../storage';
import type { RecognizedShaderObject } from '../../storage/recognition';
import { Icon } from '../shell/Icon';
import { useManifestStore } from '../manifest/manifestStore';
import { useEditorStore } from '../store';
import { assetThumbnailKey, planAssetThumbnail, type AssetThumbnailPlan } from './assetThumbnailPlan';
import { cacheAutoGraphDocument, clearAutoGraphDocument, getCachedAutoGraphNode } from './autoGraphCache';
import { graphThis, type GraphThisResult } from './graphThis';
import { useVirtualRows } from './useVirtualRows';
import './assetBrowser.css';

const ROW_HEIGHT = 28;
const THUMBNAIL_SIZE = 64;
const EMPTY_NODES: Record<string, AssetTreeNode> = {};
const EMPTY_IDS: string[] = [];

/** Every currently-mounted, renderable asset row, so `setVisibleAssetThumbnails`
 *  always reflects every on-screen row rather than just whichever one most
 *  recently mounted/unmounted — same module-level-`Set` treatment
 *  `ShaderNodeCard.tsx`'s `visibleNodeIds`/`LayerStack.tsx`'s
 *  `visibleStackIds` already use for their own disjoint id spaces. */
const visibleAssetKeys = new Set<string>();

/** Requests (and caches) one row's auto-graphed thumbnail through the ONE
 *  shared preview renderer (`store.previewRenderer`) — never a second
 *  compile/render path. Deliberately a single request per `[key, plan]`
 *  change, NOT a continuous `requestAnimationFrame` poll like
 *  `ShaderNodeCard.tsx`/`LayerStack.tsx`'s live thumbnails: an auto-graphed
 *  file's source text never changes out from under an open session (no file
 *  watcher), so there is nothing to keep polling for — the scheduler's own
 *  `signature` cache key (not a poll loop) is what "only when the underlying
 *  file actually changed" means here. Only removes `key` from the VISIBLE
 *  set on unmount (so GPU budget stops being spent on an off-screen row) —
 *  it deliberately does NOT call `releaseAssetThumbnail` on every scroll-out,
 *  since that would defeat the whole point of the cache (a plain re-mount
 *  would force a full re-render every time); see
 *  `releaseAssetThumbnailsForRoot` below for the one place entries are
 *  actually dropped (disconnecting a folder for good). */
function useAssetThumbnailFrame(key: string, plan: AssetThumbnailPlan): HTMLCanvasElement | null {
  const renderer = useEditorStore((s) => s.previewRenderer);
  const [frame, setFrame] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!renderer || plan.kind !== 'render') return;

    // "Formalize, don't discard": record the exact throwaway document this
    // render pass is about to compile, so a later "graph this" click on the
    // SAME object (see `handleGraphThis`'s `getCachedAutoGraphNode`) can
    // reuse its already-built node instead of re-deriving one.
    cacheAutoGraphDocument(key, plan.signature, plan.doc);

    visibleAssetKeys.add(key);
    renderer.setVisibleAssetThumbnails([...visibleAssetKeys]);

    let cancelled = false;
    renderer
      .requestAssetThumbnail({ key, doc: plan.doc, signature: plan.signature, size: THUMBNAIL_SIZE })
      .then((result) => {
        if (!cancelled && result instanceof HTMLCanvasElement) setFrame(result);
      })
      .catch(() => {
        // A compile/render failure for an auto-graphed throwaway document —
        // leave `frame` as-is (null on the very first failure, so the row
        // falls through to the generic icon; the last good frame if this was
        // a re-render of an already-succeeded entry).
      });

    return () => {
      cancelled = true;
      visibleAssetKeys.delete(key);
      renderer.setVisibleAssetThumbnails([...visibleAssetKeys]);
    };
  }, [key, plan, renderer]);

  return plan.kind === 'render' ? frame : null;
}

/** Releases every recognized file's cached auto-graph thumbnail for ONE
 *  connected root — the thumbnail-cache counterpart of `assetStore.ts`'s own
 *  per-root `releasePreview` cleanup on disconnect, so disconnecting (and
 *  potentially later reconnecting a DIFFERENT folder that happens to reuse
 *  colliding relative paths under a fresh root id — impossible by
 *  construction here since `assetThumbnailKey` embeds `rootId`, but freeing
 *  the memory is still the right thing to do) never leaves stale GPU-side
 *  render targets referenced forever. */
function releaseAssetThumbnailsForRoot(root: AssetRoot | undefined): void {
  if (!root) return;
  const renderer = useEditorStore.getState().previewRenderer;
  if (!renderer) return;
  for (const node of Object.values(root.nodesById)) {
    if (node.kind !== 'file') continue;
    const key = assetThumbnailKey(root.id, node.id);
    renderer.releaseAssetThumbnail(key);
    clearAutoGraphDocument(key);
  }
}

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
  const roots = useAssetStore((s) => s.roots);
  const reconnectFromStorage = useAssetStore((s) => s.reconnectFromStorage);
  const connect = useAssetStore((s) => s.connect);
  const grantPermission = useAssetStore((s) => s.grantPermission);
  const disconnect = useAssetStore((s) => s.disconnect);

  const [activeRootId, setActiveRootId] = useState<string | undefined>(undefined);
  const [graphThisMessage, setGraphThisMessage] = useState<GraphThisMessage | null>(null);

  useEffect(() => {
    // Once, at boot, regardless of whether the panel is open yet — so every
    // granted-permission root is already listed the first time the user
    // opens the panel, and a "grant permission" affordance is ready
    // immediately for the rest. `reconnectFromStorage` never prompts the
    // native picker itself (no user gesture available here).
    void reconnectFromStorage();
  }, [reconnectFromStorage]);

  // Keeps `activeRootId` pointed at a real strip entry: defaults to the
  // first connected folder once any exist, and falls back to whatever
  // remains if the active one is removed out from under the strip
  // (`disconnect`) — never left dangling on a stale/removed id.
  useEffect(() => {
    if (roots.length === 0) {
      if (activeRootId !== undefined) setActiveRootId(undefined);
      return;
    }
    if (!roots.some((r) => r.id === activeRootId)) {
      setActiveRootId(roots[0].id);
    }
  }, [roots, activeRootId]);

  const activeRoot = roots.find((r) => r.id === activeRootId);

  // Not a hook-level selector: read fresh at click time, same treatment as
  // every other `useEditorStore`/`useManifestStore` access inside this
  // handler — `graphThis` itself decides exactly when each is read
  // (documented on `GraphThisDeps`), so nothing here should trigger a
  // re-render of its own.
  const handleGraphThis = useCallback((rootId: string, node: AssetTreeNode, object: RecognizedShaderObject) => {
    if (node.sourceText === undefined) return; // recognized nodes always carry this; defensive only
    const root = useAssetStore.getState().roots.find((r) => r.id === rootId);
    const connectedFolderName = root?.rootName ?? 'Connected folder';
    const sourceText = node.sourceText;
    const result = graphThis(object, sourceText, connectedFolderName, {
      getDocument: () => useEditorStore.getState().doc,
      getManifest: () => useManifestStore.getState().manifest,
      addPreparedNode: (n) => useEditorStore.getState().addPreparedNode(n),
      ensureConnectedFolder: (name) => useManifestStore.getState().ensureConnectedFolder(name),
      ensureDiscoveredObject: (input) => useManifestStore.getState().ensureDiscoveredObject(input),
      setDiscoveredObjectDraft: (id, draft) => useManifestStore.getState().setDiscoveredObjectDraft(id, draft),
      // "Formalize, don't discard": reuse the background auto-graph thumbnail
      // pass's already-built node for this object, if the cache still has
      // one for this exact (rootId, nodeId) + unchanged source text.
      getCachedAutoGraphNode: () => getCachedAutoGraphNode(assetThumbnailKey(rootId, node.id), sourceText, object.name),
    });
    setGraphThisMessage(messageFor(object, result));
  }, []);

  // Frees this root's cached auto-graph thumbnails BEFORE the store forgets
  // the root entirely (`disconnect` clears `nodesById`) — reading fresh here
  // rather than closing over `roots` keeps this correct even if `roots`
  // hasn't re-rendered into scope yet.
  const handleRemoveRoot = useCallback((id: string) => {
    releaseAssetThumbnailsForRoot(useAssetStore.getState().roots.find((r) => r.id === id));
    void disconnect(id);
  }, [disconnect]);

  return (
    <div className="sg-assets-panel-content" aria-label="Asset folder browser">
      <header className="sg-assets-panel__head">
        <span className="sg-assets-panel__title">{activeRoot?.rootName ?? 'No folder connected'}</span>
      </header>

      {roots.length > 0 ? (
        <AssetRootStrip
          roots={roots}
          activeRootId={activeRootId}
          onSelect={setActiveRootId}
          onAdd={() => void connect()}
          onRemove={handleRemoveRoot}
        />
      ) : null}

      <div className="sg-assets-panel__body">
        {roots.length === 0 ? (
          <div className="sg-assets-empty">
            <p>Connect a local folder to browse reference media.</p>
            <button type="button" className="sg-assets-connect" onClick={() => void connect()}>
              Connect folder…
            </button>
          </div>
        ) : null}

        {activeRoot && activeRoot.status === 'connecting' ? <p className="sg-assets-empty">Connecting…</p> : null}

        {activeRoot && activeRoot.status === 'needsPermission' ? (
          <div className="sg-assets-empty">
            <p>Re-grant access to “{activeRoot.rootName}” to continue.</p>
            <button type="button" className="sg-assets-connect" onClick={() => void grantPermission(activeRoot.id)}>
              Grant permission
            </button>
          </div>
        ) : null}

        {activeRoot && activeRoot.status === 'error' ? (
          <div className="sg-assets-empty">
            <p className="sg-assets-error">{activeRoot.error ?? 'Something went wrong.'}</p>
            <button type="button" className="sg-assets-disconnect" onClick={() => void disconnect(activeRoot.id)}>
              Remove this folder
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

        {activeRoot && activeRoot.status === 'connected' ? (
          <AssetTreeView key={activeRoot.id} rootId={activeRoot.id} onGraphThis={handleGraphThis} />
        ) : null}
      </div>
    </div>
  );
}

/** The connected-folders strip — one entry per `AssetRoot`, the Assets
 *  panel's equivalent of Figma's Layers-panel "Pages" tab: a list of named
 *  entries you switch between, each independently addable (the trailing "+")
 *  and removable (each entry's own "×"). Clicking an entry (not its remove
 *  button) makes it the active, browsed root. */
function AssetRootStrip({
  roots,
  activeRootId,
  onSelect,
  onAdd,
  onRemove,
}: {
  roots: AssetRoot[];
  activeRootId: string | undefined;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="sg-assets-strip" role="tablist" aria-label="Connected folders">
      {roots.map((root) => (
        <div
          key={root.id}
          className={
            root.id === activeRootId
              ? 'sg-assets-strip__item sg-assets-strip__item--active'
              : 'sg-assets-strip__item'
          }
        >
          <button
            type="button"
            role="tab"
            aria-selected={root.id === activeRootId}
            className="sg-assets-strip__label"
            onClick={() => onSelect(root.id)}
            title={root.rootName ?? 'Connecting…'}
          >
            {root.status === 'error' || root.status === 'needsPermission' ? (
              <Icon name={root.status === 'error' ? 'error' : 'lock'} />
            ) : null}
            <span className="sg-assets-strip__name">{root.rootName ?? 'Connecting…'}</span>
          </button>
          <button
            type="button"
            className="sg-assets-strip__remove"
            onClick={(event) => {
              event.stopPropagation();
              onRemove(root.id);
            }}
            aria-label={`Disconnect ${root.rootName ?? 'this folder'}`}
          >
            <Icon name="close" />
          </button>
        </div>
      ))}
      <button type="button" className="sg-assets-strip__add" onClick={onAdd} aria-label="Connect another folder">
        <Icon name="add" />
      </button>
    </div>
  );
}

/** The virtualized, lazily-expanding tree for ONE connected root, filtered to
 *  `root.visibleIds` — "only folders that lead to a recognized file, and only
 *  recognized files themselves" (this task's Definition of Done). Split out
 *  from `AssetBrowserPanel` so its mount/unmount lifecycle (tied to the
 *  `activeRoot.status === 'connected'` branch above, keyed by `rootId` so
 *  switching strip entries remounts it) is what drives releasing every
 *  still-visible preview URL — disconnecting, switching folders, or closing
 *  the panel unmounts this and runs that cleanup. */
function AssetTreeView({
  rootId,
  onGraphThis,
}: {
  rootId: string;
  onGraphThis: (rootId: string, node: AssetTreeNode, object: RecognizedShaderObject) => void;
}) {
  const root = useAssetStore((s) => s.roots.find((r) => r.id === rootId));
  const toggleExpand = useAssetStore((s) => s.toggleExpand);
  const loadPreview = useAssetStore((s) => s.loadPreview);
  const releasePreview = useAssetStore((s) => s.releasePreview);
  const recognizeNode = useAssetStore((s) => s.recognizeNode);

  const nodesById = root?.nodesById ?? EMPTY_NODES;
  const rootIds = root?.rootIds ?? EMPTY_IDS;
  const visibleIds = root?.visibleIds;

  const flat = useMemo(
    () => flattenVisibleTree(nodesById, rootIds, visibleIds),
    [nodesById, rootIds, visibleIds],
  );
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
        void loadPreview(rootId, id);
        // Recognition follows the same "dirty + visible only" discipline as
        // preview loading: a file's text is only ever read once it scrolls
        // into view, never as part of listing/expanding its parent folder.
        void recognizeNode(rootId, id);
      }
    }
    for (const id of prevVisible) {
      if (!nextVisible.has(id)) releasePreview(rootId, id);
    }
    visibleFileIdsRef.current = nextVisible;
  }, [flat, range.startIndex, range.endIndex, loadPreview, releasePreview, recognizeNode, rootId]);

  useEffect(
    () => () => {
      // Unmount cleanup only (panel closed / folder switched / disconnected
      // while previews were on screen) — the per-render effect above already
      // handles ordinary scroll/expand deltas.
      for (const id of visibleFileIdsRef.current) releasePreview(rootId, id);
      visibleFileIdsRef.current = new Set();
    },
    [releasePreview, rootId],
  );

  if (flat.length === 0) {
    return <p className="sg-assets-empty">No recognizable files in this folder.</p>;
  }

  const rows = flat.slice(range.startIndex, range.endIndex);

  return (
    <div ref={containerRef} className="sg-assets-list" role="tree" aria-label="Connected folder contents">
      <div className="sg-assets-list__spacer" style={{ height: range.totalHeight }}>
        <div className="sg-assets-list__window" style={{ transform: `translateY(${range.offsetY}px)` }}>
          {rows.map((node) => (
            <AssetRow
              key={node.id}
              rootId={rootId}
              node={node}
              onToggle={(id) => toggleExpand(rootId, id)}
              onGraphThis={(n, object) => onGraphThis(rootId, n, object)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The rendered `<canvas>` half of a `'render'`-plan thumbnail — mirrors
 *  `LayerStack.tsx`'s `LayerThumbnail` exactly (blit the resolved frame into
 *  a fixed-size canvas via `drawImage`), just reusing the row's existing
 *  `.sg-assets-row__thumb` sizing class instead of a Layers-panel-specific
 *  one. */
function AssetThumbnailCanvas({ frame }: { frame: HTMLCanvasElement }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  }, [frame]);

  return (
    <canvas
      ref={canvasRef}
      width={THUMBNAIL_SIZE}
      height={THUMBNAIL_SIZE}
      className="sg-assets-row__thumb"
      aria-hidden="true"
    />
  );
}

function AssetRow({
  rootId,
  node,
  onToggle,
  onGraphThis,
}: {
  rootId: string;
  node: AssetTreeNode;
  onToggle: (id: string) => Promise<void>;
  onGraphThis: (node: AssetTreeNode, object: RecognizedShaderObject) => void;
}) {
  const isFolder = node.kind === 'folder';
  const recognizedObjects = node.recognizedObjects ?? [];

  // Cheap + pure (no I/O — `buildAutoGraphDocument` only ever touches
  // already-in-memory `recognizedObjects`/`sourceText`), but still memoised
  // so an unrelated sibling row's store update doesn't rebuild/re-request
  // this row's throwaway document on every render.
  const plan = useMemo(
    () => planAssetThumbnail(node),
    [node.kind, node.recognized, node.recognizedObjects, node.sourceText],
  );
  const thumbnailKey = useMemo(() => assetThumbnailKey(rootId, node.id), [rootId, node.id]);
  const frame = useAssetThumbnailFrame(thumbnailKey, plan);

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
      ) : plan.kind === 'render' && frame ? (
        <AssetThumbnailCanvas frame={frame} />
      ) : (
        <span className="sg-assets-row__icon" aria-hidden="true">
          {/* `'fallback'` (a recognized object `graphFromRecognizedObject`
             refused, e.g. missing-requires) AND `'render'`-but-not-yet-
             resolved (still compiling in the background) both show this
             SAME consolidated generic node icon — this task's Definition of
             Done explicitly rules out a broken/blank cell for either case. */}
          <Icon name={isFolder ? 'folder' : plan.kind !== 'none' ? 'account_tree' : 'draft'} />
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
