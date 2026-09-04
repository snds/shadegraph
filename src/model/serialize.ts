// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Document (de)serialisation
// ───────────────────────────────────────────────────────────────────────────
// The document is the durable artifact, so JSON must round-trip losslessly:
// `deserialize(serialize(doc))` deep-equals `doc`. That means deserialize
// NORMALISES NOTHING — it validates shape and schema version, then hands back
// exactly what was parsed. Any defaulting would silently mutate a user's file.
// ═══════════════════════════════════════════════════════════════════════════

import { SCHEMA_VERSION, type ShaderDocument } from './document';

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

/** Structural validation of an already-parsed value. Exported so callers that
 *  already hold an object (drag-drop, adapters) can reuse the same gate. */
export function validateDocument(value: unknown): ShaderDocument {
  if (!isObject(value)) fail('Not a ShadeGraph document: expected a JSON object.');

  if (value.schemaVersion !== SCHEMA_VERSION) {
    fail(
      `Unsupported schema version "${String(value.schemaVersion)}" ` +
        `(this build reads "${SCHEMA_VERSION}").`,
    );
  }
  if (typeof value.id !== 'string') fail('Document is missing a string "id".');
  if (typeof value.name !== 'string') fail('Document is missing a string "name".');
  if (typeof value.previewRig !== 'string') fail('Document is missing "previewRig".');
  if (!Array.isArray(value.subGraphs)) fail('Document is missing a "subGraphs" array.');
  if (!Array.isArray(value.blackboard)) fail('Document is missing a "blackboard" array.');

  if (!isObject(value.meta)) fail('Document is missing "meta".');
  if (typeof value.meta.created !== 'string' || typeof value.meta.updated !== 'string') {
    fail('Document "meta" needs string "created" and "updated" timestamps.');
  }

  if (!isObject(value.layerStack)) fail('Document is missing "layerStack".');
  const layers = value.layerStack.layers;
  if (!Array.isArray(layers) || layers.length === 0) {
    fail('Document "layerStack.layers" must be a non-empty array.');
  }

  layers.forEach((layer: unknown, i: number) => {
    if (!isObject(layer)) fail(`Layer ${i} is not an object.`);
    if (typeof layer.id !== 'string') fail(`Layer ${i} is missing a string "id".`);
    if (typeof layer.name !== 'string') fail(`Layer ${i} is missing a string "name".`);
    if (!isObject(layer.graph)) fail(`Layer ${i} ("${layer.name}") is missing "graph".`);
    const graph = layer.graph;
    if (!Array.isArray(graph.nodes)) fail(`Layer ${i} graph is missing a "nodes" array.`);
    if (!Array.isArray(graph.edges)) fail(`Layer ${i} graph is missing an "edges" array.`);
    if (typeof graph.outputNodeId !== 'string') {
      fail(`Layer ${i} graph is missing a string "outputNodeId".`);
    }
  });

  return value as unknown as ShaderDocument;
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
