// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Mask-editing breadcrumb
// ───────────────────────────────────────────────────────────────────────────
// Rendered inside `GraphCanvas` (as a React Flow `Panel`) only while the
// canvas is showing a layer's mask graph instead of its main graph — see
// `EditingTarget` / `activeGraphKind` in `../store`. Purely presentational:
// props-only, no store access, so it stays trivially testable and reusable if
// Phase 3's subgraph work ever wants a similar "you are here" trail.
// ═══════════════════════════════════════════════════════════════════════════

import './graphBreadcrumb.css';

interface GraphBreadcrumbProps {
  /** The layer whose mask is being edited. */
  layerName: string;
  /** Jump back to `layerName`'s main graph. */
  onExit: () => void;
}

export function GraphBreadcrumb({ layerName, onExit }: GraphBreadcrumbProps) {
  return (
    <div className="sg-breadcrumb" role="navigation" aria-label="Graph editing location">
      <button
        type="button"
        className="sg-breadcrumb__crumb"
        onClick={onExit}
        title={`Back to ${layerName}'s main graph`}
      >
        {layerName}
      </button>
      <span className="sg-breadcrumb__sep" aria-hidden="true">
        →
      </span>
      <span className="sg-breadcrumb__current">Mask</span>
      <button type="button" className="sg-breadcrumb__back" onClick={onExit}>
        ← Back to layer
      </button>
    </div>
  );
}
