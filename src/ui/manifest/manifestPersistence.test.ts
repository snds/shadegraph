import { describe, expect, it } from 'vitest';

import { emptyDocument } from '../../model/document';
import { emptyManifest, setDiscoveredObjectDraft, type ProjectManifest } from '../../model/projectManifest';
import { manifestFileName, parseManifestText } from './manifestPersistence';

/** A manifest exercising every field a bare `emptyManifest()` leaves empty,
 *  so the round-trip test is not just the happy minimum — mirrors
 *  `projectManifest.test.ts`'s own richer fixtures. */
function richManifest(): ProjectManifest {
  let manifest = emptyManifest('Rocky project');
  manifest = {
    ...manifest,
    connectedFolders: [{ id: 'folder-1', name: 'Assets' }],
    discoveredObjects: [
      {
        id: 'obj-1',
        folderId: 'folder-1',
        path: ['shaders', 'terrain.glsl'],
        name: 'GLSL_TERRAIN',
        metadata: { tags: ['terrain'], notes: 'promising' },
        state: { status: 'discovered' },
      },
    ],
  };
  return setDiscoveredObjectDraft(manifest, 'obj-1', emptyDocument('Draft chunk'));
}

describe('save -> load round trip (through parseManifestText)', () => {
  it('restores an empty manifest losslessly', () => {
    const manifest = emptyManifest('Empty project');
    const result = parseManifestText(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest).toEqual(manifest);
  });

  it('restores a populated manifest (folders + every discovered-object state) losslessly', () => {
    const manifest = richManifest();
    const result = parseManifestText(JSON.stringify(manifest));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest).toEqual(manifest);
  });

  it('survives repeated save/load cycles without drift', () => {
    const original = richManifest();
    let manifest: ProjectManifest = original;
    for (let i = 0; i < 3; i++) {
      const result = parseManifestText(JSON.stringify(manifest));
      expect(result.ok).toBe(true);
      if (result.ok) manifest = result.manifest;
    }
    expect(manifest).toEqual(original);
  });
});

describe('parseManifestText', () => {
  it('reports malformed JSON instead of throwing', () => {
    const result = parseManifestText('{not json');
    expect(result).toEqual({ ok: false, message: expect.stringContaining('Not valid JSON') });
  });

  it('rejects a non-object payload, with a message fit to show the user', () => {
    const result = parseManifestText(JSON.stringify([]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('expected a JSON object');
  });

  it('rejects a manifest from another schema version', () => {
    const manifest = { ...emptyManifest(), schemaVersion: '99.0.0' };
    const result = parseManifestText(JSON.stringify(manifest));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Unsupported manifest schema version');
  });

  it('rejects a malformed connected-folder reference', () => {
    const manifest = { ...emptyManifest(), connectedFolders: [{ id: 'only-id' }] };
    const result = parseManifestText(JSON.stringify(manifest));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('Connected folder');
  });
});

describe('manifestFileName', () => {
  it('appends the manifest suffix', () => {
    expect(manifestFileName('Rocky')).toBe('Rocky.shadegraph-manifest.json');
  });

  it('collapses characters a filesystem would reject', () => {
    expect(manifestFileName('Rocky Planet / v2')).toBe('Rocky-Planet-v2.shadegraph-manifest.json');
    expect(manifestFileName('  spaced  out  ')).toBe('spaced-out.shadegraph-manifest.json');
  });

  it('falls back to "untitled" for an unusable name', () => {
    expect(manifestFileName('')).toBe('untitled.shadegraph-manifest.json');
    expect(manifestFileName('///')).toBe('untitled.shadegraph-manifest.json');
  });
});
