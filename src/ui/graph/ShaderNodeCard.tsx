// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Node card
// ───────────────────────────────────────────────────────────────────────────
// One React Flow node type renders every shader node. Sockets are read live
// from the registry definition (never copied into the document or the view
// data), so adding a node type is still a one-file change.
//
// The `preview` block is a live `<canvas>` fed by the ONE shared preview
// renderer (`src/preview/renderer.ts` + `thumbnails.ts`) via
// `store.previewRenderer` — the exact same compiler + GPU context the main
// viewer uses, never a second rendering path. `useThumbnail` below reports
// this card's mount/visibility to the renderer (`setVisibleNodes`) and polls
// `requestThumbnail`, which is cheap/no-op unless this node's own thumbnail is
// actually dirty.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

import type { Socket } from '../../model/document';
import { nodes } from '../../nodes/registry';
import type { PreviewScheduler } from '../../preview/scheduler';
import { useEditorStore } from '../store';
import type { ShaderFlowNode } from './project';
import { socketColor } from './socketStyle';

const THUMBNAIL_SIZE = 96;
/** How often a mounted, visible card polls for a fresh frame. Cheap when the
 *  node isn't dirty (the scheduler resolves immediately from cache), so this
 *  is just a "how quickly does a live edit visibly update" knob, not a
 *  render-cost knob — `setVisibleNodes` + dirty tracking are what actually
 *  gate GPU work. */
const POLL_INTERVAL_MS = 120;

/** Every currently-mounted, previewable node card, so `setVisibleNodes` always
 *  reflects the full set of on-screen thumbnails rather than just the one
 *  card that most recently mounted/unmounted. React Flow's
 *  `onlyRenderVisibleElements` (see `GraphCanvas.tsx`) is what makes
 *  mount/unmount here track actual viewport visibility. */
const visibleNodeIds = new Set<string>();

function useThumbnail(nodeId: string, enabled: boolean): HTMLCanvasElement | null {
  const renderer = useEditorStore((s) => s.previewRenderer);
  const [frame, setFrame] = useState<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!enabled || !renderer) return;

    visibleNodeIds.add(nodeId);
    renderer.setVisibleNodes([...visibleNodeIds]);

    let cancelled = false;
    let rafHandle = 0;
    let lastPoll = 0;

    function poll(ts: number): void {
      if (ts - lastPoll >= POLL_INTERVAL_MS) {
        lastPoll = ts;
        pollNow(renderer as PreviewScheduler);
      }
      rafHandle = requestAnimationFrame(poll);
    }

    function pollNow(scheduler: PreviewScheduler): void {
      scheduler
        .requestThumbnail({ nodeId, size: THUMBNAIL_SIZE, priority: 'visible' })
        .then((result) => {
          if (!cancelled && result instanceof HTMLCanvasElement) setFrame(result);
        })
        .catch(() => {
          // A transient compile error (e.g. mid-edit cycle) — keep showing
          // the last good frame rather than clearing it.
        });
    }

    rafHandle = requestAnimationFrame(poll);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafHandle);
      visibleNodeIds.delete(nodeId);
      renderer.setVisibleNodes([...visibleNodeIds]);
    };
  }, [nodeId, enabled, renderer]);

  return frame;
}

function NodeThumbnail({ nodeId }: { nodeId: string }) {
  const frame = useThumbnail(nodeId, true);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
  }, [frame]);

  return (
    <div className="sg-node__preview" aria-hidden="true">
      <canvas ref={canvasRef} width={THUMBNAIL_SIZE} height={THUMBNAIL_SIZE} className="sg-node__preview-canvas" />
    </div>
  );
}

type SocketSpec = Omit<Socket, 'direction'>;

function SocketRow({ socket, direction }: { socket: SocketSpec; direction: 'in' | 'out' }) {
  const color = socketColor(socket.type);
  return (
    <div className={`sg-socket sg-socket--${direction}`}>
      <Handle
        type={direction === 'in' ? 'target' : 'source'}
        position={direction === 'in' ? Position.Left : Position.Right}
        id={socket.id}
        className="sg-handle"
        style={{ background: color }}
      />
      <span className="sg-socket__label">{socket.label}</span>
      <span className="sg-socket__type" style={{ color }}>
        {socket.type}
      </span>
    </div>
  );
}

export function ShaderNodeCard({ id, data, selected }: NodeProps<ShaderFlowNode>) {
  const def = nodes.get(data.shaderType);

  if (!def) {
    return (
      <div className="sg-node sg-node--unknown" data-selected={selected || undefined}>
        <header className="sg-node__head">
          <span className="sg-node__title">Unknown node</span>
        </header>
        <div className="sg-node__body">
          <code>{data.shaderType}</code> is not in the registry.
        </div>
      </div>
    );
  }

  return (
    <div
      className={`sg-node sg-node--${def.category}`}
      data-selected={selected || undefined}
      data-bypassed={data.bypassed || undefined}
      title={def.description}
    >
      <header className="sg-node__head">
        <span className="sg-node__title">{data.title ?? def.title}</span>
        <span className="sg-node__cat">{def.category}</span>
      </header>

      {def.previewable ? <NodeThumbnail nodeId={id} /> : null}

      <div className="sg-node__sockets">
        {def.outputs.length > 0 ? (
          <div className="sg-node__group sg-node__group--out">
            {def.outputs.map((s) => (
              <SocketRow key={`out:${s.id}`} socket={s} direction="out" />
            ))}
          </div>
        ) : null}
        {def.inputs.length > 0 ? (
          <div className="sg-node__group sg-node__group--in">
            {def.inputs.map((s) => (
              <SocketRow key={`in:${s.id}`} socket={s} direction="in" />
            ))}
          </div>
        ) : null}
      </div>

      {data.isOutput ? <footer className="sg-node__pin">graph output</footer> : null}
    </div>
  );
}
