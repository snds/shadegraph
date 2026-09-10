import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createAssetStore, flattenVisibleTree, type AssetStoreDeps } from './assetStore';
import type { PreviewUrlManager } from './previewUrls';
import type { AssetEntry, DirectoryReader, HandleStore, StoredAssetRoot } from './types';

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

function fakeHandleStore(initial: StoredAssetRoot[] = []): HandleStore {
  const stored = new Map(initial.map((entry) => [entry.id, entry.handle]));
  return {
    async save(id, handle) {
      stored.set(id, handle);
    },
    async loadAll() {
      return Array.from(stored.entries()).map(([id, handle]) => ({ id, handle }));
    },
    async remove(id) {
      stored.delete(id);
    },
    async clear() {
      stored.clear();
    },
  };
}

const fakeBlob = {} as Blob;

/** A fixture-backed `DirectoryReader`: `fixture` maps a joined path (`''` for
 *  the root) to that folder's entries. Records call counts so tests can
 *  assert which paths got listed. `textFixture` maps a joined path to that
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
    const root = store.getState().roots[0];
    expect(root.status).toBe('connected');
    expect(root.rootName).toBe('assets');
    expect(root.rootIds).toHaveLength(2);
    expect(flattenVisibleTree(root.nodesById, root.rootIds).map((n) => n.name).sort()).toEqual([
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
    expect(store.getState().roots).toEqual([]);
  });

  it('connect() records a real picker failure as a new error root, without touching existing roots', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    expect(store.getState().roots).toHaveLength(1);
    const okRootId = store.getState().roots[0].id;

    deps.pickDirectory = async () => {
      throw new Error('disk unplugged');
    };
    await store.getState().connect();

    const roots = store.getState().roots;
    expect(roots).toHaveLength(2);
    expect(roots[0].id).toBe(okRootId);
    expect(roots[0].status).toBe('connected');
    expect(roots[1].status).toBe('error');
    expect(roots[1].error).toBe('disk unplugged');
  });

  it('connecting a second folder adds a second, independently browsable root', async () => {
    const secondFixture: Record<string, AssetEntry[]> = { '': [{ name: 'c.mp4', kind: 'file' }] };
    const secondReader = fixtureReader(secondFixture);
    let pickCount = 0;
    const deps = makeDeps({
      pickDirectory: async () => fakeHandle(pickCount++ === 0 ? 'first' : 'second'),
      createReader: (handle) => (handle.name === 'second' ? secondReader : fixtureReader(FIXTURE)),
    });
    const store = createAssetStore(deps);

    await store.getState().connect();
    await store.getState().connect();

    const roots = store.getState().roots;
    expect(roots).toHaveLength(2);
    expect(roots.map((r) => r.rootName)).toEqual(['first', 'second']);
    expect(roots[0].status).toBe('connected');
    expect(roots[1].status).toBe('connected');
    expect(flattenVisibleTree(roots[1].nodesById, roots[1].rootIds).map((n) => n.name)).toEqual(['c.mp4']);
  });

  it('disconnect(rootId) releases that root\'s preview URLs and removes only that root', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    await store.getState().connect(); // two identical-fixture roots
    const [first, second] = store.getState().roots;

    await store.getState().loadPreview(first.id, 'a.png');
    expect(deps.urlManager.size).toBe(1);

    await store.getState().disconnect(first.id);
    expect(deps.urlManager.size).toBe(0);
    const remaining = store.getState().roots;
    expect(remaining.map((r) => r.id)).toEqual([second.id]);
    expect(await deps.handleStore.loadAll()).toEqual([{ id: second.id, handle: expect.anything() }]);
  });
});

describe('createAssetStore — recursive structural scan at connect', () => {
  it('lists the whole tree recursively at connect time, not just the top level', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    const reader = deps.createReader(fakeHandle('assets')) as ReturnType<typeof fixtureReader>;
    expect(reader.listCalls.map((p) => p.join('/')).sort()).toEqual(['', 'folder1']);

    const root = store.getState().roots[0];
    expect(root.nodesById['folder1'].childIds).toEqual(['folder1/b.txt']);
    expect(root.nodesById['folder1/b.txt']).toBeDefined();
  });

  it('toggleExpand never re-lists once the scan already cached a folder\'s children', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootId = store.getState().roots[0].id;
    const reader = deps.createReader(fakeHandle('assets')) as ReturnType<typeof fixtureReader>;
    const callsAfterConnect = reader.listCalls.length;

    await store.getState().toggleExpand(rootId, 'folder1');
    expect(reader.listCalls).toHaveLength(callsAfterConnect);
    expect(store.getState().roots[0].nodesById['folder1'].expanded).toBe(true);

    await store.getState().toggleExpand(rootId, 'folder1'); // collapse
    expect(store.getState().roots[0].nodesById['folder1'].expanded).toBe(false);
    await store.getState().toggleExpand(rootId, 'folder1'); // re-expand
    expect(store.getState().roots[0].nodesById['folder1'].expanded).toBe(true);
    expect(reader.listCalls).toHaveLength(callsAfterConnect);
  });

  it('a subfolder the scan could not list is treated as empty rather than failing the whole connect', async () => {
    const brokenFixture: Record<string, AssetEntry[]> = {
      '': [{ name: 'broken', kind: 'folder' }, { name: 'a.png', kind: 'file' }],
    };
    const reader: DirectoryReader = {
      async listEntries(path) {
        if (path.join('/') === 'broken') throw new Error('permission denied');
        return brokenFixture[path.join('/')] ?? [];
      },
      async openPreview() {
        return undefined;
      },
      async readText() {
        return undefined;
      },
    };
    const deps = makeDeps({ createReader: () => reader });
    const store = createAssetStore(deps);
    await store.getState().connect();

    const root = store.getState().roots[0];
    expect(root.status).toBe('connected');
    expect(root.nodesById['broken'].childIds).toEqual([]);
  });
});

describe('createAssetStore — preview lifecycle', () => {
  it('loadPreview acquires a URL once and releasePreview releases it', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootId = store.getState().roots[0].id;

    await store.getState().loadPreview(rootId, 'a.png');
    expect(deps.urlManager.acquireCalls).toEqual([`${rootId}::a.png`]);
    expect(store.getState().roots[0].nodesById['a.png'].preview).toBe(`blob:${rootId}::a.png`);
    expect(store.getState().roots[0].nodesById['a.png'].previewState).toBe('loaded');

    store.getState().releasePreview(rootId, 'a.png');
    expect(deps.urlManager.releaseCalls).toEqual([`${rootId}::a.png`]);
    expect(store.getState().roots[0].nodesById['a.png'].preview).toBeUndefined();
    expect(store.getState().roots[0].nodesById['a.png'].previewState).toBe('idle');
  });

  it('loadPreview is idempotent while already loading/loaded', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootId = store.getState().roots[0].id;
    await Promise.all([store.getState().loadPreview(rootId, 'a.png'), store.getState().loadPreview(rootId, 'a.png')]);
    await store.getState().loadPreview(rootId, 'a.png');
    expect(deps.urlManager.acquireCalls).toEqual([`${rootId}::a.png`]);
  });

  it('marks a non-previewable file unavailable without touching the URL manager', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootId = store.getState().roots[0].id;
    await store.getState().loadPreview(rootId, 'folder1/b.txt');
    expect(store.getState().roots[0].nodesById['folder1/b.txt'].previewState).toBe('unavailable');
    expect(deps.urlManager.acquireCalls).toEqual([]);
  });
});

describe('createAssetStore — reconnect at boot', () => {
  it('reconnectFromStorage lands on connected when permission is already granted', async () => {
    const deps = makeDeps({ handleStore: fakeHandleStore([{ id: 'root-1', handle: fakeHandle('assets') }]) });
    const store = createAssetStore(deps);
    await store.getState().reconnectFromStorage();
    expect(store.getState().roots).toHaveLength(1);
    expect(store.getState().roots[0].status).toBe('connected');
  });

  it('reconnectFromStorage lands on needsPermission without prompting, and grantPermission resolves it', async () => {
    const deps = makeDeps({
      handleStore: fakeHandleStore([
        { id: 'root-1', handle: fakeHandle('assets', { queryPermission: 'prompt', requestPermission: 'granted' }) },
      ]),
    });
    const store = createAssetStore(deps);
    await store.getState().reconnectFromStorage();
    expect(store.getState().roots[0].status).toBe('needsPermission');
    expect(store.getState().roots[0].rootName).toBe('assets');

    await store.getState().grantPermission('root-1');
    expect(store.getState().roots[0].status).toBe('connected');
  });

  it('reconnectFromStorage with nothing persisted lands on an empty roots list', async () => {
    const deps = makeDeps({ handleStore: fakeHandleStore([]) });
    const store = createAssetStore(deps);
    await store.getState().reconnectFromStorage();
    expect(store.getState().roots).toEqual([]);
  });

  it('reconnectFromStorage is idempotent — a root already present is never re-added', async () => {
    const deps = makeDeps({ handleStore: fakeHandleStore([{ id: 'root-1', handle: fakeHandle('assets') }]) });
    const store = createAssetStore(deps);
    await store.getState().reconnectFromStorage();
    await store.getState().reconnectFromStorage();
    expect(store.getState().roots).toHaveLength(1);
  });

  it('reconnectFromStorage restores every persisted root, not just one', async () => {
    const deps = makeDeps({
      handleStore: fakeHandleStore([
        { id: 'root-1', handle: fakeHandle('first') },
        { id: 'root-2', handle: fakeHandle('second') },
      ]),
    });
    const store = createAssetStore(deps);
    await store.getState().reconnectFromStorage();
    const roots = store.getState().roots;
    expect(roots.map((r) => r.rootName).sort()).toEqual(['first', 'second']);
    expect(roots.every((r) => r.status === 'connected')).toBe(true);
  });
});

describe('createAssetStore — referential stability', () => {
  it('a mutation that changes nothing about a slice does not need to replace its reference', async () => {
    // Guards the "unstable Zustand selector" pitfall from the shared build
    // context: a root's rootIds must only be replaced when its contents
    // actually change, not on every unrelated action, or a selector reading
    // it would re-render (or getSnapshot-loop) on unrelated store writes.
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootId = store.getState().roots[0].id;
    const rootIdsBefore = store.getState().roots[0].rootIds;
    await store.getState().loadPreview(rootId, 'a.png'); // touches nodesById, not rootIds
    expect(store.getState().roots[0].rootIds).toBe(rootIdsBefore);
  });

  it('patching one root never replaces another root\'s object reference', async () => {
    const deps = makeDeps();
    const store = createAssetStore(deps);
    await store.getState().connect();
    await store.getState().connect();
    const [first, second] = store.getState().roots;

    await store.getState().loadPreview(first.id, 'a.png');
    expect(store.getState().roots.find((r) => r.id === second.id)).toBe(second);
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
    const rootId = store.getState().roots[0].id;

    expect(reader.readTextCalls).toEqual([]); // connect()/the structural scan never reads text

    await store.getState().recognizeNode(rootId, 'noise.glsl');
    expect(reader.readTextCalls).toEqual([['noise.glsl']]);
    expect(store.getState().roots[0].nodesById['noise.glsl'].recognized).toBe(true);
  });

  it('keeps the recognized object(s) and the exact source text alongside "recognized: true"', async () => {
    const reader = fixtureReader(RECOGNITION_FIXTURE, RECOGNITION_TEXT);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootId = store.getState().roots[0].id;

    await store.getState().recognizeNode(rootId, 'noise.glsl');

    const node = store.getState().roots[0].nodesById['noise.glsl'];
    expect(node.sourceText).toBe(RECOGNITION_TEXT['noise.glsl']);
    expect(node.recognizedObjects).toHaveLength(1);
    expect(node.recognizedObjects?.[0]).toMatchObject({ name: 'noise.glsl', uniforms: ['uTime'] });
  });

  it('leaves recognizedObjects/sourceText unset for a node that is not recognized', async () => {
    const reader = fixtureReader(RECOGNITION_FIXTURE, RECOGNITION_TEXT);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootId = store.getState().roots[0].id;

    await store.getState().recognizeNode(rootId, 'notes.txt');

    const node = store.getState().roots[0].nodesById['notes.txt'];
    expect(node.recognizedObjects).toBeUndefined();
    expect(node.sourceText).toBeUndefined();
  });

  it('skips reading text for a file whose extension cannot match, marking it unrecognized', async () => {
    const reader = fixtureReader(RECOGNITION_FIXTURE, RECOGNITION_TEXT);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootId = store.getState().roots[0].id;

    await store.getState().recognizeNode(rootId, 'notes.txt');
    expect(reader.readTextCalls).toEqual([]);
    expect(store.getState().roots[0].nodesById['notes.txt'].recognized).toBe(false);
  });

  it('is a no-op once a node has already been checked', async () => {
    const reader = fixtureReader(RECOGNITION_FIXTURE, RECOGNITION_TEXT);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootId = store.getState().roots[0].id;

    await store.getState().recognizeNode(rootId, 'noise.glsl');
    await store.getState().recognizeNode(rootId, 'noise.glsl');
    expect(reader.readTextCalls).toEqual([['noise.glsl']]);
  });

  it('defaults to recognizing nothing when no recognitionConfig is supplied', async () => {
    const reader = fixtureReader(RECOGNITION_FIXTURE, RECOGNITION_TEXT);
    const deps = makeDeps({ createReader: () => reader });
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootId = store.getState().roots[0].id;

    await store.getState().recognizeNode(rootId, 'noise.glsl');
    expect(reader.readTextCalls).toEqual([]);
    expect(store.getState().roots[0].nodesById['noise.glsl'].recognized).toBe(false);
  });
});

describe('createAssetStore — visibleIds (recognition-filtered tree)', () => {
  const NESTED_FIXTURE: Record<string, AssetEntry[]> = {
    '': [
      { name: 'shaders', kind: 'folder' },
      { name: 'docs', kind: 'folder' },
      { name: 'readme.md', kind: 'file' },
    ],
    shaders: [{ name: 'noise.glsl', kind: 'file' }, { name: 'notes.txt', kind: 'file' }],
    docs: [{ name: 'plan.txt', kind: 'file' }],
  };

  it('marks only recognition-candidate files and their ancestor folders visible', async () => {
    const reader = fixtureReader(NESTED_FIXTURE);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();

    const root = store.getState().roots[0];
    expect(root.visibleIds).toEqual(new Set(['shaders', 'shaders/noise.glsl']));

    const filtered = flattenVisibleTree(root.nodesById, root.rootIds, root.visibleIds).map((n) => n.id);
    expect(filtered).toEqual(['shaders']); // noise.glsl only appears once 'shaders' is expanded
  });

  it('never calls readText while computing visibility', async () => {
    const reader = fixtureReader(NESTED_FIXTURE);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();
    expect(reader.readTextCalls).toEqual([]);
  });

  it('hides a folder entirely when nothing recognizable is anywhere inside it', async () => {
    const reader = fixtureReader(NESTED_FIXTURE);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();
    const root = store.getState().roots[0];
    expect(root.visibleIds?.has('docs')).toBe(false);
    expect(root.visibleIds?.has('readme.md')).toBe(false);
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

  it('changes what the NEXT connect()\'s scan and recognizeNode call match on', async () => {
    const reader = fixtureReader(SWAP_FIXTURE, SWAP_TEXT);
    // Starts with a config that cannot possibly match `.glsl`.
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.wgsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();
    const firstRootId = store.getState().roots[0].id;

    await store.getState().recognizeNode(firstRootId, 'noise.glsl');
    expect(store.getState().roots[0].nodesById['noise.glsl'].recognized).toBe(false);
    expect(store.getState().roots[0].visibleIds?.size).toBe(0);

    // Swap to a config that matches `.glsl`. Already-connected roots are
    // deliberately NOT retroactively re-scanned — connecting a fresh root
    // makes the new config's effect on both the scan and `recognizeNode`
    // observable.
    store.getState().setRecognitionConfig({ fileExtensions: ['.glsl'] });
    expect(store.getState().recognitionConfig).toEqual({ fileExtensions: ['.glsl'] });
    await store.getState().connect();
    const secondRootId = store.getState().roots[1].id;

    expect(store.getState().roots[1].visibleIds).toEqual(new Set(['noise.glsl']));
    await store.getState().recognizeNode(secondRootId, 'noise.glsl');
    expect(store.getState().roots[1].nodesById['noise.glsl'].recognized).toBe(true);
  });

  it('does not retroactively re-check an already-recognized node after a config swap', async () => {
    const reader = fixtureReader(SWAP_FIXTURE, SWAP_TEXT);
    const deps = makeDeps({ createReader: () => reader, recognitionConfig: { fileExtensions: ['.glsl'] } });
    const store = createAssetStore(deps);
    await store.getState().connect();
    const rootId = store.getState().roots[0].id;

    await store.getState().recognizeNode(rootId, 'noise.glsl');
    expect(store.getState().roots[0].nodesById['noise.glsl'].recognized).toBe(true);

    store.getState().setRecognitionConfig({ fileExtensions: ['.wgsl'] });
    await store.getState().recognizeNode(rootId, 'noise.glsl'); // no-op: already checked
    expect(store.getState().roots[0].nodesById['noise.glsl'].recognized).toBe(true);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
