// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: connections + lazy tree store
// ───────────────────────────────────────────────────────────────────────────
// Owns every connected asset root end to end: picking/persisting each
// directory handle, its recursive-but-listing-only structural scan (see
// `recognitionVisibility.ts`), and preview object-URL lifecycle. This is the
// ONLY place a `FileSystemDirectoryHandle` or a `DirectoryReader` lives —
// `rootRuntime` is closure-private to `createAssetStore`, not part of the
// exposed zustand state, so there is no accessor path for UI code to reach a
// raw handle even by accident. Panes only ever read `roots`
// (`AssetRoot`/`AssetTreeNode`, `tree.ts`) and call the action methods, every
// one of which now takes a `rootId` naming WHICH connected folder it targets.
//
// Multiple folders can be connected at once — the Assets panel's "Pages"-like
// strip (`AssetBrowserPanel.tsx`) lists every entry in `roots` and lets the
// user switch between/add/remove them independently. `connect()` ADDS a root
// rather than replacing "the one connection" a single-root design would have.
//
// `createAssetStore(deps)` takes its `HandleStore`/`DirectoryReader`
// factory/picker as arguments so the connect → scan → expand → preview →
// disconnect flow is unit-testable against in-memory fakes, without a real
// File System Access API or IndexedDB (neither exists in this repo's Node
// test environment). `useAssetStore` below is the one real, browser-backed
// instance the app actually renders against.
// ═══════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';

import { createIndexedDbHandleStore } from './indexedDbHandleStore';
import { createNativeDirectoryReader } from './nativeDirectoryReader';
import { createPreviewUrlManager, type PreviewUrlManager } from './previewUrls';
import { recognizeShaderObjects, type RecognitionConfig } from './recognition';
import { defaultRecognitionConfigId, getRecognitionConfigOption } from './recognitionConfigs';
import { isRecognitionCandidate, scanRecognitionFilteredTree } from './recognitionVisibility';
import { flattenVisibleTree, makeNode, nodeId, type AssetTreeNode } from './tree';
import type { DirectoryReader, HandleStore } from './types';

export type AssetConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'needsPermission'
  | 'error';

/** One connected (or connecting/erroring) folder. `id` is assigned once, at
 *  `connect()`/`reconnectFromStorage()` time, and is also the key
 *  `deps.handleStore` persists that folder's handle under — stable across a
 *  reload so `reconnectFromStorage` can re-attach state to the same strip
 *  entry rather than a fresh one. */
export interface AssetRoot {
  id: string;
  status: AssetConnectionStatus;
  rootName?: string;
  error?: string;
  nodesById: Record<string, AssetTreeNode>;
  rootIds: string[];
  /** `undefined` only while `status` is `'connecting'`/`'needsPermission'`/
   *  `'error'` — populated together with `nodesById`/`rootIds` the moment the
   *  recursive structural scan finishes and `status` becomes `'connected'`.
   *  See `recognitionVisibility.ts`'s `scanRecognitionFilteredTree`. */
  visibleIds?: Set<string>;
}

const EMPTY_NODES: Record<string, AssetTreeNode> = {};
const EMPTY_ROOT_IDS: string[] = [];

function previewKey(rootId: string, id: string): string {
  return `${rootId}::${id}`;
}

export interface AssetStoreState {
  roots: AssetRoot[];
  /** The config `recognizeNode`/the structural scan currently classify files
   *  against. Seeded from `deps.recognitionConfig` at store creation; swap it
   *  at runtime via `setRecognitionConfig`. Already-connected roots are NOT
   *  retroactively re-scanned on a swap (same precedent as already-recognized
   *  nodes never being retroactively re-checked) — only a fresh
   *  `connect()`/`reconnectFromStorage()` sees the new config. */
  recognitionConfig: RecognitionConfig;

  /** Opens the native directory picker and ADDS a new connected root —
   *  existing roots are untouched. A no-op (nothing added) if the user
   *  cancels the picker. */
  connect: () => Promise<void>;
  /** Called once at app boot: loads every previously-persisted handle (if
   *  any) and checks each one's permission without prompting. Safe to call
   *  again later (e.g. the Assets pivot re-mounting) — a root whose `id` is
   *  already in `roots` is left alone, never re-added. */
  reconnectFromStorage: () => Promise<void>;
  /** Re-requests permission on the root loaded by `reconnectFromStorage`.
   *  Must be called from a user gesture (a click handler) — the File System
   *  Access API requires one for `requestPermission`. */
  grantPermission: (rootId: string) => Promise<void>;
  /** Forgets ONE connected root: revokes every outstanding preview URL it
   *  owns, clears its persisted handle, and removes it from `roots`. Other
   *  connected roots are untouched. */
  disconnect: (rootId: string) => Promise<void>;
  /** Expands/collapses a folder node. Every folder's children were already
   *  listed by the recursive structural scan at connect time, so this is
   *  normally pure state (no I/O) — it only falls back to listing if a given
   *  folder's `childIds` are somehow still unset (e.g. that subtree's scan
   *  failed and was caught as empty; see `recognitionVisibility.ts`). */
  toggleExpand: (rootId: string, id: string) => Promise<void>;
  /** Opens (and object-URLs) a file node's preview. Idempotent while already
   *  loading/loaded. */
  loadPreview: (rootId: string, id: string) => Promise<void>;
  /** Releases a previously-loaded preview's object URL. Pairs 1:1 with a
   *  `loadPreview` call once the node scrolls out of the virtualized
   *  viewport — see `useVirtualRows.ts`'s visibility effect. */
  releasePreview: (rootId: string, id: string) => void;
  /** Runs shader-object recognition (`recognizeShaderObjects`) against one
   *  file node, on demand — lazily reading its text via the connected
   *  `DirectoryReader` only if its extension could possibly match
   *  `deps.recognitionConfig`, then patching that node's `recognized`. A
   *  no-op once the node has already been checked (`recognized !==
   *  undefined`), so it is safe to call repeatedly (e.g. from the same
   *  visibility effect that drives `loadPreview`). */
  recognizeNode: (rootId: string, id: string) => Promise<void>;
  /** Swaps the config `recognizeNode` and future scans match against. Purely
   *  additive to already-checked nodes/already-connected roots — see
   *  `recognitionConfig`'s doc comment. */
  setRecognitionConfig: (config: RecognitionConfig) => void;
}

export interface AssetStoreDeps {
  handleStore: HandleStore;
  urlManager: PreviewUrlManager;
  pickDirectory: () => Promise<FileSystemDirectoryHandle>;
  createReader: (root: FileSystemDirectoryHandle) => DirectoryReader;
  /** INITIAL config the structural scan/`recognizeNode` classify files
   *  against — seeds the store's `recognitionConfig` state once, at creation.
   *  Optional — defaults to `{}` (nothing recognized) so existing/test deps
   *  that omit it keep behaving exactly as before. Swap the active config
   *  later via the store's `setRecognitionConfig` action, not by mutating
   *  this object. */
  recognitionConfig?: RecognitionConfig;
}

/** Generates a fresh, stable id for a newly connected root — also the key it
 *  is persisted under in `deps.handleStore`. Not cryptographically unique,
 *  just collision-resistant enough for one browser's connected-roots list
 *  (same treatment as `src/model/ids.ts`'s node/layer id suffixes). */
function makeRootId(): string {
  return `assetroot_${Math.random().toString(36).slice(2, 10)}`;
}

export function createAssetStore(deps: AssetStoreDeps) {
  // Closure-private — never exposed on the zustand state, so no UI code can
  // reach a raw handle/reader through the store's public surface. Keyed by
  // `AssetRoot.id`, one entry per root that has (at some point) had its
  // handle resolved — including one awaiting `grantPermission`, whose
  // `reader` is only created once permission is actually granted.
  const rootRuntime = new Map<string, { handle: FileSystemDirectoryHandle; reader?: DirectoryReader }>();

  return create<AssetStoreState>((set, get) => {
    function updateRoot(rootId: string, partial: Partial<AssetRoot>): void {
      const roots = get().roots;
      const index = roots.findIndex((r) => r.id === rootId);
      if (index === -1) return;
      const nextRoots = [...roots];
      nextRoots[index] = { ...nextRoots[index], ...partial };
      set({ roots: nextRoots });
    }

    function patchNode(rootId: string, id: string, partial: Partial<AssetTreeNode>): void {
      const roots = get().roots;
      const index = roots.findIndex((r) => r.id === rootId);
      if (index === -1) return;
      const root = roots[index];
      const node = root.nodesById[id];
      if (!node) return;
      const nextRoots = [...roots];
      nextRoots[index] = { ...root, nodesById: { ...root.nodesById, [id]: { ...node, ...partial } } };
      set({ roots: nextRoots });
    }

    async function activateRoot(rootId: string, handle: FileSystemDirectoryHandle): Promise<void> {
      const reader = deps.createReader(handle);
      rootRuntime.set(rootId, { handle, reader });
      updateRoot(rootId, { status: 'connecting', rootName: handle.name, error: undefined });
      try {
        const config = get().recognitionConfig;
        const { nodesById, rootIds, visibleIds } = await scanRecognitionFilteredTree(reader, config);
        // The root may have been disconnected, or reconnected against a
        // different handle/reader, while this scan was in flight — only
        // apply a stale scan's result if this is still the live reader.
        if (rootRuntime.get(rootId)?.reader !== reader) return;
        updateRoot(rootId, { status: 'connected', nodesById, rootIds, visibleIds });
      } catch (err) {
        updateRoot(rootId, { status: 'error', error: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      roots: [],
      recognitionConfig: deps.recognitionConfig ?? {},

      async connect() {
        let handle: FileSystemDirectoryHandle;
        try {
          handle = await deps.pickDirectory();
        } catch (err) {
          // AbortError = the user dismissed the picker — not a failure, and
          // nothing is added (unlike a real listing failure, there is no
          // handle to show an error entry for).
          if (err instanceof DOMException && err.name === 'AbortError') return;
          const rootId = makeRootId();
          set({
            roots: [
              ...get().roots,
              {
                id: rootId,
                status: 'error',
                error: err instanceof Error ? err.message : String(err),
                nodesById: EMPTY_NODES,
                rootIds: EMPTY_ROOT_IDS,
              },
            ],
          });
          return;
        }
        const rootId = makeRootId();
        set({
          roots: [
            ...get().roots,
            { id: rootId, status: 'connecting', rootName: handle.name, nodesById: EMPTY_NODES, rootIds: EMPTY_ROOT_IDS },
          ],
        });
        await deps.handleStore.save(rootId, handle);
        await activateRoot(rootId, handle);
      },

      async reconnectFromStorage() {
        const stored = await deps.handleStore.loadAll();
        const existingIds = new Set(get().roots.map((r) => r.id));
        for (const { id, handle } of stored) {
          // Idempotent: a root already present (this ran before, e.g. the
          // Assets pivot re-mounting) is left exactly as-is, never re-added.
          if (existingIds.has(id)) continue;
          set({
            roots: [
              ...get().roots,
              { id, status: 'connecting', rootName: handle.name, nodesById: EMPTY_NODES, rootIds: EMPTY_ROOT_IDS },
            ],
          });
          const permission = await handle.queryPermission({ mode: 'read' });
          if (permission === 'granted') {
            await activateRoot(id, handle);
          } else {
            rootRuntime.set(id, { handle });
            updateRoot(id, { status: 'needsPermission', rootName: handle.name });
          }
        }
      },

      async grantPermission(rootId) {
        const runtime = rootRuntime.get(rootId);
        if (!runtime) return;
        const permission = await runtime.handle.requestPermission({ mode: 'read' });
        if (permission === 'granted') {
          await activateRoot(rootId, runtime.handle);
        } else {
          updateRoot(rootId, { status: 'error', error: 'Permission to read the folder was not granted.' });
        }
      },

      async disconnect(rootId) {
        const root = get().roots.find((r) => r.id === rootId);
        if (root) {
          for (const node of Object.values(root.nodesById)) {
            if (node.previewState === 'loaded') deps.urlManager.release(previewKey(rootId, node.id));
          }
        }
        rootRuntime.delete(rootId);
        await deps.handleStore.remove(rootId);
        set({ roots: get().roots.filter((r) => r.id !== rootId) });
      },

      async toggleExpand(rootId, id) {
        const root = get().roots.find((r) => r.id === rootId);
        const node = root?.nodesById[id];
        const reader = rootRuntime.get(rootId)?.reader;
        if (!root || !node || node.kind !== 'folder' || !reader) return;

        if (node.expanded) {
          patchNode(rootId, id, { expanded: false });
          return;
        }
        if (node.childIds !== undefined) {
          patchNode(rootId, id, { expanded: true });
          return;
        }

        // Defensive fallback only — the recursive structural scan normally
        // already populated every folder's `childIds` at connect time.
        patchNode(rootId, id, { loadingChildren: true });
        try {
          const entries = await reader.listEntries(node.path);
          const childIds: string[] = [];
          const nextRoot = get().roots.find((r) => r.id === rootId);
          if (!nextRoot) return; // root vanished while awaiting
          const additions: Record<string, AssetTreeNode> = {};
          for (const entry of entries) {
            const childPath = [...node.path, entry.name];
            const child = makeNode(childPath, entry.name, entry.kind, id);
            additions[child.id] = child;
            childIds.push(child.id);
          }
          const roots = get().roots;
          const index = roots.findIndex((r) => r.id === rootId);
          if (index === -1) return;
          const merged = { ...roots[index].nodesById, ...additions };
          const nextRoots = [...roots];
          nextRoots[index] = { ...roots[index], nodesById: merged };
          set({ roots: nextRoots });
          patchNode(rootId, id, { childIds, loadingChildren: false, expanded: true });
        } catch (err) {
          patchNode(rootId, id, { loadingChildren: false });
          updateRoot(rootId, { error: err instanceof Error ? err.message : String(err) });
        }
      },

      async loadPreview(rootId, id) {
        const root = get().roots.find((r) => r.id === rootId);
        const node = root?.nodesById[id];
        const reader = rootRuntime.get(rootId)?.reader;
        if (!root || !node || node.kind !== 'file' || !reader) return;
        if (node.previewState === 'loading' || node.previewState === 'loaded') return;

        patchNode(rootId, id, { previewState: 'loading' });
        try {
          const source = await reader.openPreview(node.path);
          if (!get().roots.find((r) => r.id === rootId)?.nodesById[id]) return; // node vanished while awaiting
          if (!source) {
            patchNode(rootId, id, { previewState: 'unavailable' });
            return;
          }
          const url = deps.urlManager.acquire(previewKey(rootId, id), source.blob);
          patchNode(rootId, id, { previewState: 'loaded', preview: url, previewKind: source.kind });
        } catch {
          patchNode(rootId, id, { previewState: 'unavailable' });
        }
      },

      releasePreview(rootId, id) {
        const root = get().roots.find((r) => r.id === rootId);
        const node = root?.nodesById[id];
        if (!node || node.previewState !== 'loaded') return;
        deps.urlManager.release(previewKey(rootId, id));
        patchNode(rootId, id, { previewState: 'idle', preview: undefined, previewKind: undefined });
      },

      async recognizeNode(rootId, id) {
        const root = get().roots.find((r) => r.id === rootId);
        const node = root?.nodesById[id];
        const reader = rootRuntime.get(rootId)?.reader;
        if (!root || !node || node.kind !== 'file' || !reader) return;
        if (node.recognized !== undefined) return; // already checked

        const config = get().recognitionConfig;
        if (!isRecognitionCandidate(node.name, config)) {
          patchNode(rootId, id, { recognized: false });
          return;
        }

        try {
          const text = await reader.readText(node.path);
          if (!get().roots.find((r) => r.id === rootId)?.nodesById[id]) return; // node vanished while awaiting
          if (text === undefined) {
            patchNode(rootId, id, { recognized: false });
            return;
          }
          const objects = recognizeShaderObjects([node], { [id]: text }, config);
          if (objects.length > 0) {
            // Keep the objects + the exact text they came from, so a
            // "graph this" action can call `graphFromRecognizedObject`
            // directly off this node without re-reading/re-recognizing.
            patchNode(rootId, id, { recognized: true, recognizedObjects: objects, sourceText: text });
          } else {
            patchNode(rootId, id, { recognized: false });
          }
        } catch {
          patchNode(rootId, id, { recognized: false });
        }
      },

      setRecognitionConfig(config) {
        set({ recognitionConfig: config });
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
  recognitionConfig: getRecognitionConfigOption(defaultRecognitionConfigId).config,
});

export { flattenVisibleTree, nodeId };
export type { AssetTreeNode } from './tree';
