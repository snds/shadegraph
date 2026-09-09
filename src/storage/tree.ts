// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: tree shape + pure helpers
// ───────────────────────────────────────────────────────────────────────────
// `AssetTreeNode` is the plain-data contract the UI is allowed to see (per
// the task's "no `FileSystemHandle` outside `src/storage/`" requirement) —
// a superset of the `{ name, kind, preview? }` shape sketched in the brief,
// with the bookkeeping (id/depth/expansion/loading) a real tree UI needs.
// `flattenVisibleTree` is what the virtualized list windows over — pure, so
// it's unit-testable without React or a real store.
// ═══════════════════════════════════════════════════════════════════════════

import type { AssetEntryKind, PreviewKind } from './types';
import type { RecognizedShaderObject } from './recognition/types';

export type PreviewState = 'idle' | 'loading' | 'loaded' | 'unavailable';

export interface AssetTreeNode {
  id: string;
  name: string;
  kind: AssetEntryKind;
  /** Name segments from the connected root; `resolveDirectory`/`openPreview`
   *  calls take this directly. */
  path: string[];
  depth: number;
  parentId?: string;
  expanded: boolean;
  /** `undefined` = never listed yet (folders only); `[]` = listed and empty. */
  childIds?: string[];
  loadingChildren: boolean;
  preview?: string;
  previewKind?: PreviewKind;
  previewState: PreviewState;
  /** Shader-object recognition result for this node (files only):
   *  `undefined` = not checked yet, `true`/`false` = checked, per
   *  `recognizeShaderObjects` (`src/storage/recognition/recognize.ts`).
   *  Populated lazily by `assetStore.ts`'s `recognizeNode`, never eagerly. */
  recognized?: boolean;
  /** The object(s) `recognizeShaderObjects` found for this node once
   *  `recognized` is `true` (`undefined` otherwise, including the common
   *  not-a-shader-file case) — one node can yield more than one object for a
   *  bundled-chunk config. Lets a "graph this" action call
   *  `graphFromRecognizedObject` directly, without re-recognizing. */
  recognizedObjects?: RecognizedShaderObject[];
  /** The exact text `recognizedObjects` was recognized from, kept only
   *  alongside a `true` `recognized` result — the "already-read source text"
   *  a "graph this" action passes straight through to
   *  `graphFromRecognizedObject`, never re-read from disk. */
  sourceText?: string;
}

export function nodeId(path: string[]): string {
  return path.join('/');
}

export function makeNode(path: string[], name: string, kind: AssetEntryKind, parentId?: string): AssetTreeNode {
  return {
    id: nodeId(path),
    name,
    kind,
    path,
    depth: path.length - 1,
    parentId,
    expanded: false,
    childIds: undefined,
    loadingChildren: false,
    preview: undefined,
    previewKind: undefined,
    previewState: 'idle',
    recognized: undefined,
    recognizedObjects: undefined,
    sourceText: undefined,
  };
}

/** Depth-first, expansion-aware flattening: a folder's children only appear
 *  if the folder itself is `expanded` (and already loaded). This — not the
 *  full tree — is what the browser panel virtualizes over. */
export function flattenVisibleTree(nodesById: Record<string, AssetTreeNode>, rootIds: string[]): AssetTreeNode[] {
  const out: AssetTreeNode[] = [];
  const visit = (ids: string[]): void => {
    for (const id of ids) {
      const node = nodesById[id];
      if (!node) continue;
      out.push(node);
      if (node.kind === 'folder' && node.expanded && node.childIds) {
        visit(node.childIds);
      }
    }
  };
  visit(rootIds);
  return out;
}
