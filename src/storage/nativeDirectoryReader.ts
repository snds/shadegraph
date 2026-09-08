// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: native File System Access `DirectoryReader`
// ───────────────────────────────────────────────────────────────────────────
// The one place in this module that actually walks a `FileSystemDirectoryHandle`.
// Every call is scoped to exactly the path asked for — `listEntries` never
// recurses into subfolders, `openPreview` never reads a file beyond handing
// back its lazy, disk-backed `File` (the caller decides whether/when to turn
// that into an object URL). Callers only ever depend on the `DirectoryReader`
// interface (`types.ts`), never this file.
// ═══════════════════════════════════════════════════════════════════════════

import { previewKindForName } from './previewKind';
import type { AssetEntry, DirectoryReader, PreviewSource } from './types';

async function resolveDirectory(
  root: FileSystemDirectoryHandle,
  path: string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of path) {
    dir = await dir.getDirectoryHandle(segment);
  }
  return dir;
}

export function createNativeDirectoryReader(root: FileSystemDirectoryHandle): DirectoryReader {
  return {
    async listEntries(path) {
      const dir = await resolveDirectory(root, path);
      const entries: AssetEntry[] = [];
      for await (const handle of dir.values()) {
        entries.push({ name: handle.name, kind: handle.kind === 'directory' ? 'folder' : 'file' });
      }
      // Folders first, then alphabetical within each group — stable and
      // predictable regardless of the OS's native directory-listing order.
      entries.sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return entries;
    },

    async openPreview(path): Promise<PreviewSource | undefined> {
      if (path.length === 0) return undefined;
      const name = path[path.length - 1];
      const kind = previewKindForName(name);
      if (!kind) return undefined;
      const dir = await resolveDirectory(root, path.slice(0, -1));
      const fileHandle = await dir.getFileHandle(name);
      const file = await fileHandle.getFile();
      return { kind, blob: file };
    },
  };
}
