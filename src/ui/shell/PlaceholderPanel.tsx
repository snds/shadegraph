// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — pivot placeholder content
// ───────────────────────────────────────────────────────────────────────────
// Stand-in `content` for a pivot rail entry whose real panel is a later
// task's job (currently: Nodes). Clearly labeled, never silently blank, so
// nobody mistakes "not built yet" for "broken".
// ═══════════════════════════════════════════════════════════════════════════

import { Icon } from './Icon';
import './shell.css';

export function PlaceholderPanel({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="sg-placeholder-panel">
      <Icon name="hourglass_top" className="sg-placeholder-panel__icon" />
      <p className="sg-placeholder-panel__label">{label}</p>
      <p className="sg-placeholder-panel__hint">{hint}</p>
    </div>
  );
}
