import { describe, expect, it } from 'vitest';

import { emptyDocument } from './document';
import { emptyLayer } from './factory';
import {
  MANIFEST_SCHEMA_VERSION,
  ManifestParseError,
  emptyManifest,
  parseManifest,
  serializeManifest,
  validateManifest,
  type DiscoveredObject,
  type ProjectManifest,
} from './projectManifest';

/** One discovered object per state, so round-trip coverage exercises all
 *  three tiers the manifest is meant to carry over time. */
function discoveredInEachState(): DiscoveredObject[] {
  const draftDoc = emptyDocument('Draft chunk');
  draftDoc.layerStack.layers.push(emptyLayer('Detail'));

  return [
    {
      id: 'obj-metadata-only',
      folderId: 'folder-1',
      path: ['shaders', 'terrain.glsl'],
      name: 'GLSL_TERRAIN',
      metadata: { tags: ['terrain', 'rocky'], notes: 'Looks promising for the base layer.' },
      state: { status: 'discovered' },
    },
    {
      id: 'obj-draft',
      folderId: 'folder-1',
      path: ['shaders', 'clouds.glsl'],
      name: 'GLSL_CLOUDS',
      metadata: { tags: ['clouds'] },
      state: { status: 'draft', draft: draftDoc },
    },
    {
      id: 'obj-saved',
      folderId: 'folder-2',
      path: ['fbm.ts'],
      name: 'GLSL_FBM',
      metadata: { tags: ['noise'], notes: 'Formally saved.' },
      state: { status: 'saved', documentPath: 'graphs/fbm.shadegraph.json' },
    },
  ];
}

/** A manifest exercising every field, so round-trip coverage is not just the
 *  happy minimum (mirrors `richDocument()` in `serialize.test.ts`). */
function richManifest(): ProjectManifest {
  const manifest = emptyManifest('Legion source');
  manifest.connectedFolders = [
    { id: 'folder-1', name: 'planet' },
    { id: 'folder-2', name: 'shared-chunks' },
  ];
  manifest.discoveredObjects = discoveredInEachState();
  manifest.meta.updated = new Date(Date.now() + 1000).toISOString();
  return manifest;
}

describe('serializeManifest / parseManifest', () => {
  it('round-trips an empty manifest losslessly', () => {
    const manifest = emptyManifest();

    expect(parseManifest(serializeManifest(manifest))).toEqual(manifest);
  });

  it('round-trips a populated manifest losslessly', () => {
    const manifest = richManifest();

    const restored = parseManifest(serializeManifest(manifest));

    expect(restored).toEqual(manifest);
    // toEqual ignores key order but not key *presence*; compare the text too.
    expect(serializeManifest(restored)).toBe(serializeManifest(manifest));
  });

  it('survives repeated round-trips without drift', () => {
    const once = serializeManifest(richManifest());
    const twice = serializeManifest(parseManifest(once));
    const thrice = serializeManifest(parseManifest(twice));

    expect(twice).toBe(once);
    expect(thrice).toBe(once);
  });

  it.each([
    ['metadata-only', () => discoveredInEachState()[0]],
    ['draft', () => discoveredInEachState()[1]],
    ['saved', () => discoveredInEachState()[2]],
  ])('round-trips a %s discovered-object entry on its own', (_label, makeEntry) => {
    const manifest = emptyManifest();
    manifest.discoveredObjects = [makeEntry()];

    const restored = parseManifest(serializeManifest(manifest));

    expect(restored).toEqual(manifest);
  });

  it('emits indented JSON by default and compact JSON on request', () => {
    const manifest = emptyManifest();

    expect(serializeManifest(manifest)).toContain('\n  ');
    expect(serializeManifest(manifest, false)).not.toContain('\n');
  });
});

describe('parseManifest validation', () => {
  const parseFails = (json: string, match: RegExp) => {
    expect(() => parseManifest(json)).toThrow(ManifestParseError);
    expect(() => parseManifest(json)).toThrow(match);
  };

  it('rejects malformed JSON', () => {
    parseFails('{ not json', /Not valid JSON/);
  });

  it('rejects a non-object payload', () => {
    parseFails('[]', /expected a JSON object/);
    parseFails('42', /expected a JSON object/);
  });

  it('rejects a manifest from a different schema version', () => {
    const manifest = { ...emptyManifest(), schemaVersion: '9.9.9' };

    parseFails(JSON.stringify(manifest), /Unsupported manifest schema version "9\.9\.9"/);
  });

  it('rejects missing top-level fields', () => {
    const manifest = emptyManifest();
    delete (manifest as { discoveredObjects?: unknown[] }).discoveredObjects;

    parseFails(JSON.stringify(manifest), /"discoveredObjects"/);
  });

  it('rejects a malformed connected-folder reference', () => {
    const manifest = emptyManifest();
    manifest.connectedFolders = [{ id: 'f1' } as unknown as ProjectManifest['connectedFolders'][number]];

    parseFails(JSON.stringify(manifest), /Connected folder 0 is missing a string "name"/);
  });

  it('rejects a discovered object with an unrecognised state', () => {
    const manifest = emptyManifest();
    manifest.discoveredObjects = [
      {
        id: 'obj-1',
        folderId: 'folder-1',
        path: [],
        name: 'X',
        metadata: { tags: [] },
        state: { status: 'bogus' } as unknown as DiscoveredObject['state'],
      },
    ];

    parseFails(JSON.stringify(manifest), /unrecognised state "status"/);
  });

  it('rejects a draft discovered object embedding an invalid document', () => {
    const manifest = emptyManifest();
    const draft = emptyDocument();
    delete (draft as { blackboard?: unknown[] }).blackboard;

    manifest.discoveredObjects = [
      {
        id: 'obj-1',
        folderId: 'folder-1',
        path: [],
        name: 'X',
        metadata: { tags: [] },
        state: { status: 'draft', draft: draft as never },
      },
    ];

    parseFails(JSON.stringify(manifest), /invalid draft document/);
  });

  it('rejects a saved discovered object missing its document path', () => {
    const manifest = emptyManifest();
    manifest.discoveredObjects = [
      {
        id: 'obj-1',
        folderId: 'folder-1',
        path: [],
        name: 'X',
        metadata: { tags: [] },
        state: { status: 'saved' } as unknown as DiscoveredObject['state'],
      },
    ];

    parseFails(JSON.stringify(manifest), /missing a string "documentPath"/);
  });

  it('accepts an already-parsed object through validateManifest', () => {
    const manifest = emptyManifest();

    expect(validateManifest(JSON.parse(serializeManifest(manifest)))).toEqual(manifest);
    expect(manifest.schemaVersion).toBe(MANIFEST_SCHEMA_VERSION);
  });
});
