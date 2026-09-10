// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — application shell
// ───────────────────────────────────────────────────────────────────────────
//   ┌──────────────────────── DocToolbar ────────────────────────┐
//   ├──────┬─────────────┬───────────────────────────┬───────────┤
//   │ Rail │ Panel host  │   MainContentRegion:       │ Inspector │
//   │ (Layers/Assets/    │   GraphCanvas + MainViewer,│ params of │
//   │  Nodes/Manifest/   │   dockable top/bottom      │ selection │
//   │  Critique pivots)  │   (React Flow above/below   │           │
//   │                    │    the real compiled preview)│          │
//   ├──────┴─────────────┴───────────────────────────┴───────────┤
//   └─────────────────────────────────────────────────────────────┘
//
// This file is a MOUNT POINT ONLY and is deliberately dumb. Each pane is a
// props-free component that reads `useEditorStore` itself, so the inspector,
// layer-stack and toolbar tasks each edit exactly one file and never this one.
// Adding logic here re-couples panes that are meant to stay independent.
//
// `Shell` (`src/ui/shell/`) replaces the old static `<LayerStack />` column:
// it renders the collapsible left pivot rail plus a panel host that mounts
// whichever pivot (Layers/Assets/Nodes/Manifest/Critique) is active.
// `Inspector` stays an untouched sibling — this only changed what CONTAINS
// the panes, never their internals.
//
// `GraphCanvas` and `MainViewer` used to be mounted directly here (the latter
// as a full-width footer under everything — Phase 1's reserved placeholder
// for the real compiled preview, since previews must run the real compiled
// target program, `MainViewer` → `src/preview/renderer.ts`, not a fake
// stand-in drawn here). `MainContentRegion` now owns combining the two into
// one dockable column; both are still passed in as plain elements, so
// neither component's internals changed for this either.

import { registerStarterNodes } from '../nodes/definitions';
import { CodePanel } from './codepanel/CodePanel';
import { DocToolbar } from './DocToolbar';
import { GraphCanvas } from './graph/GraphCanvas';
import { Inspector } from './inspector/Inspector';
import { MainContentRegion } from './MainContentRegion';
import { NoticeToast } from './NoticeToast';
import { bridgeStoreErrors } from './notice';
import { Shell } from './shell/Shell';
import { MainViewer } from './viewer/MainViewer';

// Boot-time wiring, once per module load. `addNode` resolves types through the
// registry, so nothing can be created until the starter set is registered.
registerStarterNodes();
bridgeStoreErrors();

export function App() {
  return (
    <div className="sg-app">
      <DocToolbar />
      <main className="sg-body">
        <Shell />
        <MainContentRegion graph={<GraphCanvas />} viewer={<MainViewer />} />
        <Inspector />
      </main>
      <NoticeToast />
      <CodePanel />
    </div>
  );
}
