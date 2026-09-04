import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, emptyDocument } from './document';

// Toolchain smoke test: proves vitest resolves + runs TypeScript out of `src`.
// Deep model coverage (typed connection validation, JSON round-trip) belongs to
// the document-store task, not here.
describe('emptyDocument', () => {
  it('produces a valid, minimally populated document', () => {
    const doc = emptyDocument();

    expect(doc.schemaVersion).toBe(SCHEMA_VERSION);
    expect(doc.name).toBe('Untitled');
    expect(doc.id).not.toHaveLength(0);
    expect(doc.subGraphs).toEqual([]);
    expect(doc.blackboard).toEqual([]);
  });

  it('seeds one base layer whose graph points at a real output node', () => {
    const { layers } = emptyDocument().layerStack;

    expect(layers).toHaveLength(1);
    const [base] = layers;
    expect(base.name).toBe('Base');
    expect(base.enabled).toBe(true);

    const output = base.graph.nodes.find((n) => n.id === base.graph.outputNodeId);
    expect(output?.type).toBe('output.surface');
    expect(base.graph.edges).toEqual([]);
  });

  it('honours the name argument and gives each document a distinct id', () => {
    expect(emptyDocument('Rocky').name).toBe('Rocky');
    expect(emptyDocument().id).not.toBe(emptyDocument().id);
  });
});
