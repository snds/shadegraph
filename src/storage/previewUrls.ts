// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: object-URL lifecycle
// ───────────────────────────────────────────────────────────────────────────
// The one place `URL.createObjectURL`/`URL.revokeObjectURL` get called.
// Refcounted per key (an asset's tree-node id) so re-entering a still-visible
// preview (e.g. a re-render during virtualization windowing) doesn't create a
// duplicate URL, and a URL is only ever revoked once nothing holds it — the
// leak this whole manager exists to prevent.
// ═══════════════════════════════════════════════════════════════════════════

import type { ObjectUrlFactory } from './types';

const defaultUrlFactory: ObjectUrlFactory = {
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};

export interface PreviewUrlManager {
  /** Returns the object URL for `key`, creating it from `blob` on first
   *  acquire and incrementing a refcount on every call after that. */
  acquire(key: string, blob: Blob): string;
  /** Decrements `key`'s refcount; revokes the URL once it reaches zero.
   *  A no-op if `key` was never acquired (or already fully released). */
  release(key: string): void;
  /** Revokes every outstanding URL regardless of refcount — for
   *  disconnect/unmount, where nothing should be left dangling. */
  releaseAll(): void;
  /** Test/inspection hook: how many distinct keys currently hold a live URL. */
  readonly size: number;
}

interface Entry {
  url: string;
  refCount: number;
}

export function createPreviewUrlManager(urlFactory: ObjectUrlFactory = defaultUrlFactory): PreviewUrlManager {
  const entries = new Map<string, Entry>();

  return {
    acquire(key, blob) {
      const existing = entries.get(key);
      if (existing) {
        existing.refCount += 1;
        return existing.url;
      }
      const url = urlFactory.createObjectURL(blob);
      entries.set(key, { url, refCount: 1 });
      return url;
    },

    release(key) {
      const existing = entries.get(key);
      if (!existing) return;
      existing.refCount -= 1;
      if (existing.refCount <= 0) {
        urlFactory.revokeObjectURL(existing.url);
        entries.delete(key);
      }
    },

    releaseAll() {
      for (const entry of entries.values()) {
        urlFactory.revokeObjectURL(entry.url);
      }
      entries.clear();
    },

    get size() {
      return entries.size;
    },
  };
}
