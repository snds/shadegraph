// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset browser: "graph this" action
// ───────────────────────────────────────────────────────────────────────────
// The pure orchestration behind `AssetBrowserPanel`'s "graph this" button,
// split out of the component the same way `useVirtualRows.ts`/`virtualRange.ts`
// are: this module never touches React or a zustand store directly, so it's
// unit-testable with plain function arguments — matching this task's own
// call list verbatim (`graphFromRecognizedObject` + the manifest store's
// `discoveredObjects` + `src/ui/store.ts`'s document-mutation action).
// `AssetBrowserPanel.tsx` is the only place that wires the real
// `useEditorStore`/`useManifestStore`/`useAssetStore` getters into this.
// ═══════════════════════════════════════════════════════════════════════════

import type { ShaderDocument, ShaderGraph, ShaderNode } from '../../model/document';
import { makeNodeId } from '../../model/ids';
import { allStackNodes } from '../../model/layerTree';
import type { ProjectManifest } from '../../model/projectManifest';
import { CHUNK_RAW_NODE_TYPE } from '../../nodes/definitions/chunk';
import { graphFromRecognizedObject, type RecognizedShaderObject } from '../../storage/recognition';

/** Every `ShaderGraph` embedded anywhere in `doc` — every layer's main graph,
 *  every layer's OR group's mask graph, and every subgraph's own graph. */
function allGraphs(doc: ShaderDocument): ShaderGraph[] {
  const graphs: ShaderGraph[] = [];
  for (const node of allStackNodes(doc.layerStack.layers)) {
    if (node.kind === 'layer') graphs.push(node.graph);
    if (node.maskGraph) graphs.push(node.maskGraph);
  }
  for (const subGraph of doc.subGraphs) graphs.push(subGraph.graph);
  return graphs;
}

/** Names (`chunkSource.name`) of every `chunk.raw` node already graphed
 *  ANYWHERE in `doc` (not just the graph currently being edited), unioned
 *  with every manifest `DiscoveredObject` whose state is `'draft'` or
 *  `'saved'` — exactly the set `graphFromRecognizedObject`'s own
 *  `graphedChunkNames` option doc comment describes as its expected input. */
export function graphedChunkNames(doc: ShaderDocument, manifest: ProjectManifest): Set<string> {
  const names = new Set<string>();
  for (const graph of allGraphs(doc)) {
    for (const node of graph.nodes) {
      if (node.chunkSource) names.add(node.chunkSource.name);
    }
  }
  for (const object of manifest.discoveredObjects) {
    if (object.state.status === 'draft' || object.state.status === 'saved') names.add(object.name);
  }
  return names;
}

export type GraphThisResult =
  | { ok: true; nodeId: string; discoveredObjectId: string }
  | { ok: false; reason: 'missing-requires'; missing: string[] }
  | { ok: false; reason: 'no-active-graph' };

/** The store actions this action needs, injected rather than imported
 *  directly — real callers pass bound `useEditorStore`/`useManifestStore`
 *  methods; a test passes small stand-ins instead of faking two whole
 *  zustand stores. */
export interface GraphThisDeps {
  /** Reads the CURRENT document. Called again after `addPreparedNode`, since
   *  the draft handed to the manifest must include the just-added node. */
  getDocument: () => ShaderDocument;
  getManifest: () => ProjectManifest;
  addPreparedNode: (node: ShaderNode) => string | null;
  ensureConnectedFolder: (name: string) => string;
  ensureDiscoveredObject: (input: { folderId: string; path: string[]; name: string }) => string;
  setDiscoveredObjectDraft: (objectId: string, draft: ShaderDocument) => void;
}

/** Turns ONE recognized shader object into a graphed `chunk.raw` node in the
 *  document currently being edited, then records that in the project
 *  manifest as a `draft` — the full "graph this" action. Always exactly one
 *  object per call; there is deliberately no variant that takes a list (see
 *  this task's "no bulk graph-all affordance" requirement) — a caller with
 *  several recognized objects calls this once per object, by the user's own
 *  explicit choice each time. */
export function graphThis(
  object: RecognizedShaderObject,
  sourceText: string,
  connectedFolderName: string,
  deps: GraphThisDeps,
): GraphThisResult {
  const graphed = graphedChunkNames(deps.getDocument(), deps.getManifest());
  const result = graphFromRecognizedObject(object, sourceText, {
    graphedChunkNames: graphed,
    makeId: () => makeNodeId(CHUNK_RAW_NODE_TYPE),
  });
  if (!result.ok) return result;

  const nodeId = deps.addPreparedNode(result.node);
  if (!nodeId) return { ok: false, reason: 'no-active-graph' };

  const folderId = deps.ensureConnectedFolder(connectedFolderName);
  const discoveredObjectId = deps.ensureDiscoveredObject({
    folderId,
    path: object.path,
    name: object.name,
  });
  // Read fresh: `deps.getDocument()` now includes the node `addPreparedNode`
  // just inserted, which is exactly what a "draft" should embed.
  deps.setDiscoveredObjectDraft(discoveredObjectId, deps.getDocument());

  return { ok: true, nodeId, discoveredObjectId };
}
