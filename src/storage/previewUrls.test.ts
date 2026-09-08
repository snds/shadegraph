import { describe, expect, it, vi } from 'vitest';

import { createPreviewUrlManager } from './previewUrls';
import type { ObjectUrlFactory } from './types';

function fakeUrlFactory(): ObjectUrlFactory & { created: string[]; revoked: string[] } {
  let counter = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  return {
    created,
    revoked,
    createObjectURL: () => {
      const url = `blob:fake-${counter++}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => revoked.push(url),
  };
}

const fakeBlob = {} as Blob;

describe('createPreviewUrlManager', () => {
  it('creates one URL per key on first acquire', () => {
    const factory = fakeUrlFactory();
    const manager = createPreviewUrlManager(factory);
    const url = manager.acquire('a', fakeBlob);
    expect(url).toBe(factory.created[0]);
    expect(manager.size).toBe(1);
  });

  it('reuses the same URL and refcounts repeat acquires for the same key', () => {
    const factory = fakeUrlFactory();
    const manager = createPreviewUrlManager(factory);
    const first = manager.acquire('a', fakeBlob);
    const second = manager.acquire('a', fakeBlob);
    expect(second).toBe(first);
    expect(factory.created).toHaveLength(1);
  });

  it('does not revoke until every acquire has a matching release', () => {
    const factory = fakeUrlFactory();
    const manager = createPreviewUrlManager(factory);
    manager.acquire('a', fakeBlob);
    manager.acquire('a', fakeBlob);
    manager.release('a');
    expect(factory.revoked).toHaveLength(0);
    manager.release('a');
    expect(factory.revoked).toHaveLength(1);
    expect(manager.size).toBe(0);
  });

  it('release on an unknown key is a harmless no-op', () => {
    const factory = fakeUrlFactory();
    const manager = createPreviewUrlManager(factory);
    expect(() => manager.release('missing')).not.toThrow();
    expect(factory.revoked).toHaveLength(0);
  });

  it('releaseAll revokes every outstanding URL regardless of refcount', () => {
    const factory = fakeUrlFactory();
    const manager = createPreviewUrlManager(factory);
    manager.acquire('a', fakeBlob);
    manager.acquire('a', fakeBlob);
    manager.acquire('b', fakeBlob);
    manager.releaseAll();
    expect(factory.revoked.sort()).toEqual(factory.created.sort());
    expect(manager.size).toBe(0);
  });

  it('falls back to the global URL API when no factory is injected', () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:real');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const manager = createPreviewUrlManager();
    manager.acquire('a', fakeBlob);
    manager.release('a');
    expect(createSpy).toHaveBeenCalledWith(fakeBlob);
    expect(revokeSpy).toHaveBeenCalledWith('blob:real');
    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });
});
