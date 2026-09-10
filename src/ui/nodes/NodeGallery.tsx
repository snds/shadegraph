// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Nodes gallery (pivot rail item)
// ───────────────────────────────────────────────────────────────────────────
// Every registered node type (`src/nodes/registry.ts`), grouped by category
// via `galleryGroups.ts` (same order the right-click `AddNodePalette` uses).
// This REPLACES the old "+ Add node" toolbar button as the primary
// browse-and-add surface — right-click-on-canvas quick-add is untouched, see
// `GraphCanvas.tsx`.
//
// Two ways to add a node from here:
//   • Click  — adds to the active graph at a cascading flow-space position
//     (`galleryPlacement.ts`), since this panel lives outside the canvas'
//     `ReactFlowProvider` and has no pointer/viewport position to anchor on.
//   • Drag   — native HTML5 DnD onto the canvas, which drops it exactly under
//     the pointer (`GraphCanvas.tsx`'s `onDrop`, via `NODE_GALLERY_DND_MIME`).
//
// A static Material Symbol per category stands in for a thumbnail here —
// deliberately not a live render (no node is on any graph yet to render);
// once placed, the node gets the real per-node preview thumbnail like any
// other node on the canvas (`ShaderNodeCard.tsx`).
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';

import type { NodeDefinition } from '../../nodes/registry';
import { Icon } from '../shell/Icon';
import { useEditorStore } from '../store';
import { galleryAddPosition } from './galleryPlacement';
import { CATEGORY_LABEL, groupedNodeDefinitions } from './galleryGroups';
import { categoryIcon } from './nodeCategoryIcons';
import { NODE_GALLERY_DND_MIME } from './nodeGalleryDnd';
import { NodeInfoDialog } from './NodeInfoDialog';
import './nodeGallery.css';

export function NodeGallery() {
  const addNode = useEditorStore((s) => s.addNode);
  const selectNodes = useEditorStore((s) => s.selectNodes);

  // Not reactive to the document — the registry is fixed at import time, so
  // re-grouping on every store update would be pure waste.
  const groups = useMemo(() => groupedNodeDefinitions(), []);
  const [infoDef, setInfoDef] = useState<NodeDefinition | null>(null);
  const addCount = useRef(0);

  const handlePick = useCallback(
    (type: string) => {
      const position = galleryAddPosition(addCount.current);
      addCount.current += 1;
      const id = addNode(type, position);
      if (id) selectNodes([id]);
    },
    [addNode, selectNodes],
  );

  const handleDragStart = useCallback((event: DragEvent, type: string) => {
    event.dataTransfer.setData(NODE_GALLERY_DND_MIME, type);
    event.dataTransfer.effectAllowed = 'copy';
  }, []);

  return (
    <div className="sg-node-gallery" aria-label="Node gallery">
      <p className="sg-node-gallery__hint">Click or drag a node onto the graph to add it.</p>
      {groups.map(({ category, defs }) => (
        <section key={category} className="sg-node-gallery__group">
          <h4 className="sg-node-gallery__group-title">{CATEGORY_LABEL[category] ?? category}</h4>
          <div className="sg-node-gallery__grid">
            {defs.map((def) => (
              <div key={def.type} className="sg-node-gallery__card" title={def.guidance ?? def.description}>
                <button
                  type="button"
                  className="sg-node-gallery__item"
                  draggable
                  onDragStart={(e) => handleDragStart(e, def.type)}
                  onClick={() => handlePick(def.type)}
                >
                  <Icon name={categoryIcon(def.category)} className="sg-node-gallery__icon" />
                  <span className="sg-node-gallery__title">{def.title}</span>
                </button>
                <button
                  type="button"
                  className="sg-node-gallery__info"
                  aria-label={`About ${def.title}`}
                  title="More info"
                  onClick={() => setInfoDef(def)}
                >
                  <Icon name="info" title="More info" />
                </button>
              </div>
            ))}
          </div>
        </section>
      ))}
      {infoDef ? <NodeInfoDialog def={infoDef} onClose={() => setInfoDef(null)} /> : null}
    </div>
  );
}
