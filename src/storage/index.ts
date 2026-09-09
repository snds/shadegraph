// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: public surface
// ───────────────────────────────────────────────────────────────────────────
// The only module UI code should import from `src/storage/`. Deliberately
// narrow: the store hook, the plain tree-node/flatten helpers, and the
// preview-kind type — never `DirectoryReader`, `HandleStore`, or any
// `FileSystemHandle`-touching module.
// ═══════════════════════════════════════════════════════════════════════════

export { flattenVisibleTree, useAssetStore, type AssetConnectionStatus, type AssetStoreState } from './assetStore';
export {
  defaultRecognitionConfigId,
  getRecognitionConfigOption,
  recognitionConfigOptions,
  type RecognitionConfigOption,
} from './recognitionConfigs';
export type { AssetTreeNode, PreviewState } from './tree';
export type { AssetEntryKind, PreviewKind } from './types';
