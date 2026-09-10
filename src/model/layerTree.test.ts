import { describe, expect, it } from 'vitest';

import type { LayerGroup, ShaderGraph, ShaderLayer, StackNode } from './document';
import {
  allStackNodes,
  findLayer,
  findLayerOwningNode,
  findSiblingArray,
  findStackNode,
  firstLayerId,
  flattenLayers,
  isGroupNode,
  isLayerNode,
  mapLeafLayers,
  replaceSiblingArray,
  updateStackNode,
} from './layerTree';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function graph(nodeIds: string[] = []): ShaderGraph {
  return {
    nodes: nodeIds.map((id) => ({ id, type: 'math.add', position: { x: 0, y: 0 }, params: [] })),
    edges: [],
    outputNodeId: nodeIds[0] ?? 'out',
  };
}

function layer(id: string, nodeIds: string[] = []): ShaderLayer {
  return {
    kind: 'layer',
    id,
    name: id,
    graph: graph(nodeIds),
    blend: 'normal',
    opacity: 1,
    enabled: true,
    visible: true,
  };
}

function group(id: string, children: StackNode[], overrides: Partial<LayerGroup> = {}): LayerGroup {
  return {
    kind: 'group',
    id,
    name: id,
    blend: 'normal',
    opacity: 1,
    enabled: true,
    visible: true,
    children,
    ...overrides,
  };
}

/** A two-level tree: [A, Group1(B, Group2(C, D))] — `B`/`C`/`D` at
 *  increasing nesting depth so tests can distinguish "found at root" from
 *  "found nested". */
function nestedTree(): StackNode[] {
  return [
    layer('A', ['a1']),
    group('grp1', [layer('B', ['b1']), group('grp2', [layer('C', ['c1']), layer('D', ['d1'])])]),
  ];
}

describe('isLayerNode / isGroupNode', () => {
  it('discriminates by kind', () => {
    const l = layer('x');
    const g = group('y', []);
    expect(isLayerNode(l)).toBe(true);
    expect(isLayerNode(g)).toBe(false);
    expect(isGroupNode(g)).toBe(true);
    expect(isGroupNode(l)).toBe(false);
  });
});

describe('flattenLayers', () => {
  it('returns every leaf, depth-first, group boundaries transparent', () => {
    const ids = flattenLayers(nestedTree()).map((l) => l.id);
    expect(ids).toEqual(['A', 'B', 'C', 'D']);
  });

  it('is empty for an all-group tree with no leaves', () => {
    expect(flattenLayers([group('empty', [])])).toEqual([]);
  });
});

describe('allStackNodes', () => {
  it('includes groups themselves, parent before children', () => {
    const ids = allStackNodes(nestedTree()).map((n) => n.id);
    expect(ids).toEqual(['A', 'grp1', 'B', 'grp2', 'C', 'D']);
  });
});

describe('firstLayerId', () => {
  it('is the first LEAF in stack order, skipping a leading group', () => {
    expect(firstLayerId(nestedTree())).toBe('A');
    expect(firstLayerId([group('g', [layer('only')])])).toBe('only');
  });

  it('is undefined when there are no leaves at all', () => {
    expect(firstLayerId([group('g', [])])).toBeUndefined();
  });
});

describe('findLayer', () => {
  it('finds a leaf at root and at any nested depth', () => {
    const tree = nestedTree();
    expect(findLayer(tree, 'A')?.id).toBe('A');
    expect(findLayer(tree, 'B')?.id).toBe('B');
    expect(findLayer(tree, 'D')?.id).toBe('D');
  });

  it('never resolves a group id, even though the id exists in the tree', () => {
    expect(findLayer(nestedTree(), 'grp1')).toBeUndefined();
  });

  it('is undefined for an unknown id', () => {
    expect(findLayer(nestedTree(), 'nope')).toBeUndefined();
  });
});

describe('findStackNode', () => {
  it('resolves both layers and groups, at any depth', () => {
    const tree = nestedTree();
    expect(findStackNode(tree, 'A')?.kind).toBe('layer');
    expect(findStackNode(tree, 'grp1')?.kind).toBe('group');
    expect(findStackNode(tree, 'grp2')?.kind).toBe('group');
    expect(findStackNode(tree, 'D')?.kind).toBe('layer');
  });
});

describe('findLayerOwningNode', () => {
  it('finds the leaf layer whose graph contains a given node id, at any depth', () => {
    const tree = nestedTree();
    expect(findLayerOwningNode(tree, 'a1')?.id).toBe('A');
    expect(findLayerOwningNode(tree, 'c1')?.id).toBe('C');
    expect(findLayerOwningNode(tree, 'missing')).toBeUndefined();
  });
});

describe('findSiblingArray', () => {
  it('locates the ROOT array for a top-level node', () => {
    const tree = nestedTree();
    const info = findSiblingArray(tree, 'A');
    expect(info?.index).toBe(0);
    expect(info?.siblings.map((n) => n.id)).toEqual(['A', 'grp1']);
  });

  it("locates a group's own children array for a nested node", () => {
    const tree = nestedTree();
    const info = findSiblingArray(tree, 'C');
    expect(info?.index).toBe(0);
    expect(info?.siblings.map((n) => n.id)).toEqual(['C', 'D']);
  });

  it('is undefined for an unknown id', () => {
    expect(findSiblingArray(nestedTree(), 'nope')).toBeUndefined();
  });
});

describe('replaceSiblingArray', () => {
  it("replaces the ROOT array when the id lives there", () => {
    const tree = nestedTree();
    const next = replaceSiblingArray(tree, 'A', [layer('Z')]);
    expect(next.map((n) => n.id)).toEqual(['Z']);
  });

  it("replaces a nested group's children array in place, leaving the rest of the tree untouched", () => {
    const tree = nestedTree();
    const next = replaceSiblingArray(tree, 'C', [layer('Z')]);
    expect(next[0]).toBe(tree[0]); // sibling branch ('A') structurally shared
    const grp1 = next[1] as LayerGroup;
    const grp2 = grp1.children[1] as LayerGroup;
    expect(grp2.children.map((n) => n.id)).toEqual(['Z']);
  });

  it('returns the tree unchanged (same reference) when the id is not found', () => {
    const tree = nestedTree();
    expect(replaceSiblingArray(tree, 'nope', [])).toBe(tree);
  });
});

describe('updateStackNode', () => {
  it('applies fn to a leaf at any depth, immutably', () => {
    const tree = nestedTree();
    const { nodes, changed } = updateStackNode(tree, 'C', (n) => ({ ...n, name: 'renamed' }));
    expect(changed).toBe(true);
    const grp1 = nodes[1] as LayerGroup;
    const grp2 = grp1.children[1] as LayerGroup;
    expect(grp2.children[0].name).toBe('renamed');
    // Untouched branch is structurally shared.
    expect(nodes[0]).toBe(tree[0]);
  });

  it('removes the node (and its whole subtree, for a group) when fn returns null', () => {
    const tree = nestedTree();
    const { nodes } = updateStackNode(tree, 'grp2', () => null);
    const grp1 = nodes[1] as LayerGroup;
    expect(grp1.children.map((n) => n.id)).toEqual(['B']);
  });

  it('reports changed: false and returns an equivalent tree when the id is not found', () => {
    const tree = nestedTree();
    const { changed, nodes } = updateStackNode(tree, 'nope', () => null);
    expect(changed).toBe(false);
    expect(nodes.map((n) => n.id)).toEqual(tree.map((n) => n.id));
  });
});

describe('mapLeafLayers', () => {
  it('maps every leaf, preserving group nesting', () => {
    const tree = nestedTree();
    const next = mapLeafLayers(tree, (l) => ({ ...l, opacity: 0.5 }));
    expect(flattenLayers(next).every((l) => l.opacity === 0.5)).toBe(true);
    expect(flattenLayers(next).map((l) => l.id)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('returns the SAME reference when fn changes nothing, at every level (structural sharing)', () => {
    const tree = nestedTree();
    const next = mapLeafLayers(tree, (l) => l);
    expect(next).toBe(tree);
  });

  it('only reallocates the branch that actually changed', () => {
    const tree = nestedTree();
    const next = mapLeafLayers(tree, (l) => (l.id === 'C' ? { ...l, opacity: 0.1 } : l));
    expect(next).not.toBe(tree);
    expect(next[0]).toBe(tree[0]); // 'A' branch untouched
    const grp1 = next[1] as LayerGroup;
    expect(grp1).not.toBe(tree[1]);
    expect(grp1.children[0]).toBe((tree[1] as LayerGroup).children[0]); // 'B' untouched
  });
});
