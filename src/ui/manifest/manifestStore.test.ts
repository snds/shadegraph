import { beforeEach, describe, expect, it } from 'vitest';

import { emptyDocument } from '../../model/document';
import type { DiscoveredObject } from '../../model/projectManifest';
import { useManifestStore } from './manifestStore';

const store = () => useManifestStore.getState();

/** Seed one discovered object directly into the store's manifest — there is
 *  no store action to CREATE a discovered object (that's the next task's
 *  discovery-wiring concern; see the task note), so tests that need one to
 *  transition splice it in directly. */
function seedDiscoveredObject(overrides: Partial<DiscoveredObject> = {}): string {
  const object: DiscoveredObject = {
    id: 'obj-1',
    folderId: 'folder-1',
    path: ['shaders', 'terrain.glsl'],
    name: 'GLSL_TERRAIN',
    metadata: { tags: ['terrain'] },
    state: { status: 'discovered' },
    ...overrides,
  };
  const manifest = store().manifest;
  useManifestStore.setState({ manifest: { ...manifest, discoveredObjects: [...manifest.discoveredObjects, object] } });
  return object.id;
}

beforeEach(() => {
  store().newManifest('Test project');
});

describe('newManifest / loadManifest', () => {
  it('starts as an empty manifest', () => {
    expect(store().manifest.connectedFolders).toEqual([]);
    expect(store().manifest.discoveredObjects).toEqual([]);
    expect(store().manifest.name).toBe('Test project');
  });

  it('loadManifest replaces the store state wholesale', () => {
    const incoming = { ...store().manifest, name: 'Loaded' };
    store().loadManifest(incoming);
    expect(store().manifest).toBe(incoming);
    expect(store().manifest.name).toBe('Loaded');
  });

  it('loadManifest clears any previous error', () => {
    useManifestStore.setState({ lastError: 'boom' });
    store().loadManifest(store().manifest);
    expect(store().lastError).toBeNull();
  });
});

describe('connected folders', () => {
  it('addConnectedFolder appends a folder with a generated id and refreshes meta.updated', () => {
    const before = store().manifest.meta.created;
    const id = store().addConnectedFolder('Assets');
    expect(store().manifest.connectedFolders).toEqual([{ id, name: 'Assets' }]);
    expect(new Date(store().manifest.meta.updated).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it('addConnectedFolder falls back to a default name when blank', () => {
    const id = store().addConnectedFolder('   ');
    expect(store().manifest.connectedFolders.find((f) => f.id === id)?.name).toBe('Untitled folder');
  });

  it('two added folders get distinct ids', () => {
    const a = store().addConnectedFolder('A');
    const b = store().addConnectedFolder('B');
    expect(a).not.toBe(b);
  });

  it('removeConnectedFolder removes exactly the named folder', () => {
    const a = store().addConnectedFolder('A');
    const b = store().addConnectedFolder('B');
    store().removeConnectedFolder(a);
    expect(store().manifest.connectedFolders.map((f) => f.id)).toEqual([b]);
  });

  it('removeConnectedFolder is a no-op for an unknown id', () => {
    store().addConnectedFolder('A');
    const before = store().manifest;
    store().removeConnectedFolder('nope');
    expect(store().manifest).toBe(before);
  });
});

describe('discovered-object transitions', () => {
  it('setDiscoveredObjectMetadata merges into the existing metadata', () => {
    const id = seedDiscoveredObject({ metadata: { tags: ['a'], notes: 'keep me' } });
    store().setDiscoveredObjectMetadata(id, { tags: ['a', 'b'] });
    const obj = store().manifest.discoveredObjects.find((o) => o.id === id);
    expect(obj?.metadata).toEqual({ tags: ['a', 'b'], notes: 'keep me' });
  });

  it('setDiscoveredObjectMetadata sets lastError for an unknown object id', () => {
    store().setDiscoveredObjectMetadata('missing', { tags: [] });
    expect(store().lastError).toMatch(/missing/);
  });

  it('setDiscoveredObjectDraft promotes "discovered" to "draft" via the model helper', () => {
    const id = seedDiscoveredObject();
    const draft = emptyDocument('Draft graph');
    store().setDiscoveredObjectDraft(id, draft);
    const obj = store().manifest.discoveredObjects.find((o) => o.id === id);
    expect(obj?.state).toEqual({ status: 'draft', draft });
  });

  it('setDiscoveredObjectDraft sets lastError for an unknown object id', () => {
    store().setDiscoveredObjectDraft('missing', emptyDocument());
    expect(store().lastError).toMatch(/missing/);
  });

  it('setDiscoveredObjectSaved moves "draft" to "saved", dropping the embedded draft', () => {
    const id = seedDiscoveredObject({ state: { status: 'draft', draft: emptyDocument('Draft graph') } });
    store().setDiscoveredObjectSaved(id, 'graphs/terrain.shadegraph.json');
    const obj = store().manifest.discoveredObjects.find((o) => o.id === id);
    expect(obj?.state).toEqual({ status: 'saved', documentPath: 'graphs/terrain.shadegraph.json' });
  });

  it('setDiscoveredObjectSaved sets lastError for an unknown object id', () => {
    store().setDiscoveredObjectSaved('missing', 'x.json');
    expect(store().lastError).toMatch(/missing/);
  });

  it('a successful transition clears any previous error', () => {
    const id = seedDiscoveredObject();
    useManifestStore.setState({ lastError: 'stale' });
    store().setDiscoveredObjectMetadata(id, { tags: [] });
    expect(store().lastError).toBeNull();
  });
});

describe('clearError', () => {
  it('resets lastError to null', () => {
    useManifestStore.setState({ lastError: 'boom' });
    store().clearError();
    expect(store().lastError).toBeNull();
  });
});
