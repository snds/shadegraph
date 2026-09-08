// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Group / frame node
// ───────────────────────────────────────────────────────────────────────────
// The React Flow custom node type for a `NodeGroup` (see `project.ts`'s
// `GROUP_NODE_TYPE`). Purely organisational — this is a box drawn around a
// selection, never a `ShaderNode` — so it talks to the store directly for
// rename/recolor/delete (same pattern `ShaderNodeCard` uses for its preview),
// and its position/size ARE the `NodeGroup.bounds`, kept in sync by
// `GraphCanvas`'s `onNodesChange` via `setGroupBounds` whenever this node is
// dragged or resized (`<NodeResizer>` below reports resizes through the very
// same `onNodesChange` channel node drags use).
//
// Interactive controls (title input, color swatch, delete button) carry the
// `nodrag`/`nopan` classes so clicking them edits the group instead of
// starting a canvas drag/pan.
// ═══════════════════════════════════════════════════════════════════════════

import { Fragment, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';

import { useEditorStore } from '../store';
import type { GroupFlowNode } from './project';
import './groupFrame.css';

/** Fallback frame tint when the group has no explicit color. */
const DEFAULT_COLOR = '#4ea1ff';

export function GroupFrameNode({ data, selected }: NodeProps<GroupFlowNode>) {
  const { groupId, title, color } = data;
  const renameGroup = useEditorStore((s) => s.renameGroup);
  const recolorGroup = useEditorStore((s) => s.recolorGroup);
  const removeGroup = useEditorStore((s) => s.removeGroup);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const tint = color ?? DEFAULT_COLOR;

  function startEditing() {
    setDraft(title);
    setEditing(true);
  }

  function commitTitle() {
    setEditing(false);
    renameGroup(groupId, draft);
  }

  function onTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') event.currentTarget.blur();
    else if (event.key === 'Escape') {
      setDraft(title);
      setEditing(false);
    }
  }

  function onColorChange(event: ChangeEvent<HTMLInputElement>) {
    recolorGroup(groupId, event.target.value);
  }

  return (
    <Fragment>
      {/* Rendered OUTSIDE `.sg-frame` (below), which is `pointer-events: none`
       *  so clicks pass through its empty interior to whatever member node
       *  sits underneath — a descendant with no explicit `pointer-events`
       *  of its own (the resize handles/lines) would otherwise inherit that
       *  `none` and become inert. */}
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        minHeight={100}
        color={tint}
        handleClassName="nodrag"
        lineClassName="nodrag"
      />
      <div
        className="sg-frame"
        data-selected={selected || undefined}
        style={{ borderColor: tint, background: `${tint}14` }}
      >
        <header className="sg-frame__head" style={{ borderColor: tint }}>
          {editing ? (
            <input
              className="sg-frame__title-input nodrag"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={onTitleKeyDown}
            />
          ) : (
            <span className="sg-frame__title nodrag" onDoubleClick={startEditing} title="Double-click to rename">
              {title}
            </span>
          )}
          <input
            type="color"
            className="sg-frame__swatch nodrag"
            value={tint}
            onChange={onColorChange}
            title="Frame color"
          />
          <button
            type="button"
            className="sg-frame__delete nodrag"
            onClick={() => removeGroup(groupId)}
            title="Ungroup (nodes are kept)"
            aria-label="Delete group"
          >
            ×
          </button>
        </header>
      </div>
    </Fragment>
  );
}
