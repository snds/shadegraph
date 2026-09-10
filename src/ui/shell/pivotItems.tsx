// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — pivot rail entries
// ───────────────────────────────────────────────────────────────────────────
// The one place that lists what the left rail can show. `PivotRail`/`Shell`
// know nothing about Layers, Assets, Nodes, Manifest, or Critique
// specifically — they only iterate this typed array. Adding a panel later
// (or replacing a placeholder with the real thing) means editing THIS file
// plus the panel component itself; nothing about the rail or panel host
// changes shape.
//
// `content` is always a bare, chrome-free component: no toggle, no overlay,
// no own `open` state (see `AssetBrowserPanel.tsx`'s split for the pattern).
// The pivot host always renders it while its tab is active and unmounts it
// otherwise — same "dirty + visible only" discipline the preview renderer
// uses elsewhere in this codebase.
// ═══════════════════════════════════════════════════════════════════════════

import type { ComponentType } from 'react';

import { AssetBrowserPanel } from '../assets/AssetBrowserPanel';
import { CritiquePanel } from '../critique/CritiquePanel';
import { LayerStack } from '../layers/LayerStack';
import { ManifestPanel } from '../manifest/ManifestPanel';
import { PlaceholderPanel } from './PlaceholderPanel';

export interface PivotItem {
  id: string;
  /** Material Symbols ligature name — see `Icon.tsx`. */
  icon: string;
  label: string;
  content: ComponentType;
}

function NodesPlaceholder() {
  return (
    <PlaceholderPanel
      label="Nodes"
      hint="Node type gallery — wired up by a later Phase 6 task, not this one."
    />
  );
}

export const pivotItems: PivotItem[] = [
  { id: 'layers', icon: 'layers', label: 'Layers', content: LayerStack },
  { id: 'assets', icon: 'folder', label: 'Assets', content: AssetBrowserPanel },
  { id: 'nodes', icon: 'account_tree', label: 'Nodes', content: NodesPlaceholder },
  { id: 'manifest', icon: 'inventory_2', label: 'Manifest', content: ManifestPanel },
  { id: 'critique', icon: 'rate_review', label: 'Critique', content: CritiquePanel },
];
