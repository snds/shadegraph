// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Document (de)serialisation
// ───────────────────────────────────────────────────────────────────────────
// The document is the durable artifact, so JSON must round-trip losslessly:
// `deserialize(serialize(doc))` deep-equals `doc`. That means deserialize
// NORMALISES NOTHING — it validates shape and schema version, then hands back
// exactly what was parsed. Any defaulting would silently mutate a user's file.
// ═══════════════════════════════════════════════════════════════════════════

import { SCHEMA_VERSION, type ShaderDocument, type StackNode } from './document';
import { flattenLayers } from './layerTree';

/** Thrown when a JSON blob is not a document this build can open. */
export class DocumentParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentParseError';
  }
}

/** Document → JSON text. Pretty by default: saved graphs should diff well. */
export function serialize(doc: ShaderDocument, pretty = true): string {
  return JSON.stringify(doc, null, pretty ? 2 : 0);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(message: string): never {
  throw new DocumentParseError(message);
}

// ── Legacy migration ─────────────────────────────────────────────────────
// Documents saved before `LayerGroup` existed (Sep 2026) have `layerStack.
// layers` as a flat array of what are now-shaped `ShaderLayer`s, minus the
// `kind` discriminant field (it didn't exist yet). This is the one place that
// back-fills it — every OTHER file in the model layer, including
// `validateDocument` right below, assumes `kind` is already present, exactly
// like every other pre-Sep-2026 document field. Runs unconditionally, ahead
// of validation, so it is a no-op (byte-for-byte, since `kind` is already set)
// on any document saved by this build or later.
function migrateStackNode(node: unknown): unknown {
  if (!isObject(node)) return node;
  if (node.kind === 'group' && Array.isArray(node.children)) {
    return { ...node, children: node.children.map(migrateStackNode) };
  }
  if (node.kind === 'layer' || node.kind === 'group') return node;
  // No `kind` at all: the only shape a stack node could have before groups
  // existed is a leaf layer (a bare `children` array is impossible pre-groups,
  // but is handled defensively the same way a future format might).
  if (Array.isArray(node.children)) {
    return { ...node, kind: 'group', children: node.children.map(migrateStackNode) };
  }
  return { ...node, kind: 'layer' };
}

function migrateDocument(value: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(value.layerStack) || !Array.isArray(value.layerStack.layers)) return value;
  return {
    ...value,
    layerStack: { ...value.layerStack, layers: value.layerStack.layers.map(migrateStackNode) },
  };
}

/** Structural validation of one `StackNode` (`ShaderLayer` or `LayerGroup`),
 *  recursing into a group's `children`. */
function validateStackNode(node: unknown, path: string): void {
  if (!isObject(node)) fail(`${path} is not an object.`);
  if (typeof node.id !== 'string') fail(`${path} is missing a string "id".`);
  if (typeof node.name !== 'string') fail(`${path} is missing a string "name".`);

  if (node.kind === 'group') {
    if (!Array.isArray(node.children)) {
      fail(`${path} ("${node.name}") is missing a "children" array.`);
    }
    node.children.forEach((child: unknown, i: number) => validateStackNode(child, `${path} child ${i}`));
    return;
  }

  if (node.kind !== 'layer') fail(`${path} ("${node.name}") has unknown "kind" "${String(node.kind)}".`);
  if (!isObject(node.graph)) fail(`${path} ("${node.name}") is missing "graph".`);
  const graph = node.graph;
  if (!Array.isArray(graph.nodes)) fail(`${path} graph is missing a "nodes" array.`);
  if (!Array.isArray(graph.edges)) fail(`${path} graph is missing an "edges" array.`);
  if (typeof graph.outputNodeId !== 'string') {
    fail(`${path} graph is missing a string "outputNodeId".`);
  }
}

/** Structural validation of an already-parsed value. Exported so callers that
 *  already hold an object (drag-drop, adapters) can reuse the same gate.
 *  Runs `migrateDocument` first so pre-`LayerGroup` documents (missing the
 *  `kind` discriminant) validate against the current shape instead of being
 *  rejected outright — see `migrateDocument`'s own comment. */
export function validateDocument(value: unknown): ShaderDocument {
  if (!isObject(value)) fail('Not a ShadeGraph document: expected a JSON object.');
  const doc = migrateDocument(value);

  if (doc.schemaVersion !== SCHEMA_VERSION) {
    fail(
      `Unsupported schema version "${String(doc.schemaVersion)}" ` +
        `(this build reads "${SCHEMA_VERSION}").`,
    );
  }
  if (typeof doc.id !== 'string') fail('Document is missing a string "id".');
  if (typeof doc.name !== 'string') fail('Document is missing a string "name".');
  if (typeof doc.previewRig !== 'string') fail('Document is missing "previewRig".');
  if (!Array.isArray(doc.subGraphs)) fail('Document is missing a "subGraphs" array.');
  if (!Array.isArray(doc.blackboard)) fail('Document is missing a "blackboard" array.');

  if (!isObject(doc.meta)) fail('Document is missing "meta".');
  if (typeof doc.meta.created !== 'string' || typeof doc.meta.updated !== 'string') {
    fail('Document "meta" needs string "created" and "updated" timestamps.');
  }

  if (!isObject(doc.layerStack)) fail('Document is missing "layerStack".');
  const layers = doc.layerStack.layers;
  if (!Array.isArray(layers) || layers.length === 0) {
    fail('Document "layerStack.layers" must be a non-empty array.');
  }

  layers.forEach((layer: unknown, i: number) => validateStackNode(layer, `Layer ${i}`));
  if (flattenLayers(layers as unknown as StackNode[]).length === 0) {
    fail('Document "layerStack.layers" must contain at least one leaf layer.');
  }

  return doc as unknown as ShaderDocument;
}

/** JSON text → document. Throws `DocumentParseError` with a message fit to show
 *  a user; never returns a partially-valid document. */
export function deserialize(json: string): ShaderDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    fail(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateDocument(parsed);
}
