// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: recognition-filtered tree scan
// ───────────────────────────────────────────────────────────────────────────
// Builds the FULL node tree for a connected root — every folder and file,
// recursively — plus the set of node ids that should be visible once the
// Assets panel filters to "only folders that lead to a recognized file, and
// only recognized files themselves" (this task's Definition of Done).
//
// This costs one `listEntries` call per folder in the tree (cheap: names +
// kind only, no bytes) — never a `readText` call. That is the load-bearing
// distinction from `assetStore.ts`'s `recognizeNode`, which reads a file's
// full text but only for one VISIBLE row at a time. Recognition there stays
// exactly that lazy; this module answers a different, structural question —
// "could this file possibly match, by extension alone" — using the same
// `isRecognitionCandidate` pre-check `recognizeNode` already uses to decide
// whether reading a file's text is even worth doing. A file that clears this
// module's filter is a CANDIDATE, not yet a content-verified `recognized:
// true` — that verification still happens lazily, visible-row-only, via
// `recognizeNode`, once the row actually scrolls into view. A candidate whose
// content later fails that check stays visible; this module never
// retroactively re-filters (matching `recognizeNode`/`setRecognitionConfig`'s
// own documented "not retroactive" precedent).
// ═══════════════════════════════════════════════════════════════════════════

import type { RecognitionConfig } from './recognition';
import { makeNode, nodeId, type AssetTreeNode } from './tree';
import type { DirectoryReader } from './types';

/** Extension pre-check only — never reads a file's text. Shared by
 *  `assetStore.ts`'s `recognizeNode` (which skips straight to
 *  `recognized: false` for files no config extension could ever match) and
 *  this module's structural scan below. */
export function isRecognitionCandidate(fileName: string, config: RecognitionConfig): boolean {
  const extensions = [...(config.fileExtensions ?? []), ...(config.bundledExtensions ?? [])];
  if (extensions.length === 0) return false;
  const lower = fileName.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

export interface RecognitionScanResult {
  nodesById: Record<string, AssetTreeNode>;
  rootIds: string[];
  /** Every node id (file or folder) that should render in the filtered
   *  tree: each recognition-candidate file's id, plus every ancestor folder
   *  id on the path down to it. A folder with zero candidate descendants
   *  anywhere in its subtree — and every file that isn't itself a
   *  candidate — is simply absent. */
  visibleIds: Set<string>;
}

/** Recursively lists (never reads) an entire connected root, building both
 *  the plain node tree `AssetTreeNode`s the UI already renders (unchanged
 *  shape, unchanged `path`/`depth`/`childIds` semantics from `tree.ts`) and
 *  the `visibleIds` filter set above, in one pass. One bad subfolder (a
 *  permission error, a transient read failure) is caught locally and treated
 *  as an empty, invisible folder rather than failing the whole root's
 *  connection. */
export async function scanRecognitionFilteredTree(
  reader: DirectoryReader,
  config: RecognitionConfig,
): Promise<RecognitionScanResult> {
  const nodesById: Record<string, AssetTreeNode> = {};
  const visibleIds = new Set<string>();

  async function walkFolder(path: string[], parentId: string | undefined): Promise<string[]> {
    const entries = await reader.listEntries(path);
    // Ids are derived synchronously from already-known names, so the
    // returned `childIds` preserves `listEntries`' own order regardless of
    // how the concurrent recursion below settles.
    const childIds = entries.map((entry) => nodeId([...path, entry.name]));

    await Promise.all(
      entries.map(async (entry, index) => {
        const entryPath = [...path, entry.name];
        const id = childIds[index];

        if (entry.kind === 'file') {
          nodesById[id] = makeNode(entryPath, entry.name, 'file', parentId);
          if (isRecognitionCandidate(entry.name, config)) visibleIds.add(id);
          return;
        }

        const grandChildIds = await walkFolder(entryPath, id).catch(() => [] as string[]);
        nodesById[id] = { ...makeNode(entryPath, entry.name, 'folder', parentId), childIds: grandChildIds };
        if (grandChildIds.some((childId) => visibleIds.has(childId))) visibleIds.add(id);
      }),
    );

    return childIds;
  }

  const rootIds = await walkFolder([], undefined);
  return { nodesById, rootIds, visibleIds };
}
