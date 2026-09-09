import { describe, expect, it } from 'vitest';

import { SOCKET_COMPATIBILITY, type SocketType } from '../../model/document';
import { NodeRegistry, nodes, type NodeDefinition } from '../registry';
import { registerStarterNodes, starterDefinitions } from './index';

/** Authoritative list of socket types, derived from the model's own table. */
const SOCKET_TYPES = Object.keys(SOCKET_COMPATIBILITY) as SocketType[];
const isSocketType = (t: string): t is SocketType => (SOCKET_TYPES as string[]).includes(t);

/** Editor-side connection rule (mirrors `SOCKET_COMPATIBILITY`'s direction:
 *  the *target* input declares which source types it accepts). */
const canConnect = (source: SocketType, target: SocketType): boolean =>
  SOCKET_COMPATIBILITY[target].includes(source);

const EXPECTED_TYPES = [
  'input.uv',
  'input.time',
  'math.add',
  'math.mul',
  'math.mix',
  'noise.fbm',
  'color.ramp',
  'output.surface',
  'output.mask',
  'chunk.raw',
];

const fresh = () => registerStarterNodes(new NodeRegistry());

describe('starter node registration', () => {
  it('registers all 10 starter definitions', () => {
    const registry = fresh();
    expect(registry.all()).toHaveLength(10);
    expect(registry.all().map((d) => d.type).sort()).toEqual([...EXPECTED_TYPES].sort());
  });

  it('populates the shared `nodes` singleton on import', () => {
    for (const type of EXPECTED_TYPES) {
      expect(nodes.get(type), `singleton missing "${type}"`).toBeDefined();
    }
  });

  it('is idempotent — re-registering does not throw or duplicate', () => {
    const registry = fresh();
    expect(() => registerStarterNodes(registry)).not.toThrow();
    expect(registry.all()).toHaveLength(10);
  });

  it('groups definitions by category', () => {
    const byCategory = fresh().byCategory();
    expect(byCategory.input.map((d) => d.type)).toEqual(['input.uv', 'input.time']);
    expect(byCategory.math.map((d) => d.type)).toEqual(['math.add', 'math.mul', 'math.mix']);
    expect(byCategory.noise.map((d) => d.type)).toEqual(['noise.fbm']);
    expect(byCategory.color.map((d) => d.type)).toEqual(['color.ramp']);
    expect(byCategory.output.map((d) => d.type)).toEqual(['output.surface', 'output.mask']);
    expect(byCategory.imported.map((d) => d.type)).toEqual(['chunk.raw']);
  });

  it('has no duplicate node types', () => {
    const types = starterDefinitions.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
  });
});

describe('definition invariants', () => {
  it.each(starterDefinitions.map((d) => [d.type, d] as [string, NodeDefinition]))(
    '%s — socket ids are unique within the node',
    (_type, def) => {
      const ids = [...def.inputs, ...def.outputs].map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  it.each(starterDefinitions.map((d) => [d.type, d] as [string, NodeDefinition]))(
    '%s — every socket declares a valid SocketType',
    (_type, def) => {
      for (const socket of [...def.inputs, ...def.outputs]) {
        expect(isSocketType(socket.type), `${socket.id}: "${socket.type}"`).toBe(true);
      }
    },
  );

  it.each(starterDefinitions.map((d) => [d.type, d] as [string, NodeDefinition]))(
    '%s — every param declares a valid SocketType and unique id',
    (_type, def) => {
      const params = def.params ?? [];
      const ids = params.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const p of params) {
        expect(isSocketType(p.type), `${p.id}: "${p.type}"`).toBe(true);
      }
    },
  );

  it.each(starterDefinitions.map((d) => [d.type, d] as [string, NodeDefinition]))(
    '%s — slider params declare a min/max range',
    (_type, def) => {
      for (const p of def.params ?? []) {
        if (p.ui !== 'slider') continue;
        expect(typeof p.min, `${p.id} min`).toBe('number');
        expect(typeof p.max, `${p.id} max`).toBe('number');
        expect(p.max!).toBeGreaterThan(p.min!);
      }
    },
  );

  it.each(starterDefinitions.map((d) => [d.type, d] as [string, NodeDefinition]))(
    '%s — bypass references real, type-compatible sockets',
    (_type, def) => {
      if (!def.bypass) return;
      const input = def.inputs.find((s) => s.id === def.bypass!.input);
      const output = def.outputs.find((s) => s.id === def.bypass!.output);
      expect(input, `bypass input "${def.bypass.input}"`).toBeDefined();
      expect(output, `bypass output "${def.bypass.output}"`).toBeDefined();
      expect(canConnect(input!.type, output!.type)).toBe(true);
    },
  );

  it.each(starterDefinitions.map((d) => [d.type, d] as [string, NodeDefinition]))(
    '%s — supplies a glsl-es emitter',
    (_type, def) => {
      expect(typeof def.emit['glsl-es']).toBe('function');
    },
  );

  it('only the output nodes and chunk.raw are terminal (no output sockets)', () => {
    // `chunk.raw` is terminal too, for a different reason than the output
    // nodes: it is a coarse passthrough of a bundled multi-function utility
    // library, not a single expression a socket could carry — see
    // `src/nodes/definitions/chunk.ts`'s header comment.
    const terminal = starterDefinitions.filter((d) => d.outputs.length === 0);
    expect(terminal.map((d) => d.type)).toEqual(['output.surface', 'output.mask', 'chunk.raw']);
  });
});

describe('socket typing rejects illegal links', () => {
  const socketType = (type: string, direction: 'in' | 'out', id: string): SocketType => {
    const def = starterDefinitions.find((d) => d.type === type)!;
    const socket = (direction === 'in' ? def.inputs : def.outputs).find((s) => s.id === id)!;
    return socket.type;
  };

  it('refuses input.uv (vec2) → math.mix.t (float)', () => {
    const source = socketType('input.uv', 'out', 'uv');
    const target = socketType('math.mix', 'in', 't');
    expect(source).toBe('vec2');
    expect(target).toBe('float');
    expect(canConnect(source, target)).toBe(false);
  });

  it('refuses input.uv (vec2) → output.surface.baseColor (color)', () => {
    expect(
      canConnect(socketType('input.uv', 'out', 'uv'), socketType('output.surface', 'in', 'baseColor')),
    ).toBe(false);
  });

  it('allows the intended starter chain uv → fbm → ramp → mix → surface', () => {
    expect(canConnect(socketType('input.uv', 'out', 'uv'), socketType('noise.fbm', 'in', 'uv'))).toBe(
      true,
    );
    expect(
      canConnect(socketType('noise.fbm', 'out', 'value'), socketType('color.ramp', 'in', 't')),
    ).toBe(true);
    expect(canConnect(socketType('color.ramp', 'out', 'color'), socketType('math.mix', 'in', 'a'))).toBe(
      true,
    );
    expect(
      canConnect(socketType('math.mix', 'out', 'result'), socketType('output.surface', 'in', 'baseColor')),
    ).toBe(true);
  });

  it('allows input.time (float) → math.mul.a (float)', () => {
    expect(canConnect(socketType('input.time', 'out', 'time'), socketType('math.mul', 'in', 'a'))).toBe(
      true,
    );
  });
});
