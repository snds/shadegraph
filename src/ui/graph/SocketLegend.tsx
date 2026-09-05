// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Socket colour legend
// ───────────────────────────────────────────────────────────────────────────
// Handle colours only communicate if the mapping is discoverable. Collapsed by
// default so it never competes with the graph.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';

import { SOCKET_LEGEND, socketColor } from './socketStyle';

export function SocketLegend() {
  const [open, setOpen] = useState(false);
  return (
    <div className="sg-legend" data-open={open}>
      <button type="button" className="sg-legend__toggle" onClick={() => setOpen((o) => !o)}>
        {open ? '×' : '?'} socket types
      </button>
      {open ? (
        <ul className="sg-legend__list">
          {SOCKET_LEGEND.map((type) => (
            <li key={type}>
              <i style={{ background: socketColor(type) }} />
              {type}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
