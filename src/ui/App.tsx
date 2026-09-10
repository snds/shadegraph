// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — application shell
// ───────────────────────────────────────────────────────────────────────────
//   ┌──────────────────────── DocToolbar ────────────────────────┐
//   ├──────┬─────────────┬───────────────────────────┬───────────┤
//   │ Rail │ Panel host  │        GraphCanvas         │ Inspector │
//   │ (Layers/Assets/    │  React Flow · typed sockets│ params of │
//   │  Nodes/Manifest/   │  · reserved thumbnail area │ selection │
//   │  Critique pivots)  │                             │           │
//   ├──────┴─────────────┴───────────────────────────┴───────────┤
//   │                    Main viewer (Phase 2)                    │
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
// `GraphCanvas`/`Inspector` stay untouched siblings — this only changed what
// CONTAINS them, never their internals.
//
// The main viewer (Phase 2) is the one exception to "never touch this file":
// Phase 1 deliberately reserved the footer as an empty placeholder for
// exactly this, since previews must run the real compiled target program
// (`MainViewer` → `src/preview/renderer.ts`), not a fake stand-in drawn here.

import { registerStarterNodes } from '../nodes/definitions';
import { CodePanel } from './codepanel/CodePanel';
import { DocToolbar } from './DocToolbar';
import { GraphCanvas } from './graph/GraphCanvas';
import { Inspector } from './inspector/Inspector';
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
        <GraphCanvas />
        <Inspector />
      </main>
      <MainViewer />
      <NoticeToast />
      <CodePanel />
    </div>
  );
}
