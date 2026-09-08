// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Asset browser panel
// ───────────────────────────────────────────────────────────────────────────
// A toggleable, self-mounting pane (same shape as `CodePanel.tsx`) over the
// connected asset folder. Reads/calls `src/storage`'s public surface only —
// `AssetTreeNode`'s plain `{ name, kind, preview? }`-shaped data and the
// store's action methods. Never imports a `FileSystemHandle`, a stream, or a
// blob URL directly; `preview` here is just the string URL the store already
// produced.
//
// Boots by calling `reconnectFromStorage()` once on mount, so a previously-
// connected folder (persisted handle, permission already granted) is ready
// without the user re-picking it every session, per the task's definition of
// done.
//
// Mounted from `src/main.tsx`, not `src/ui/App.tsx` — App.tsx is an existing
// Phase 1-3 file this task was scoped to leave untouched; mounting a second,
// fully independent React tree at the root is the least invasive way to get
// this self-contained pane on screen. See `src/main.tsx` for the one-line
// addition.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState } from 'react';

import { flattenVisibleTree, useAssetStore, type AssetTreeNode } from '../../storage';
import { useVirtualRows } from './useVirtualRows';
import './assetBrowser.css';

const ROW_HEIGHT = 28;

export function AssetBrowserPanel() {
  const [open, setOpen] = useState(false);
  const status = useAssetStore((s) => s.status);
  const error = useAssetStore((s) => s.error);
  const rootName = useAssetStore((s) => s.rootName);
  const reconnectFromStorage = useAssetStore((s) => s.reconnectFromStorage);
  const connect = useAssetStore((s) => s.connect);
  const grantPermission = useAssetStore((s) => s.grantPermission);
  const disconnect = useAssetStore((s) => s.disconnect);

  useEffect(() => {
    // Once, at boot, regardless of whether the panel is open yet — so a
    // granted-permission root is already listed the first time the user
    // opens the panel, and a "grant permission" affordance is ready
    // immediately otherwise. `reconnectFromStorage` never prompts the
    // native picker itself (no user gesture available here).
    void reconnectFromStorage();
  }, [reconnectFromStorage]);

  return (
    <div className="sg-assets-dock">
      <button
        type="button"
        className="sg-assets-toggle"
        aria-pressed={open}
        aria-label={open ? 'Hide asset browser' : 'Show asset browser'}
        onClick={() => setOpen((v) => !v)}
      >
        Assets
        {status === 'connected' ? <span className="sg-assets-toggle__dot" aria-hidden="true" /> : null}
      </button>

      {open ? (
        <aside className="sg-assets-panel" aria-label="Asset folder browser">
          <header className="sg-assets-panel__head">
            <span className="sg-assets-panel__title">{rootName ?? 'No folder connected'}</span>
            <button
              type="button"
              className="sg-assets-panel__close"
              onClick={() => setOpen(false)}
              aria-label="Close asset browser"
            >
              ×
            </button>
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

            {status === 'connected' ? <AssetTreeView /> : null}
          </div>

          {status === 'connected' ? (
            <footer className="sg-assets-panel__foot">
              <button type="button" className="sg-assets-disconnect" onClick={() => void disconnect()}>
                Disconnect
              </button>
            </footer>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

/** The virtualized, lazily-expanding tree. Split out from `AssetBrowserPanel`
 *  so its mount/unmount lifecycle (tied to the `status === 'connected'`
 *  branch above) is what drives releasing every still-visible preview URL —
 *  disconnecting or closing the panel unmounts this and runs that cleanup. */
function AssetTreeView() {
  const nodesById = useAssetStore((s) => s.nodesById);
  const rootIds = useAssetStore((s) => s.rootIds);
  const toggleExpand = useAssetStore((s) => s.toggleExpand);
  const loadPreview = useAssetStore((s) => s.loadPreview);
  const releasePreview = useAssetStore((s) => s.releasePreview);

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
      if (!prevVisible.has(id)) void loadPreview(id);
    }
    for (const id of prevVisible) {
      if (!nextVisible.has(id)) releasePreview(id);
    }
    visibleFileIdsRef.current = nextVisible;
  }, [flat, range.startIndex, range.endIndex, loadPreview, releasePreview]);

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
            <AssetRow key={node.id} node={node} onToggle={toggleExpand} />
          ))}
        </div>
      </div>
    </div>
  );
}

function AssetRow({ node, onToggle }: { node: AssetTreeNode; onToggle: (id: string) => Promise<void> }) {
  const isFolder = node.kind === 'folder';
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
          {node.loadingChildren ? '…' : node.expanded ? '▾' : '▸'}
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
          {isFolder ? '▤' : '‖'}
        </span>
      )}

      <span className="sg-assets-row__name" title={node.name}>
        {node.name}
      </span>
    </div>
  );
}
