// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: connection + lazy tree store
// ───────────────────────────────────────────────────────────────────────────
// Owns the one connected asset root end to end: picking/persisting the
// directory handle, lazy per-folder listing, and preview object-URL
// lifecycle. This is the ONLY place a `FileSystemDirectoryHandle` or a
// `DirectoryReader` lives — `currentHandle`/`currentReader` are closure-
// private to `createAssetStore`, not part of the exposed zustand state, so
// there is no accessor path for UI code to reach a raw handle even by
// accident. Panes only ever read `nodesById`/`rootIds` (`AssetTreeNode`,
// `tree.ts`) and call the action methods.
//
// `createAssetStore(deps)` takes its `HandleStore`/`DirectoryReader`
// factory/picker as arguments so the connect → list → expand → preview →
// disconnect flow is unit-testable against in-memory fakes, without a real
// File System Access API or IndexedDB (neither exists in this repo's Node
// test environment). `useAssetStore` below is the one real, browser-backed
// instance the app actually renders against.
// ═══════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';

import { createIndexedDbHandleStore } from './indexedDbHandleStore';
import { createNativeDirectoryReader } from './nativeDirectoryReader';
import { createPreviewUrlManager, type PreviewUrlManager } from './previewUrls';
import { flattenVisibleTree, makeNode, nodeId, type AssetTreeNode } from './tree';
import type { DirectoryReader, HandleStore } from './types';

export type AssetConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'needsPermission'
  | 'error';

export interface AssetStoreState {
  status: AssetConnectionStatus;
  rootName?: string;
  error?: string;
  nodesById: Record<string, AssetTreeNode>;
  rootIds: string[];

  /** Opens the native directory picker, persists the resulting handle, and
   *  lists the top level. A no-op transition back to `disconnected` if the
   *  user cancels the picker. */
  connect: () => Promise<void>;
  /** Called once at app boot: loads a previously-persisted handle (if any)
   *  and checks its permission without prompting. Lands on `connected`
   *  (permission already granted), `needsPermission` (persisted but not
   *  yet re-granted — call `grantPermission` from a real click to resolve),
   *  or `disconnected` (nothing persisted). */
  reconnectFromStorage: () => Promise<void>;
  /** Re-requests permission on the handle loaded by `reconnectFromStorage`.
   *  Must be called from a user gesture (a click handler) — the File System
   *  Access API requires one for `requestPermission`. */
  grantPermission: () => Promise<void>;
  /** Forgets the connected root: revokes every outstanding preview URL,
   *  clears the persisted handle, and resets the tree. */
  disconnect: () => Promise<void>;
  /** Expands/collapses a folder node, listing its children lazily on first
   *  expand only. */
  toggleExpand: (id: string) => Promise<void>;
  /** Opens (and object-URLs) a file node's preview. Idempotent while already
   *  loading/loaded. */
  loadPreview: (id: string) => Promise<void>;
  /** Releases a previously-loaded preview's object URL. Pairs 1:1 with a
   *  `loadPreview` call once the node scrolls out of the virtualized
   *  viewport — see `useVirtualRows.ts`'s visibility effect. */
  releasePreview: (id: string) => void;
}

export interface AssetStoreDeps {
  handleStore: HandleStore;
  urlManager: PreviewUrlManager;
  pickDirectory: () => Promise<FileSystemDirectoryHandle>;
  createReader: (root: FileSystemDirectoryHandle) => DirectoryReader;
}

export function createAssetStore(deps: AssetStoreDeps) {
  // Closure-private — never exposed on the zustand state, so no UI code can
  // reach a raw handle/reader through the store's public surface.
  let currentHandle: FileSystemDirectoryHandle | undefined;
  let currentReader: DirectoryReader | undefined;

  return create<AssetStoreState>((set, get) => {
    function patchNode(id: string, partial: Partial<AssetTreeNode>): void {
      const node = get().nodesById[id];
      if (!node) return;
      set({ nodesById: { ...get().nodesById, [id]: { ...node, ...partial } } });
    }

    async function activateRoot(handle: FileSystemDirectoryHandle): Promise<void> {
      currentHandle = handle;
      currentReader = deps.createReader(handle);
      set({ status: 'connecting', rootName: handle.name, error: undefined });
      try {
        const entries = await currentReader.listEntries([]);
        const nodesById: Record<string, AssetTreeNode> = {};
        const rootIds: string[] = [];
        for (const entry of entries) {
          const node = makeNode([entry.name], entry.name, entry.kind);
          nodesById[node.id] = node;
          rootIds.push(node.id);
        }
        set({ status: 'connected', nodesById, rootIds });
      } catch (err) {
        set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      status: 'disconnected',
      rootName: undefined,
      error: undefined,
      nodesById: {},
      rootIds: [],

      async connect() {
        set({ status: 'connecting', error: undefined });
        let handle: FileSystemDirectoryHandle;
        try {
          handle = await deps.pickDirectory();
        } catch (err) {
          // AbortError = the user dismissed the picker — not a failure.
          if (err instanceof DOMException && err.name === 'AbortError') {
            set({ status: 'disconnected' });
            return;
          }
          set({ status: 'error', error: err instanceof Error ? err.message : String(err) });
          return;
        }
        await deps.handleStore.save(handle);
        await activateRoot(handle);
      },

      async reconnectFromStorage() {
        set({ status: 'connecting', error: undefined });
        const handle = await deps.handleStore.load();
        if (!handle) {
          set({ status: 'disconnected' });
          return;
        }
        const permission = await handle.queryPermission({ mode: 'read' });
        if (permission === 'granted') {
          await activateRoot(handle);
        } else {
          currentHandle = handle;
          set({ status: 'needsPermission', rootName: handle.name });
        }
      },

      async grantPermission() {
        if (!currentHandle) return;
        const permission = await currentHandle.requestPermission({ mode: 'read' });
        if (permission === 'granted') {
          await activateRoot(currentHandle);
        } else {
          set({ status: 'error', error: 'Permission to read the folder was not granted.' });
        }
      },

      async disconnect() {
        deps.urlManager.releaseAll();
        currentHandle = undefined;
        currentReader = undefined;
        await deps.handleStore.clear();
        set({
          status: 'disconnected',
          rootName: undefined,
          error: undefined,
          nodesById: {},
          rootIds: [],
        });
      },

      async toggleExpand(id) {
        const node = get().nodesById[id];
        if (!node || node.kind !== 'folder' || !currentReader) return;

        if (node.expanded) {
          patchNode(id, { expanded: false });
          return;
        }
        if (node.childIds !== undefined) {
          patchNode(id, { expanded: true });
          return;
        }

        patchNode(id, { loadingChildren: true });
        try {
          const entries = await currentReader.listEntries(node.path);
          const childIds: string[] = [];
          const additions: Record<string, AssetTreeNode> = {};
          for (const entry of entries) {
            const childPath = [...node.path, entry.name];
            const child = makeNode(childPath, entry.name, entry.kind, id);
            additions[child.id] = child;
            childIds.push(child.id);
          }
          set({ nodesById: { ...get().nodesById, ...additions } });
          patchNode(id, { childIds, loadingChildren: false, expanded: true });
        } catch (err) {
          patchNode(id, { loadingChildren: false });
          set({ error: err instanceof Error ? err.message : String(err) });
        }
      },

      async loadPreview(id) {
        const node = get().nodesById[id];
        if (!node || node.kind !== 'file' || !currentReader) return;
        if (node.previewState === 'loading' || node.previewState === 'loaded') return;

        patchNode(id, { previewState: 'loading' });
        try {
          const source = await currentReader.openPreview(node.path);
          if (!get().nodesById[id]) return; // node vanished while awaiting
          if (!source) {
            patchNode(id, { previewState: 'unavailable' });
            return;
          }
          const url = deps.urlManager.acquire(id, source.blob);
          patchNode(id, { previewState: 'loaded', preview: url, previewKind: source.kind });
        } catch {
          patchNode(id, { previewState: 'unavailable' });
        }
      },

      releasePreview(id) {
        const node = get().nodesById[id];
        if (!node || node.previewState !== 'loaded') return;
        deps.urlManager.release(id);
        patchNode(id, { previewState: 'idle', preview: undefined, previewKind: undefined });
      },
    };
  });
}

/** The one real store instance the app renders against — real IndexedDB
 *  persistence, real File System Access reader, real object URLs. Deps are
 *  wrapped in functions here so nothing touches a browser-only global at
 *  module-evaluation time (only when an action actually runs). */
export const useAssetStore = createAssetStore({
  handleStore: createIndexedDbHandleStore(),
  urlManager: createPreviewUrlManager(),
  pickDirectory: () => window.showDirectoryPicker({ mode: 'read' }),
  createReader: createNativeDirectoryReader,
});

export { flattenVisibleTree, nodeId };
export type { AssetTreeNode } from './tree';
