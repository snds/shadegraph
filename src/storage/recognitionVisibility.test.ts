import { describe, expect, it } from 'vitest';

import { isRecognitionCandidate, scanRecognitionFilteredTree } from './recognitionVisibility';
import type { AssetEntry, DirectoryReader } from './types';

function fixtureReader(fixture: Record<string, AssetEntry[]>): DirectoryReader & { readTextCalls: string[][] } {
  const readTextCalls: string[][] = [];
  return {
    readTextCalls,
    async listEntries(path) {
      return fixture[path.join('/')] ?? [];
    },
    async openPreview() {
      return undefined;
    },
    async readText(path) {
      readTextCalls.push(path);
      return undefined;
    },
  };
}

describe('isRecognitionCandidate', () => {
  it('matches on fileExtensions and bundledExtensions, case-insensitively', () => {
    const config = { fileExtensions: ['.glsl'], bundledExtensions: ['.ts'] };
    expect(isRecognitionCandidate('noise.GLSL', config)).toBe(true);
    expect(isRecognitionCandidate('chunks.ts', config)).toBe(true);
    expect(isRecognitionCandidate('readme.md', config)).toBe(false);
  });

  it('never matches anything for an empty config', () => {
    expect(isRecognitionCandidate('noise.glsl', {})).toBe(false);
  });
});

describe('scanRecognitionFilteredTree', () => {
  const FIXTURE: Record<string, AssetEntry[]> = {
    '': [
      { name: 'shaders', kind: 'folder' },
      { name: 'docs', kind: 'folder' },
      { name: 'readme.md', kind: 'file' },
    ],
    shaders: [
      { name: 'deep', kind: 'folder' },
      { name: 'noise.glsl', kind: 'file' },
      { name: 'notes.txt', kind: 'file' },
    ],
    'shaders/deep': [{ name: 'fog.glsl', kind: 'file' }],
    docs: [{ name: 'plan.txt', kind: 'file' }],
  };
  const CONFIG = { fileExtensions: ['.glsl'] };

  it('marks every candidate file and each of its ancestor folders visible', async () => {
    const { visibleIds } = await scanRecognitionFilteredTree(fixtureReader(FIXTURE), CONFIG);
    expect(visibleIds).toEqual(
      new Set(['shaders', 'shaders/noise.glsl', 'shaders/deep', 'shaders/deep/fog.glsl']),
    );
  });

  it('excludes a folder with zero candidate descendants anywhere in its subtree', async () => {
    const { visibleIds } = await scanRecognitionFilteredTree(fixtureReader(FIXTURE), CONFIG);
    expect(visibleIds.has('docs')).toBe(false);
    expect(visibleIds.has('docs/plan.txt')).toBe(false);
    expect(visibleIds.has('readme.md')).toBe(false);
  });

  it('excludes a non-candidate file even inside a visible folder (unrelated siblings stay hidden)', async () => {
    const { visibleIds } = await scanRecognitionFilteredTree(fixtureReader(FIXTURE), CONFIG);
    expect(visibleIds.has('shaders/notes.txt')).toBe(false);
  });

  it('builds the full, unfiltered node tree regardless of visibility', async () => {
    const { nodesById, rootIds } = await scanRecognitionFilteredTree(fixtureReader(FIXTURE), CONFIG);
    expect(rootIds).toEqual(['shaders', 'docs', 'readme.md']);
    expect(nodesById['docs'].childIds).toEqual(['docs/plan.txt']);
    expect(nodesById['shaders'].childIds).toEqual(['shaders/deep', 'shaders/noise.glsl', 'shaders/notes.txt']);
    expect(nodesById['shaders/deep'].childIds).toEqual(['shaders/deep/fog.glsl']);
  });

  it('never calls readText — structure only, per the extension pre-check discipline', async () => {
    const reader = fixtureReader(FIXTURE);
    await scanRecognitionFilteredTree(reader, CONFIG);
    expect(reader.readTextCalls).toEqual([]);
  });

  it('produces an empty visible set for an empty recognition config', async () => {
    const { visibleIds } = await scanRecognitionFilteredTree(fixtureReader(FIXTURE), {});
    expect(visibleIds.size).toBe(0);
  });

  it('recovers from one unreadable subfolder instead of rejecting the whole scan', async () => {
    const reader: DirectoryReader = {
      async listEntries(path) {
        if (path.join('/') === 'shaders') throw new Error('permission denied');
        return FIXTURE[path.join('/')] ?? [];
      },
      async openPreview() {
        return undefined;
      },
      async readText() {
        return undefined;
      },
    };
    const { nodesById, visibleIds } = await scanRecognitionFilteredTree(reader, CONFIG);
    expect(nodesById['shaders'].childIds).toEqual([]);
    expect(visibleIds.has('shaders')).toBe(false);
  });
});
