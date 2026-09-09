// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Project-manifest store
// ───────────────────────────────────────────────────────────────────────────
// The React-facing home for the active `ProjectManifest` (Phase 5), mirroring
// `src/ui/store.ts`'s treatment of `ShaderDocument`: one zustand store holding
// pure data, exposing intent-shaped actions that return a NEW manifest rather
// than mutating, and touching `meta.updated` on every change.
//
// `src/model/projectManifest.ts` only ships ONE state-transition helper
// (`setDiscoveredObjectDraft`, "discovered" → "draft") because it is the only
// one the Phase 5 model task needed. This store is the place to add the
// others `DiscoveredObject.state` can move through — metadata edits and the
// "draft" → "saved" transition — as thin equivalents built the same way
// (`updateDiscoveredObject` below mirrors that helper's own shape) without
// touching the model file, which this task's brief keeps unmodified.
//
// File I/O (download / parse-from-file) is deliberately NOT here — see
// `manifestPersistence.ts` — same split `src/ui/store.ts`/`src/ui/persistence.ts`
// already use for the document: the store never touches `Blob`/`URL`/`File`,
// so it stays trivially testable in a DOM-less environment.
// ═══════════════════════════════════════════════════════════════════════════

import { create } from 'zustand';

import type { ShaderDocument } from '../../model/document';
import {
  emptyManifest,
  setDiscoveredObjectDraft as setDiscoveredObjectDraftModel,
  type ConnectedFolderRef,
  type DiscoveredObject,
  type DiscoveredObjectMetadata,
  type ProjectManifest,
} from '../../model/projectManifest';

/** Short, collision-resistant-enough suffix for a new folder ref's id — same
 *  treatment as `src/model/ids.ts`'s node/layer/group ids, kept local here
 *  since connected-folder ids are a manifest-store concern, not a document
 *  one. */
function makeConnectedFolderId(): string {
  return `folder_${Math.random().toString(36).slice(2, 8)}`;
}

/** Stamp `meta.updated`. Called by every mutation, exactly like `store.ts`'s
 *  `touch` does for the document. */
function touch(manifest: ProjectManifest): ProjectManifest {
  return { ...manifest, meta: { ...manifest.meta, updated: new Date().toISOString() } };
}

/** Shared body for the `DiscoveredObject` transitions this store owns
 *  directly (metadata edits, "saved"). Mirrors `setDiscoveredObjectDraft`'s
 *  own shape in `projectManifest.ts`: a no-op (same manifest reference back)
 *  when `objectId` names nothing, so callers can tell "nothing changed" from
 *  "changed" with a simple reference check. */
function updateDiscoveredObject(
  manifest: ProjectManifest,
  objectId: string,
  fn: (obj: DiscoveredObject) => DiscoveredObject,
): ProjectManifest {
  const index = manifest.discoveredObjects.findIndex((o) => o.id === objectId);
  if (index === -1) return manifest;
  const discoveredObjects = manifest.discoveredObjects.slice();
  discoveredObjects[index] = fn(discoveredObjects[index]);
  return touch({ ...manifest, discoveredObjects });
}

export interface ManifestStore {
  /** The one durable artifact this store holds. */
  manifest: ProjectManifest;
  /** Human-readable reason the last rejected action failed, or `null`. */
  lastError: string | null;

  // Connected folders
  /** Append a new `ConnectedFolderRef` with a generated id. Returns its id. */
  addConnectedFolder: (name: string) => string;
  /** No-op if `id` names no connected folder. */
  removeConnectedFolder: (id: string) => void;

  // Discovered-object state transitions (see the module doc comment above)
  /** Merge `patch` into one discovered object's free-form metadata. */
  setDiscoveredObjectMetadata: (objectId: string, patch: Partial<DiscoveredObjectMetadata>) => void;
  /** "discovered" → "draft": wraps `projectManifest.ts`'s own helper. */
  setDiscoveredObjectDraft: (objectId: string, draft: ShaderDocument) => void;
  /** "draft" → "saved": the draft is dropped in favour of a reference to the
   *  standalone file it was formally saved to. */
  setDiscoveredObjectSaved: (objectId: string, documentPath: string) => void;

  // Whole-manifest load / reset (file I/O itself lives in `manifestPersistence.ts`)
  /** Replace the store's manifest wholesale — the load path's last step,
   *  called only once `manifestPersistence.ts` has validated the text. */
  loadManifest: (manifest: ProjectManifest) => void;
  /** Start a fresh, empty manifest. */
  newManifest: (name?: string) => void;
  clearError: () => void;
}

export const useManifestStore = create<ManifestStore>((set, get) => ({
  manifest: emptyManifest(),
  lastError: null,

  addConnectedFolder(name) {
    const folder: ConnectedFolderRef = {
      id: makeConnectedFolderId(),
      name: name.trim() || 'Untitled folder',
    };
    const manifest = get().manifest;
    set({
      manifest: touch({ ...manifest, connectedFolders: [...manifest.connectedFolders, folder] }),
      lastError: null,
    });
    return folder.id;
  },

  removeConnectedFolder(id) {
    const manifest = get().manifest;
    if (!manifest.connectedFolders.some((f) => f.id === id)) return;
    set({
      manifest: touch({
        ...manifest,
        connectedFolders: manifest.connectedFolders.filter((f) => f.id !== id),
      }),
      lastError: null,
    });
  },

  setDiscoveredObjectMetadata(objectId, patch) {
    const prev = get().manifest;
    const manifest = updateDiscoveredObject(prev, objectId, (obj) => ({
      ...obj,
      metadata: { ...obj.metadata, ...patch },
    }));
    if (manifest === prev) {
      set({ lastError: `No discovered object "${objectId}".` });
      return;
    }
    set({ manifest, lastError: null });
  },

  setDiscoveredObjectDraft(objectId, draft) {
    const prev = get().manifest;
    const manifest = setDiscoveredObjectDraftModel(prev, objectId, draft);
    if (manifest === prev) {
      set({ lastError: `No discovered object "${objectId}".` });
      return;
    }
    set({ manifest, lastError: null });
  },

  setDiscoveredObjectSaved(objectId, documentPath) {
    const prev = get().manifest;
    const manifest = updateDiscoveredObject(prev, objectId, (obj) => ({
      ...obj,
      state: { status: 'saved', documentPath },
    }));
    if (manifest === prev) {
      set({ lastError: `No discovered object "${objectId}".` });
      return;
    }
    set({ manifest, lastError: null });
  },

  loadManifest(manifest) {
    set({ manifest, lastError: null });
  },

  newManifest(name) {
    set({ manifest: emptyManifest(name), lastError: null });
  },

  clearError() {
    set({ lastError: null });
  },
}));
