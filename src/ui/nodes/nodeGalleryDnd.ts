// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Node gallery drag payload
// ───────────────────────────────────────────────────────────────────────────
// One shared constant so `NodeGallery.tsx` (drag source) and `GraphCanvas.tsx`
// (drop target) agree on the `DataTransfer` MIME key without either importing
// the other — native HTML5 drag-and-drop, not a React Flow / DnD library
// feature, so this is the only coupling between the two files.
// ═══════════════════════════════════════════════════════════════════════════

/** Payload is the dragged node's registry `type` string (e.g. "math.mix"). */
export const NODE_GALLERY_DND_MIME = 'application/x-shadegraph-node-type';
