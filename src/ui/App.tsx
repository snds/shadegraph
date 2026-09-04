// ShadeGraph — application shell.
//
// Layout (see docs/DESIGN-PLAN.md → "UI surfaces"):
//
//   ┌─────────────┬───────────────────────────────┬──────────────┐
//   │ Layer Stack │        Node Graph (canvas)     │  Inspector   │
//   │ (Photoshop) │  React Flow · typed sockets ·  │  params of   │
//   │ add/remove  │  per-node live thumbnails      │  selection + │
//   │ blend/opac  │                                │  blackboard  │
//   │ eye/solo    ├───────────────────────────────┤              │
//   │ reorder     │        Main Viewer             │  Backend:    │
//   │             │  composite · solo node/layer   │  glsl / wgsl │
//   └─────────────┴───────────────────────────────┴──────────────┘
//
// This file is the scaffold seam: it wires the panes to the store + preview
// scheduler. Panes below are placeholders until Phase 2 (see the plan).

export function App() {
  return (
    <div className="sg-app">
      <header className="sg-topbar">
        <span className="sg-logo">ShadeGraph</span>
        <span className="sg-hint">scaffold — see 07-projects/21-shadegraph/docs/DESIGN-PLAN.md</span>
      </header>
      <main className="sg-body">
        <aside className="sg-layers" aria-label="Layer stack">Layer Stack</aside>
        <section className="sg-graph" aria-label="Node graph">Node Graph</section>
        <aside className="sg-inspector" aria-label="Inspector">Inspector</aside>
      </main>
      <footer className="sg-viewer" aria-label="Main viewer">Main Viewer</footer>
    </div>
  );
}
