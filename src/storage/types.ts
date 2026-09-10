// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: shared types
// ───────────────────────────────────────────────────────────────────────────
// The seam this whole module exists to enforce: everything outside
// `src/storage/` (the asset-browser pane, eventually reference critique)
// only ever sees plain data — `AssetTreeNode`, `PreviewKind`, string object
// URLs — never a `FileSystemHandle`, a stream, or a raw `Blob`/`File`.
//
// `DirectoryReader` and `HandleStore` are the injectable seams (same pattern
// as `SocketTypeLookup` in `src/model/connect.ts`): a real implementation
// walks a `FileSystemDirectoryHandle`/`indexedDB`, a test implementation
// walks an in-memory fixture. `src/storage/assetStore.ts` (the only place
// that holds real handles) depends on these interfaces, never the concrete
// browser APIs directly, so its tree-building/refcounting logic is
// unit-testable without a real File System Access API or IndexedDB — neither
// of which exists in the (Node, non-jsdom) test environment.
// ═══════════════════════════════════════════════════════════════════════════

export type AssetEntryKind = 'file' | 'folder';

/** One directory entry, as listed by a `DirectoryReader` — name and kind
 *  only, never a handle. */
export interface AssetEntry {
  name: string;
  kind: AssetEntryKind;
}

export type PreviewKind = 'image' | 'video';

/** A lazily-opened preview payload for one file. The `Blob` here is the
 *  native, disk-backed `File` object from `FileSystemFileHandle.getFile()`
 *  (or an equivalent fixture in tests) — reading it does not buffer the
 *  file's bytes; `URL.createObjectURL` streams from it on demand. Only
 *  `previewUrls.ts` ever turns this into a string URL; nothing else in the
 *  app holds onto a `Blob`. */
export interface PreviewSource {
  kind: PreviewKind;
  blob: Blob;
}

/** Lists one directory's immediate children (never recurses) and opens a
 *  preview payload for one file. The seam between `src/storage/`'s pure tree
 *  logic and the real File System Access API. `path` is a list of name
 *  segments from the connected root (`[]` = the root itself). */
export interface DirectoryReader {
  listEntries(path: string[]): Promise<AssetEntry[]>;
  /** `undefined` if `path` names a kind with no preview support (i.e. not
   *  image/video) or does not resolve to a file. */
  openPreview(path: string[]): Promise<PreviewSource | undefined>;
  /** Reads one file's full text content, on demand — used to feed the
   *  shader-object recognizer (`src/storage/recognition/recognize.ts`) a
   *  single file's source without ever bulk-reading a connected folder.
   *  `undefined` if `path` does not resolve to a file. */
  readText(path: string[]): Promise<string | undefined>;
}

/** One persisted connected root: the caller-assigned `id` (`assetStore.ts`'s
 *  `AssetRoot.id`) alongside the handle it names. */
export interface StoredAssetRoot {
  id: string;
  handle: FileSystemDirectoryHandle;
}

/** Persists every connected root's directory handle across sessions, keyed
 *  by the caller-assigned `id` — multiple simultaneously-connected folders,
 *  not just one. `save`/`loadAll`/`remove`/`clear` deal in the concrete
 *  `FileSystemDirectoryHandle` type (it's what has to be stored), but this
 *  interface itself is what `assetStore.ts` depends on, so a test can swap
 *  in an in-memory fake instead of real IndexedDB. */
export interface HandleStore {
  /** Adds or overwrites the persisted handle for `id`. */
  save(id: string, handle: FileSystemDirectoryHandle): Promise<void>;
  /** Every persisted root, order unspecified — `assetStore.ts`'s
   *  `reconnectFromStorage` re-adds each by its own `id`, not positionally. */
  loadAll(): Promise<StoredAssetRoot[]>;
  /** Forgets ONE persisted root. */
  remove(id: string): Promise<void>;
  /** Forgets every persisted root. */
  clear(): Promise<void>;
}

/** Creates/revokes/refcounts `URL.createObjectURL` results. Injected so
 *  `previewUrls.ts`'s refcounting logic is testable without a real `URL`
 *  Blob-URL implementation. */
export interface ObjectUrlFactory {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}
