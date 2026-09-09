import { describe, expect, it, vi } from 'vitest';

import type { EmitContext } from '../../compiler/backend';
import type { ShaderNode } from '../../model/document';
import { CHUNK_RAW_NODE_TYPE, chunkRaw } from './chunk';

function mockCtx(): EmitContext {
  return {
    target: 'glsl-es',
    temp: vi.fn((prefix = 't') => `${prefix}_0`),
    input: vi.fn(() => '0.0'),
    uniform: vi.fn((spec) => spec.name),
    emit: vi.fn(),
    diag: vi.fn(),
  };
}

function chunkNode(overrides: Partial<ShaderNode> = {}): ShaderNode {
  return {
    id: 'n1',
    type: CHUNK_RAW_NODE_TYPE,
    position: { x: 0, y: 0 },
    params: [],
    ...overrides,
  };
}

describe('chunk.raw node definition', () => {
  it('registers under type "chunk.raw" with no sockets', () => {
    expect(chunkRaw.type).toBe('chunk.raw');
    expect(chunkRaw.inputs).toEqual([]);
    expect(chunkRaw.outputs).toEqual([]);
  });

  it('emits the raw chunkSource text verbatim, byte-for-byte, and nothing else', () => {
    const rawText = [
      'uniform float uWarp;',
      'float sg_terrain(vec3 p) {',
      '  return sin(p.x * uWarp);',
      '}',
    ].join('\n');
    const node = chunkNode({ chunkSource: { name: 'GLSL_TERRAIN', text: rawText, requires: [] } });
    const ctx = mockCtx();

    const result = chunkRaw.emit['glsl-es']!(node, ctx);

    expect(ctx.emit).toHaveBeenCalledTimes(1);
    expect(ctx.emit).toHaveBeenCalledWith(rawText);
    expect(ctx.uniform).not.toHaveBeenCalled();
    expect(ctx.diag).not.toHaveBeenCalled();
    expect(result).toBe('');
  });

  it('raises a diagnostic and emits nothing when chunkSource is missing', () => {
    const node = chunkNode();
    const ctx = mockCtx();

    chunkRaw.emit['glsl-es']!(node, ctx);

    expect(ctx.emit).not.toHaveBeenCalled();
    expect(ctx.diag).toHaveBeenCalledTimes(1);
    expect((ctx.diag as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      level: 'error',
      nodeId: 'n1',
    });
  });
});
