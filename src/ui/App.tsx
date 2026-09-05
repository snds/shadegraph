// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — application shell
// ───────────────────────────────────────────────────────────────────────────
//   ┌──────────────────────── DocToolbar ────────────────────────┐
//   ├─────────────┬───────────────────────────────┬──────────────┤
//   │ LayerStack  │        GraphCanvas             │  Inspector   │
//   │ (Photoshop) │  React Flow · typed sockets    │  params of   │
//   │             │  · reserved thumbnail area     │  selection   │
//   ├─────────────┴───────────────────────────────┴──────────────┤
//   │                    Main viewer (Phase 2)                    │
//   └─────────────────────────────────────────────────────────────┘
//
// This file is a MOUNT POINT ONLY and is deliberately dumb. Each pane is a
// props-free component that reads `useEditorStore` itself, so the inspector,
// layer-stack and toolbar tasks each edit exactly one file and never this one.
// Adding logic here re-couples panes that are meant to stay independent.
//
// The main viewer stays an empty reserved strip: Phase 1 ships no rendering,
// and a fake preview would misrepresent the tool's core promise (previews run
// the real target program).

import { registerStarterNodes } from '../nodes/definitions';
import { DocToolbar } from './DocToolbar';
import { GraphCanvas } from './graph/GraphCanvas';
import { Inspector } from './inspector/Inspector';
import { LayerStack } from './layers/LayerStack';
import { NoticeToast } from './NoticeToast';
import { bridgeStoreErrors } from './notice';

// Boot-time wiring, once per module load. `addNode` resolves types through the
// registry, so nothing can be created until the starter set is registered.
registerStarterNodes();
bridgeStoreErrors();

export function App() {
  return (
    <div className="sg-app">
      <DocToolbar />
      <main className="sg-body">
        <LayerStack />
        <GraphCanvas />
        <Inspector />
      </main>
      <footer className="sg-viewer" aria-label="Main viewer">
        <span>main viewer · Phase 2</span>
      </footer>
      <NoticeToast />
    </div>
  );
}
