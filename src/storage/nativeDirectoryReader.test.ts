import { describe, expect, it } from 'vitest';

import { createNativeDirectoryReader } from './nativeDirectoryReader';

// A minimal fixture satisfying only the members `nativeDirectoryReader.ts`
// actually calls (`kind`, `name`, `values()`, `getDirectoryHandle()`,
// `getFileHandle()`, `getFile()`) — not the full `FileSystemDirectoryHandle`
// surface, which isn't fakeable without a real browser. Cast at the call
// site, same tradeoff `store.test.ts` makes for its purpose-built node defs.
interface FakeFile {
  kind: 'file';
  name: string;
  text?: string;
}
interface FakeDir {
  kind: 'directory';
  name: string;
  children: Map<string, FakeDir | FakeFile>;
}

function dir(name: string, children: Array<FakeDir | FakeFile> = []): FakeDir {
  return { kind: 'directory', name, children: new Map(children.map((c) => [c.name, c])) };
}
function file(name: string, text?: string): FakeFile {
  return { kind: 'file', name, text };
}

function toHandle(entry: FakeDir | FakeFile): FileSystemDirectoryHandle | FileSystemFileHandle {
  if (entry.kind === 'file') {
    return {
      kind: 'file',
      name: entry.name,
      async getFile() {
        return {
          name: entry.name,
          async text() {
            return entry.text ?? '';
          },
        } as unknown as File;
      },
    } as unknown as FileSystemFileHandle;
  }
  const fakeDir = entry;
  return {
    kind: 'directory',
    name: fakeDir.name,
    async *values() {
      for (const child of fakeDir.children.values()) yield toHandle(child);
    },
    async getDirectoryHandle(childName: string) {
      const child = fakeDir.children.get(childName);
      if (!child || child.kind !== 'directory') throw new Error(`no such directory: ${childName}`);
      return toHandle(child) as FileSystemDirectoryHandle;
    },
    async getFileHandle(childName: string) {
      const child = fakeDir.children.get(childName);
      if (!child || child.kind !== 'file') throw new Error(`no such file: ${childName}`);
      return toHandle(child) as FileSystemFileHandle;
    },
  } as unknown as FileSystemDirectoryHandle;
}

const root = dir('root', [
  dir('planets', [file('mars.png'), file('notes.txt', 'uniform float uTime;')]),
  file('reel.mp4'),
  file('readme.md'),
]);

describe('createNativeDirectoryReader', () => {
  it('lists only the requested level, folders first then alphabetical', async () => {
    const reader = createNativeDirectoryReader(toHandle(root) as FileSystemDirectoryHandle);
    const top = await reader.listEntries([]);
    expect(top).toEqual([
      { name: 'planets', kind: 'folder' },
      { name: 'readme.md', kind: 'file' },
      { name: 'reel.mp4', kind: 'file' },
    ]);
  });

  it('lists a nested folder only when its own path is requested (never eagerly)', async () => {
    const reader = createNativeDirectoryReader(toHandle(root) as FileSystemDirectoryHandle);
    const nested = await reader.listEntries(['planets']);
    expect(nested).toEqual([
      { name: 'mars.png', kind: 'file' },
      { name: 'notes.txt', kind: 'file' },
    ]);
  });

  it('opens a preview payload for a previewable file', async () => {
    const reader = createNativeDirectoryReader(toHandle(root) as FileSystemDirectoryHandle);
    const preview = await reader.openPreview(['planets', 'mars.png']);
    expect(preview?.kind).toBe('image');
    expect(preview?.blob).toBeDefined();
  });

  it('returns undefined for a non-previewable file', async () => {
    const reader = createNativeDirectoryReader(toHandle(root) as FileSystemDirectoryHandle);
    const preview = await reader.openPreview(['planets', 'notes.txt']);
    expect(preview).toBeUndefined();
  });

  it('reads a file\'s full text on demand', async () => {
    const reader = createNativeDirectoryReader(toHandle(root) as FileSystemDirectoryHandle);
    const text = await reader.readText(['planets', 'notes.txt']);
    expect(text).toBe('uniform float uTime;');
  });

  it('returns undefined reading text for a path that does not resolve', async () => {
    const reader = createNativeDirectoryReader(toHandle(root) as FileSystemDirectoryHandle);
    const text = await reader.readText(['planets', 'missing.glsl']);
    expect(text).toBeUndefined();
  });
});
