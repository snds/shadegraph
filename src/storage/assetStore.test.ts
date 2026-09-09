import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAssetStore, flattenVisibleTree, type AssetStoreDeps } from './assetStore';
import type { PreviewUrlManager } from './previewUrls';
import type { AssetEntry, DirectoryReader, HandleStore } from './types';

// ── Fixtures ────────────────────────────────────────────────────────────────
// Fakes for every dependency `assetStore.ts` takes by injection — no real
// File System Access API, IndexedDB, or object-URL implementation involved,
// per the module's "unit-testable without a real FileSystemDirectoryHandle"
// requirement.

function fakeHandle(
  name: string,
  opts: { queryPermission?: PermissionState; requestPermission?: PermissionState } = {},
): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async queryPermission() {
      return opts.queryPermission ?? 'granted';
    },
    async requestPermission() {
      return opts.requestPermission ?? 'granted';
    },
  } as unknown as FileSystemDirectoryHandle;
}

function fakeHandleStore(initial?: FileSystemDirectoryHandle): HandleStore {
  let stored = initial;
  return {
    async save(handle) {
      stored = handle;
    },
    async load() {
      return stored;
    },
    async clear() {
      stored = undefined;
    },
  };
}

const fakeBlob = {} as Blob;

/** A fixture-backed `DirectoryReader`: `fixture` maps a joined path (`''` for
 *  the root) to that folder's entries. Records call counts so tests can
 *  assert lazy (not eager) listing. `textFixture` maps a joined path to that
 *  file's text, for `readText`/recognition tests. */
function fixtureReader(
  fixture: Record<string, AssetEntry[]>,
  textFixture: Record<string, string> = {},
): DirectoryReader & { listCalls: string[][]; readTextCalls: string[][] } {
  const listCalls: string[][] = [];
  const readTextCalls: string[][] = [];
  return {
    listCalls,
    readTextCalls,
    async listEntries(path) {
      listCalls.push(path);
      return fixture[path.join('/')] ?? [];
    },
    async openPreview(path) {
      const name = path[path.length - 1];
      if (name === 'a.png') return { kind: 'image', blob: fakeBlob };
      return undefined;
    },
    async readText(path) {
      readTextCalls.push(path);
      return textFixture[path.join('/')];
    },
  };
}

function fakeUrlManager(): PreviewUrlManager & { acquireCalls: string[]; releaseCalls: string[] } {
  const acquireCalls: string[] = [];
  const releaseCalls: string[] = [];
  const urls = new Map<string, number>();
  return {
    acquireCalls,
    releaseCalls,
    acquire(key) {
      acquireCalls.push(key);
      urls.set(key, (urls.get(key) ?? 0) + 1);
      return `blob:${key}`;
    },
    release(key) {
      releaseCalls.push(key);
      urls.delete(key);
    },
    releaseAll() {
      urls.clear();
    },
    get size() {
      return urls.size;
    },
  };
}

const FIXTURE: Record<string, AssetEntry[]> = {
  '': [
    { name: 'folder1', kind: 'folder' },
    { name: 'a.png', kind: 'file' },
  ],
  folder1: [{ name: 'b.txt', kind: 'file' }],
};

function makeDeps(overrides: Partial<AssetStoreDeps> = {}): AssetStoreDeps & {
  urlManager: ReturnType<typeof fakeUrlManager>;
} {
  const reader = fixtureReader(FIXTURE);
  const urlManager = fakeUrlManager();
  const deps: AssetStoreDeps = {
    handleStore: fakeHandleStore(),
    urlManager,
    pickDirectory: async () => fakeHandle('assets'),
    createReader: () => reader,
    ...overrides,
  };
  // The `urlManager` fixture is never overridden by any test in this file —
  // this cast just recovers the extra `acquireCalls`/`releaseCalls` fields
  // TypeScript widens away on spread.
  return deps as AssetStoreDeps & { urlManager: ReturnType<typeof fakeUrlManager> };
}

describe('createAssetStore — connect / disconnect', () => {
  it('connect() lists the top level and lands on connected', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    const state = store.getState();
    expect(state.status).toBe('connected');
    expect(state.rootName).toBe('assets');
    expect(state.rootIds).toHaveLength(2);
    expect(flattenVisibleTree(state.nodesById, state.rootIds).map((n) => n.name).sort()).toEqual([
      'a.png',
      'folder1',
    ]);
  });

  it('connect() treats a cancelled picker (AbortError) as a quiet no-op, not an error', async () => {
    const deps = makeDeps({
      pickDirectory: async () => {
        throw new DOMException('cancelled', 'AbortError');
      },
    });
    const store = createAssetStore(deps);
    await store.getState().connect();
    expect(store.getState().status).toBe('disconnected');
    expect(store.getState().error).toBeUndefined();
  });

  it('disconnect() releases every preview URL and clears persisted state', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    await store.getState().loadPreview('a.png');
    expect(deps.urlManager.size).toBe(1);

    await store.getState().disconnect();
    expect(deps.urlManager.size).toBe(0);
    expect(store.getState().status).toBe('disconnected');
    expect(store.getState().rootIds).toEqual([]);
    expect(await deps.handleStore.load()).toBeUndefined();
  });
});

describe('createAssetStore — lazy expansion', () => {
  it('does not list a subfolder until it is expanded', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    const reader = deps.createReader(fakeHandle('assets')) as ReturnType<typeof fixtureReader>;
    // connect() already listed the root once; folder1 must not appear yet.
    expect(reader.listCalls).toEqual([[]]);

    await store.getState().toggleExpand('folder1');
    expect(reader.listCalls).toEqual([[], ['folder1']]);
    const state = store.getState();
    expect(state.nodesById['folder1'].expanded).toBe(true);
    expect(state.nodesById['folder1/b.txt']).toBeDefined();
  });

  it('collapsing and re-expanding reuses the cached children instead of re-listing', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    await store.getState().toggleExpand('folder1');
    const reader = deps.createReader(fakeHandle('assets')) as ReturnType<typeof fixtureReader>;
    const callsAfterFirstExpand = reader.listCalls.length;

    await store.getState().toggleExpand('folder1'); // collapse
    expect(store.getState().nodesById['folder1'].expanded).toBe(false);
    expect(store.getState().nodesById['folder1'].childIds).toEqual(['folder1/b.txt']);

    await store.getState().toggleExpand('folder1'); // re-expand
    expect(store.getState().nodesById['folder1'].expanded).toBe(true);
    expect(reader.listCalls).toHaveLength(callsAfterFirstExpand);
  });
});

describe('createAssetStore — preview lifecycle', () => {
  it('loadPreview acquires a URL once and releasePreview releases it', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();

    await store.getState().loadPreview('a.png');
    expect(deps.urlManager.acquireCalls).toEqual(['a.png']);
    expect(store.getState().nodesById['a.png'].preview).toBe('blob:a.png');
    expect(store.getState().nodesById['a.png'].previewState).toBe('loaded');

    store.getState().releasePreview('a.png');
    expect(deps.urlManager.releaseCalls).toEqual(['a.png']);
    expect(store.getState().nodesById['a.png'].preview).toBeUndefined();
    expect(store.getState().nodesById['a.png'].previewState).toBe('idle');
  });

  it('loadPreview is idempotent while already loading/loaded', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    await Promise.all([store.getState().loadPreview('a.png'), store.getState().loadPreview('a.png')]);
    await store.getState().loadPreview('a.png');
    expect(deps.urlManager.acquireCalls).toEqual(['a.png']);
  });

  it('marks a non-previewable file unavailable without touching the URL manager', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    await store.getState().toggleExpand('folder1');
    await store.getState().loadPreview('folder1/b.txt');
    expect(store.getState().nodesById['folder1/b.txt'].previewState).toBe('unavailable');
    expect(deps.urlManager.acquireCalls).toEqual([]);
  });
});

describe('createAssetStore — reconnect at boot', () => {
  it('reconnectFromStorage lands on connected when permission is already granted', async () => {
    const deps = makeDeps({ handleStore: fakeHandleStore(fakeHandle('assets')) });
    const store = createAssetStore(deps);
    await store.getState().reconnectFromStorage();
    expect(store.getState().status).toBe('connected');
  });

  it('reconnectFromStorage lands on needsPermission without prompting, and grantPermission resolves it', async () => {
    const deps = makeDeps({
      handleStore: fakeHandleStore(fakeHandle('assets', { queryPermission: 'prompt', requestPermission: 'granted' })),
    });
    const store = createAssetStore(deps);
    await store.getState().reconnectFromStorage();
    expect(store.getState().status).toBe('needsPermission');
    expect(store.getState().rootName).toBe('assets');

    await store.getState().grantPermission();
    expect(store.getState().status).toBe('connected');
  });

  it('reconnectFromStorage with nothing persisted lands on disconnected', async () => {
    const deps = makeDeps({ handleStore: fakeHandleStore(undefined) });
    const store = createAssetStore(deps);
    await store.getState().reconnectFromStorage();
    expect(store.getState().status).toBe('disconnected');
  });
});

describe('createAssetStore — referential stability', () => {
  it('a mutation that changes nothing about a slice does not need to replace its reference', async () => {
    // Guards the "unstable Zustand selector" pitfall from the shared build
    // context: nodesById/rootIds must only be replaced when their contents
    // actually change, not on every unrelated action, or a selector reading
    // them would re-render (or getSnapshot-loop) on unrelated store writes.
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootIdsBefore = store.getState().rootIds;
    await store.getState().loadPreview('a.png'); // touches nodesById, not rootIds
    expect(store.getState().rootIds).toBe(rootIdsBefore);
  });
});

describe('createAssetStore — recognizeNode', () => {
  const RECOGNITION_FIXTURE: Record<string, AssetEntry[]> = {
    '': [
      { name: 'noise.glsl', kind: 'file' },
      { name: 'notes.txt', kind: 'file' },
    ],
  };
  const RECOGNITION_TEXT: Record<string, string> = {
    'noise.glsl': 'uniform float uTime;\nvoid main() {}',
    'notes.txt': 'just some prose',
  };

  it('marks a matching, recognizable file as recognized, lazily reading its text', async () => {
    const reader = fixtureReader(RECOGNITION_FIXTURE, RECOGNITION_TEXT);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();

    expect(reader.readTextCalls).toEqual([]); // connect()/listing never reads text

    await store.getState().recognizeNode('noise.glsl');
    expect(reader.readTextCalls).toEqual([['noise.glsl']]);
    expect(store.getState().nodesById['noise.glsl'].recognized).toBe(true);
  });

  it('keeps the recognized object(s) and the exact source text alongside "recognized: true"', async () => {
    const reader = fixtureReader(RECOGNITION_FIXTURE, RECOGNITION_TEXT);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();

    await store.getState().recognizeNode('noise.glsl');

    const node = store.getState().nodesById['noise.glsl'];
    expect(node.sourceText).toBe(RECOGNITION_TEXT['noise.glsl']);
    expect(node.recognizedObjects).toHaveLength(1);
    expect(node.recognizedObjects?.[0]).toMatchObject({ name: 'noise.glsl', uniforms: ['uTime'] });
  });

  it('leaves recognizedObjects/sourceText unset for a node that is not recognized', async () => {
    const reader = fixtureReader(RECOGNITION_FIXTURE, RECOGNITION_TEXT);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();

    await store.getState().recognizeNode('notes.txt');

    const node = store.getState().nodesById['notes.txt'];
    expect(node.recognizedObjects).toBeUndefined();
    expect(node.sourceText).toBeUndefined();
  });

  it('skips reading text for a file whose extension cannot match, marking it unrecognized', async () => {
    const reader = fixtureReader(RECOGNITION_FIXTURE, RECOGNITION_TEXT);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();

    await store.getState().recognizeNode('notes.txt');
    expect(reader.readTextCalls).toEqual([]);
    expect(store.getState().nodesById['notes.txt'].recognized).toBe(false);
  });

  it('is a no-op once a node has already been checked', async () => {
    const reader = fixtureReader(RECOGNITION_FIXTURE, RECOGNITION_TEXT);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();

    await store.getState().recognizeNode('noise.glsl');
    await store.getState().recognizeNode('noise.glsl');
    expect(reader.readTextCalls).toEqual([['noise.glsl']]);
  });

  it('defaults to recognizing nothing when no recognitionConfig is supplied', async () => {
    const reader = fixtureReader(RECOGNITION_FIXTURE, RECOGNITION_TEXT);
    const deps = makeDeps({ createReader: () => reader });
    const store = createAssetStore(deps);
    await store.getState().connect();

    await store.getState().recognizeNode('noise.glsl');
    expect(reader.readTextCalls).toEqual([]);
    expect(store.getState().nodesById['noise.glsl'].recognized).toBe(false);
  });
});

describe('createAssetStore — setRecognitionConfig', () => {
  const SWAP_FIXTURE: Record<string, AssetEntry[]> = {
    '': [{ name: 'noise.glsl', kind: 'file' }],
  };
  const SWAP_TEXT: Record<string, string> = {
    'noise.glsl': 'uniform float uTime;\nvoid main() {}',
  };

  it('seeds recognitionConfig state from deps.recognitionConfig', () => {
    const deps = makeDeps({ recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    expect(store.getState().recognitionConfig).toEqual({ fileExtensions: ['.glsl'] });
  });

  it('changes what the NEXT recognizeNode call matches on', async () => {
    const reader = fixtureReader(SWAP_FIXTURE, SWAP_TEXT);
    // Starts with a config that cannot possibly match `.glsl`.
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.wgsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();

    await store.getState().recognizeNode('noise.glsl');
    expect(store.getState().nodesById['noise.glsl'].recognized).toBe(false);

    // Swap to a config that matches `.glsl`. Reconnecting gives the store a
    // fresh, unrecognized node so the new config's next check is observable
    // (already-checked nodes are deliberately not retroactively rechecked).
    store.getState().setRecognitionConfig({ fileExtensions: ['.glsl'] });
    expect(store.getState().recognitionConfig).toEqual({ fileExtensions: ['.glsl'] });
    await store.getState().connect();

    await store.getState().recognizeNode('noise.glsl');
    expect(store.getState().nodesById['noise.glsl'].recognized).toBe(true);
  });

  it('does not retroactively re-check an already-recognized node after a config swap', async () => {
    const reader = fixtureReader(SWAP_FIXTURE, SWAP_TEXT);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();

    await store.getState().recognizeNode('noise.glsl');
    expect(store.getState().nodesById['noise.glsl'].recognized).toBe(true);

    store.getState().setRecognitionConfig({ fileExtensions: ['.wgsl'] });
    await store.getState().recognizeNode('noise.glsl'); // no-op: already checked
    expect(store.getState().nodesById['noise.glsl'].recognized).toBe(true);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
