// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: IndexedDB-backed `HandleStore`
// ───────────────────────────────────────────────────────────────────────────
// `FileSystemDirectoryHandle` is structured-cloneable but not JSON-
// serializable, so it can't live in `localStorage` next to the autosave
// (Phase 4 sketch's `ProjectSettings` note) — IndexedDB is the one browser
// store that can hold it directly. One object store, one row per connected
// root, keyed by that root's `assetStore.ts`-assigned `id` — multiple
// simultaneously-connected folders, not just one.
// ═══════════════════════════════════════════════════════════════════════════

import type { HandleStore, StoredAssetRoot } from './types';

const DB_NAME = 'shadegraph-storage';
const DB_VERSION = 1;
const STORE_NAME = 'handles';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = fn(tx.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  } finally {
    db.close();
  }
}

/** The real, browser-backed `HandleStore`. Only reachable through
 *  `window.indexedDB`, so it is never exercised by the (Node, non-jsdom)
 *  automated test suite — covered instead by the manual `pnpm dev`
 *  verification pass (reconnect without re-prompting the picker). */
export function createIndexedDbHandleStore(): HandleStore {
  return {
    async save(id, handle) {
      await withStore('readwrite', (store) => store.put(handle, id));
    },
    async loadAll() {
      const db = await openDb();
      try {
        return await new Promise<StoredAssetRoot[]>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const keysRequest = store.getAllKeys();
          const valuesRequest = store.getAll();
          let keys: IDBValidKey[] | undefined;
          let values: FileSystemDirectoryHandle[] | undefined;
          const settle = () => {
            if (keys === undefined || values === undefined) return;
            resolve(keys.map((key, i) => ({ id: String(key), handle: values![i] })));
          };
          keysRequest.onsuccess = () => {
            keys = keysRequest.result;
            settle();
          };
          valuesRequest.onsuccess = () => {
            values = valuesRequest.result;
            settle();
          };
          keysRequest.onerror = () => reject(keysRequest.error ?? new Error('Failed to read handle keys'));
          valuesRequest.onerror = () => reject(valuesRequest.error ?? new Error('Failed to read handle values'));
        });
      } finally {
        db.close();
      }
    },
    async remove(id) {
      await withStore('readwrite', (store) => store.delete(id));
    },
    async clear() {
      await withStore('readwrite', (store) => store.clear());
    },
  };
}
