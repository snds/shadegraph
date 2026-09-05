// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Node card
// ───────────────────────────────────────────────────────────────────────────
// One React Flow node type renders every shader node. Sockets are read live
// from the registry definition (never copied into the document or the view
// data), so adding a node type is still a one-file change.
//
// The `preview` block is a RESERVED, EMPTY area. Phase 2 mounts the shared GPU
// renderer's per-node thumbnail into it. It deliberately draws nothing shader-
// like now, so no one mistakes a placeholder for a render.
// ═══════════════════════════════════════════════════════════════════════════

import { Handle, Position, type NodeProps } from '@xyflow/react';

import type { Socket } from '../../model/document';
import { nodes } from '../../nodes/registry';
import type { ShaderFlowNode } from './project';
import { socketColor } from './socketStyle';

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

export function ShaderNodeCard({ data, selected }: NodeProps<ShaderFlowNode>) {
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

      {def.previewable ? (
        <div className="sg-node__preview" aria-hidden="true">
          <span>preview · Phase&nbsp;2</span>
        </div>
      ) : null}

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
