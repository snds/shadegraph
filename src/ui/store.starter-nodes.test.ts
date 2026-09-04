import { beforeEach, describe, expect, it } from 'vitest';

// Side-effect import: populates the `nodes` singleton with the Phase 1 set.
import { starterDefinitions } from '../nodes/definitions';
import { canConnect } from '../model/connect';
import { nodes } from '../nodes/registry';
import { activeGraph, useEditorStore } from './store';

// store.test.ts pins socket types in purpose-built fixtures. This file checks
// the other half: that the store and the REAL starter definitions actually
// compose. Socket ids are derived from the definitions, never hard-coded, so
// the node catalogue can evolve without breaking this test.
const store = () => useEditorStore.getState();
const graph = () => activeGraph(store().doc);

beforeEach(() => {
  store().newDocument('Starter');
});

describe('store × starter node definitions', () => {
  it('can instantiate every registered starter type', () => {
    for (const def of starterDefinitions) {
      expect(store().addNode(def.type, { x: 0, y: 0 })).not.toBeNull();
    }

    // +1 for the output node `emptyDocument()` seeds.
    expect(graph().nodes).toHaveLength(starterDefinitions.length + 1);
    expect(store().lastError).toBeNull();
  });

  it('accepts every type-compatible link the registry allows', () => {
    const noise = store().addNode('noise.fbm', { x: 0, y: 0 }) as string;
    const outputId = graph().outputNodeId;
    const source = nodes.get('noise.fbm')!.outputs[0];
    const sink = nodes
      .get('output.surface')!
      .inputs.find((s) => canConnect(source.type, s.type));
    expect(sink).toBeDefined();

    const verdict = store().connect(
      { node: noise, socket: source.id },
      { node: outputId, socket: sink!.id },
    );

    expect(verdict).toEqual({ ok: true });
    expect(graph().edges).toHaveLength(1);
  });

  it('refuses a link the registry types forbid', () => {
    const uv = store().addNode('input.uv', { x: 0, y: 0 }) as string;
    const outputId = graph().outputNodeId;
    const source = nodes.get('input.uv')!.outputs[0];
    const sink = nodes
      .get('output.surface')!
      .inputs.find((s) => !canConnect(source.type, s.type));
    expect(sink).toBeDefined();

    const verdict = store().connect(
      { node: uv, socket: source.id },
      { node: outputId, socket: sink!.id },
    );

    expect(verdict).toMatchObject({ ok: false, reason: 'type-mismatch' });
    expect(graph().edges).toEqual([]);
  });
});
