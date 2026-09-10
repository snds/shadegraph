import { describe, expect, it, vi } from 'vitest';

import { emptyDocument, type ShaderLayer, type ShaderNode } from '../../model/document';
import { emptyManifest, type ProjectManifest } from '../../model/projectManifest';
import { CHUNK_RAW_NODE_TYPE } from '../../nodes/definitions/chunk';
import type { RecognizedShaderObject } from '../../storage/recognition';
import { graphedChunkNames, graphThis, type GraphThisDeps } from './graphThis';

function fixtureObject(overrides: Partial<RecognizedShaderObject> = {}): RecognizedShaderObject {
  return {
    id: 'noise.glsl',
    name: 'noise.glsl',
    nodeId: 'noise.glsl',
    path: ['shaders', 'noise.glsl'],
    uniforms: ['uSeed'],
    requires: [],
    ...overrides,
  };
}

const SOURCE_TEXT = 'uniform float uSeed;\nvoid main() {}';

describe('graphedChunkNames', () => {
  it('is empty for a fresh document and manifest', () => {
    expect(graphedChunkNames(emptyDocument(), emptyManifest())).toEqual(new Set());
  });

  it('includes a chunk.raw node already in the active layer graph', () => {
    const doc = emptyDocument();
    (doc.layerStack.layers[0] as ShaderLayer).graph.nodes.push({
      id: 'chunk_1',
      type: CHUNK_RAW_NODE_TYPE,
      position: { x: 0, y: 0 },
      params: [],
      chunkSource: { name: 'GLSL_TERRAIN', text: '', requires: [] },
    });
    expect(graphedChunkNames(doc, emptyManifest())).toEqual(new Set(['GLSL_TERRAIN']));
  });

  it('includes a chunk.raw node in a layer mask graph', () => {
    const doc = emptyDocument();
    doc.layerStack.layers[0].maskGraph = {
      nodes: [
        { id: 'mask_out', type: 'output.mask', position: { x: 0, y: 0 }, params: [] },
        {
          id: 'chunk_2',
          type: CHUNK_RAW_NODE_TYPE,
          position: { x: 0, y: 0 },
          params: [],
          chunkSource: { name: 'GLSL_MASKY', text: '', requires: [] },
        },
      ],
      edges: [],
      outputNodeId: 'mask_out',
    };
    expect(graphedChunkNames(doc, emptyManifest())).toEqual(new Set(['GLSL_MASKY']));
  });

  it('includes a chunk.raw node inside a subgraph', () => {
    const doc = emptyDocument();
    doc.subGraphs.push({
      id: 'sub_1',
      name: 'Sub',
      inputs: [],
      outputs: [],
      graph: {
        nodes: [
          {
            id: 'chunk_3',
            type: CHUNK_RAW_NODE_TYPE,
            position: { x: 0, y: 0 },
            params: [],
            chunkSource: { name: 'GLSL_SUB', text: '', requires: [] },
          },
        ],
        edges: [],
        outputNodeId: 'chunk_3',
      },
    });
    expect(graphedChunkNames(doc, emptyManifest())).toEqual(new Set(['GLSL_SUB']));
  });

  it('includes manifest discovered objects that are "draft"/"saved", but not "discovered"', () => {
    const manifest: ProjectManifest = {
      ...emptyManifest(),
      discoveredObjects: [
        {
          id: 'a',
          folderId: 'f',
          path: [],
          name: 'DRAFT_ONE',
          metadata: { tags: [] },
          state: { status: 'draft', draft: emptyDocument() },
        },
        {
          id: 'b',
          folderId: 'f',
          path: [],
          name: 'SAVED_ONE',
          metadata: { tags: [] },
          state: { status: 'saved', documentPath: 'x.shadegraph.json' },
        },
        {
          id: 'c',
          folderId: 'f',
          path: [],
          name: 'NOT_YET',
          metadata: { tags: [] },
          state: { status: 'discovered' },
        },
      ],
    };
    expect(graphedChunkNames(emptyDocument(), manifest)).toEqual(new Set(['DRAFT_ONE', 'SAVED_ONE']));
  });
});

describe('graphThis', () => {
  /** A tiny stand-in for the two real stores `AssetBrowserPanel.tsx` wires
   *  in — `doc` is a plain mutable closure variable (not immutable-update
   *  discipline; this is a test double, not the real store) so
   *  `addPreparedNode` can make the node it just added visible to a later
   *  `getDocument()` call, exactly like the real `useEditorStore` does. */
  function makeDeps() {
    let doc = emptyDocument();
    const deps: GraphThisDeps = {
      getDocument: () => doc,
      getManifest: () => emptyManifest(),
      addPreparedNode: vi.fn((node) => {
        doc = {
          ...doc,
          layerStack: {
            ...doc.layerStack,
            layers: doc.layerStack.layers.map((layer, i) => {
              if (i !== 0) return layer;
              const base = layer as ShaderLayer;
              return { ...base, graph: { ...base.graph, nodes: [...base.graph.nodes, node] } };
            }),
          },
        };
        return node.id;
      }),
      ensureConnectedFolder: vi.fn(() => 'folder-1'),
      ensureDiscoveredObject: vi.fn(() => 'obj-1'),
      setDiscoveredObjectDraft: vi.fn(),
    };
    return { deps, getDoc: () => doc };
  }

  it('adds the node then records the discovered object as a draft of the post-add document', () => {
    const { deps, getDoc } = makeDeps();
    const object = fixtureObject();

    const result = graphThis(object, SOURCE_TEXT, 'My Assets', deps);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    expect(deps.addPreparedNode).toHaveBeenCalledTimes(1);
    expect(deps.ensureConnectedFolder).toHaveBeenCalledWith('My Assets');
    expect(deps.ensureDiscoveredObject).toHaveBeenCalledWith({
      folderId: 'folder-1',
      path: object.path,
      name: object.name,
    });
    // The draft handed to the manifest is the CURRENT document — the one
    // that already includes the just-added node, not a stale snapshot from
    // before `addPreparedNode` ran.
    expect(deps.setDiscoveredObjectDraft).toHaveBeenCalledWith('obj-1', getDoc());
    expect((getDoc().layerStack.layers[0] as ShaderLayer).graph.nodes.some((n) => n.id === result.nodeId)).toBe(true);
  });

  it('refuses on missing-requires WITHOUT touching the document or the manifest', () => {
    const { deps, getDoc } = makeDeps();
    const before = getDoc();
    const object = fixtureObject({ requires: ['GLSL_BASE'] });

    const result = graphThis(object, SOURCE_TEXT, 'My Assets', deps);

    expect(result).toEqual({ ok: false, reason: 'missing-requires', missing: ['GLSL_BASE'] });
    expect(deps.addPreparedNode).not.toHaveBeenCalled();
    expect(deps.ensureConnectedFolder).not.toHaveBeenCalled();
    expect(deps.ensureDiscoveredObject).not.toHaveBeenCalled();
    expect(deps.setDiscoveredObjectDraft).not.toHaveBeenCalled();
    expect(getDoc()).toBe(before);
  });

  it('proceeds when the required chunk is already graphed elsewhere in the document', () => {
    const { deps, getDoc } = makeDeps();
    (getDoc().layerStack.layers[0] as ShaderLayer).graph.nodes.push({
      id: 'chunk_base',
      type: CHUNK_RAW_NODE_TYPE,
      position: { x: 0, y: 0 },
      params: [],
      chunkSource: { name: 'GLSL_BASE', text: '', requires: [] },
    });
    const object = fixtureObject({ requires: ['GLSL_BASE'] });

    const result = graphThis(object, SOURCE_TEXT, 'My Assets', deps);

    expect(result.ok).toBe(true);
  });

  it('reuses a cached auto-graph node (params/chunkSource) instead of re-deriving one, but assigns a fresh id', () => {
    const { deps, getDoc } = makeDeps();
    const object = fixtureObject();
    const cachedNode: ShaderNode = {
      id: 'cached-id-should-never-be-reused',
      type: CHUNK_RAW_NODE_TYPE,
      title: object.name,
      position: { x: 0, y: 0 },
      params: [{ id: 'uSeed', label: 'uSeed', type: 'float', value: 0, ui: 'number' }],
      previewEnabled: false,
      chunkSource: { name: object.name, text: SOURCE_TEXT, requires: [] },
    };
    const getCachedAutoGraphNode = vi.fn(() => cachedNode);

    const result = graphThis(object, SOURCE_TEXT, 'My Assets', { ...deps, getCachedAutoGraphNode });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(getCachedAutoGraphNode).toHaveBeenCalledTimes(1);
    expect(result.nodeId).not.toBe(cachedNode.id); // never the cached node's own id
    const inserted = (getDoc().layerStack.layers[0] as ShaderLayer).graph.nodes.find((n) => n.id === result.nodeId);
    expect(inserted?.chunkSource).toBe(cachedNode.chunkSource); // same reference — verbatim reuse
    expect(inserted?.params).toBe(cachedNode.params);
  });

  it('a cache hit still refuses on missing-requires against the REAL document/manifest scope', () => {
    const { deps } = makeDeps();
    const object = fixtureObject({ requires: ['GLSL_BASE'] });
    const cachedNode: ShaderNode = {
      id: 'cached-id',
      type: CHUNK_RAW_NODE_TYPE,
      title: object.name,
      position: { x: 0, y: 0 },
      params: [],
      previewEnabled: false,
      chunkSource: { name: object.name, text: SOURCE_TEXT, requires: ['GLSL_BASE'] },
    };
    const getCachedAutoGraphNode = vi.fn(() => cachedNode);

    const result = graphThis(object, SOURCE_TEXT, 'My Assets', { ...deps, getCachedAutoGraphNode });

    expect(result).toEqual({ ok: false, reason: 'missing-requires', missing: ['GLSL_BASE'] });
    expect(deps.addPreparedNode).not.toHaveBeenCalled();
  });

  it('a cache miss (getCachedAutoGraphNode returns undefined) falls back to deriving fresh, exactly as before', () => {
    const { deps } = makeDeps();
    const object = fixtureObject();
    const getCachedAutoGraphNode = vi.fn(() => undefined);

    const result = graphThis(object, SOURCE_TEXT, 'My Assets', { ...deps, getCachedAutoGraphNode });

    expect(result.ok).toBe(true);
    expect(getCachedAutoGraphNode).toHaveBeenCalledTimes(1);
  });

  it('reports "no-active-graph" and never touches the manifest if addPreparedNode refuses', () => {
    const { deps } = makeDeps();
    deps.addPreparedNode = vi.fn(() => null);
    const object = fixtureObject();

    const result = graphThis(object, SOURCE_TEXT, 'My Assets', deps);

    expect(result).toEqual({ ok: false, reason: 'no-active-graph' });
    expect(deps.ensureConnectedFolder).not.toHaveBeenCalled();
    expect(deps.ensureDiscoveredObject).not.toHaveBeenCalled();
    expect(deps.setDiscoveredObjectDraft).not.toHaveBeenCalled();
  });
});
