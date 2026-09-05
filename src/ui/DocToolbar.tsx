// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Document toolbar  ·  PLACEHOLDER
// ───────────────────────────────────────────────────────────────────────────
// Owned by the "Save / load JSON + document toolbar" task. Fill THIS file in;
// `App.tsx` already mounts it and must not be edited.
//
// Contract (do not change, or App.tsx breaks):
//   • props-free — read everything from `useEditorStore` directly
//   • renders exactly one root element: the whole <header className="sg-topbar">
//   • named export `DocToolbar`
//
// To do here: new / save-to-JSON / load-from-JSON via `serialize.ts`, using the
// store's `loadDocument` and `newDocument`.
// ═══════════════════════════════════════════════════════════════════════════

import { useEditorStore } from './store';

export function DocToolbar() {
  const name = useEditorStore((s) => s.doc.name);
  const rig = useEditorStore((s) => s.doc.previewRig);

  return (
    <header className="sg-topbar">
      <span className="sg-logo">ShadeGraph</span>
      <span className="sg-doc">{name}</span>
      <span className="sg-hint">rig: {rig}</span>
      <span className="sg-hint sg-hint--pending">save / load — pending</span>
    </header>
  );
}
