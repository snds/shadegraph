// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — application shell: pivot rail + panel host
// ───────────────────────────────────────────────────────────────────────────
// Replaces the old static "LayerStack always on screen" column in `App.tsx`
// with a pivot rail (`PivotRail.tsx`) plus a panel host that mounts whichever
// entry from `pivotItems.tsx` is active. Owns exactly two pieces of state:
// which pivot is active, and whether the rail is collapsed to icon-only.
//
// Props-free, one fragment of root elements — `App.tsx` renders `<Shell />`
// where `<LayerStack /><GraphCanvas /><Inspector />` used to sit directly,
// with `GraphCanvas`/`Inspector` staying siblings of `Shell` (their internals
// are out of this task's scope; only what CONTAINS them changed).
//
// Only the ACTIVE pivot's content is mounted at all — never all five kept
// alive off-screen — the same "dirty + visible only" discipline the preview
// renderer already uses elsewhere in this codebase.
// ═══════════════════════════════════════════════════════════════════════════

import { useState } from 'react';

import { PivotRail } from './PivotRail';
import { pivotItems } from './pivotItems';
import './shell.css';

export function Shell() {
  const [activeId, setActiveId] = useState(pivotItems[0]!.id);
  const [collapsed, setCollapsed] = useState(false);

  const active = pivotItems.find((item) => item.id === activeId) ?? pivotItems[0]!;
  const ActiveContent = active.content;

  return (
    <>
      <PivotRail
        items={pivotItems}
        activeId={activeId}
        onSelect={setActiveId}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((v) => !v)}
      />
      <section className="sg-panel-host" aria-label={`${active.label} panel`}>
        <ActiveContent />
      </section>
    </>
  );
}
