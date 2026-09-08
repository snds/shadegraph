// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Dive-in breadcrumb (masks + subgraphs)
// ───────────────────────────────────────────────────────────────────────────
// Rendered inside `GraphCanvas` (as a React Flow `Panel`) whenever the canvas
// is showing something other than the active layer's main graph — a layer's
// mask graph, or a subgraph's own graph — see `EditingTarget` /
// `activeGraphKind` in `../store`. One component for both (per the Phase 3
// sketch's decision: subgraphs reuse the mask task's graph-switching
// mechanism rather than building a parallel one) — `currentLabel` is the only
// thing that differs between them. Purely presentational: props-only, no
// store access, so it stays trivially testable.
// ═══════════════════════════════════════════════════════════════════════════

import './graphBreadcrumb.css';

interface GraphBreadcrumbProps {
  /** The graph you're diving back OUT to, e.g. a layer's name. */
  parentLabel: string;
  /** What the canvas is currently showing, e.g. "Mask" or "Subgraph: Foo". */
  currentLabel: string;
  /** Jump back to `parentLabel`'s graph. */
  onExit: () => void;
}

export function GraphBreadcrumb({ parentLabel, currentLabel, onExit }: GraphBreadcrumbProps) {
  return (
    <div className="sg-breadcrumb" role="navigation" aria-label="Graph editing location">
      <button type="button" className="sg-breadcrumb__crumb" onClick={onExit} title={`Back to ${parentLabel}`}>
        {parentLabel}
      </button>
      <span className="sg-breadcrumb__sep" aria-hidden="true">
        →
      </span>
      <span className="sg-breadcrumb__current">{currentLabel}</span>
      <button type="button" className="sg-breadcrumb__back" onClick={onExit}>
        ← Back
      </button>
    </div>
  );
}
