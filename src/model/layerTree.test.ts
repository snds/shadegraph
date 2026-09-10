import { describe, expect, it } from 'vitest';

import type { LayerGroup, ShaderGraph, ShaderLayer, StackNode } from './document';
import {
  allStackNodes,
  ancestorGroupIds,
  findLayer,
  findLayerOwningNode,
  findSiblingArray,
  findStackNode,
  firstLayerId,
  flattenLayers,
  insertStackNode,
  isGroupNode,
  isLayerNode,
  mapLeafLayers,
  moveStackNode,
  replaceSiblingArray,
  subtreeIds,
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

describe('subtreeIds', () => {
  it('is just the node itself for a leaf', () => {
    expect(subtreeIds(layer('A'))).toEqual(new Set(['A']));
  });

  it('includes every nested descendant for a group', () => {
    const grp1 = nestedTree()[1] as LayerGroup;
    expect(subtreeIds(grp1)).toEqual(new Set(['grp1', 'B', 'grp2', 'C', 'D']));
  });
});

describe('ancestorGroupIds', () => {
  it('is empty for a root-level node', () => {
    expect(ancestorGroupIds(nestedTree(), 'A')).toEqual([]);
  });

  it('lists every enclosing group for a deeply nested leaf', () => {
    expect(ancestorGroupIds(nestedTree(), 'D')).toEqual(['grp2', 'grp1']);
  });

  it('lists the enclosing group for a nested group itself', () => {
    expect(ancestorGroupIds(nestedTree(), 'grp2')).toEqual(['grp1']);
  });

  it('is empty for an id that does not exist', () => {
    expect(ancestorGroupIds(nestedTree(), 'nope')).toEqual([]);
  });
});

describe('insertStackNode', () => {
  it('appends at the root end when insertBeneathId is omitted', () => {
    const tree = nestedTree();
    const next = insertStackNode(tree, layer('NEW'), undefined);
    expect(next.map((n) => n.id)).toEqual(['A', 'grp1', 'NEW']);
  });

  it('appends at the root end when insertBeneathId does not resolve', () => {
    const tree = nestedTree();
    const next = insertStackNode(tree, layer('NEW'), 'nope');
    expect(next.map((n) => n.id)).toEqual(['A', 'grp1', 'NEW']);
  });

  it('inserts directly below the named sibling in its own array, at any depth', () => {
    const tree = nestedTree();
    const next = insertStackNode(tree, layer('NEW'), 'A');
    expect(next.map((n) => n.id)).toEqual(['NEW', 'A', 'grp1']);

    const nested = insertStackNode(tree, layer('NEW'), 'D');
    const grp2 = (nested[1] as LayerGroup).children[1] as LayerGroup;
    expect(grp2.children.map((n) => n.id)).toEqual(['C', 'NEW', 'D']);
  });
});

describe('moveStackNode', () => {
  it('reorders within the same sibling array', () => {
    const tree = nestedTree();
    const grp1 = tree[1] as LayerGroup;
    const { nodes, error } = moveStackNode(grp1.children, 'B', {
      parentId: null,
      kind: 'after',
      refId: 'grp2',
    });
    expect(error).toBeUndefined();
    expect(nodes.map((n) => n.id)).toEqual(['grp2', 'B']);
  });

  it('moves a leaf out of a group to the root', () => {
    const tree = nestedTree();
    const { nodes, error } = moveStackNode(tree, 'B', { parentId: null, kind: 'after', refId: 'A' });
    expect(error).toBeUndefined();
    expect(nodes.map((n) => n.id)).toEqual(['A', 'B', 'grp1']);
    const grp1 = nodes[2] as LayerGroup;
    expect(grp1.children.map((n) => n.id)).toEqual(['grp2']);
  });

  it('moves a leaf into an existing group by appending', () => {
    const tree = nestedTree();
    const { nodes, error } = moveStackNode(tree, 'A', { parentId: 'grp1', kind: 'append' });
    expect(error).toBeUndefined();
    expect(nodes.map((n) => n.id)).toEqual(['grp1']);
    const grp1 = nodes[0] as LayerGroup;
    expect(grp1.children.map((n) => n.id)).toEqual(['B', 'grp2', 'A']);
  });

  it('moves a leaf into an existing group before/after a specific member', () => {
    const tree = nestedTree();
    const { nodes, error } = moveStackNode(tree, 'A', { parentId: 'grp1', kind: 'before', refId: 'B' });
    expect(error).toBeUndefined();
    const grp1 = nodes[0] as LayerGroup;
    expect(grp1.children.map((n) => n.id)).toEqual(['A', 'B', 'grp2']);
  });

  it('rejects an unknown id', () => {
    const { error, nodes } = moveStackNode(nestedTree(), 'nope', { parentId: null, kind: 'after', refId: 'A' });
    expect(error).toMatch(/No layer/);
    expect(nodes.map((n) => n.id)).toEqual(['A', 'grp1']);
  });

  it('rejects dropping a group inside itself', () => {
    const { error } = moveStackNode(nestedTree(), 'grp1', { parentId: 'grp1', kind: 'append' });
    expect(error).toMatch(/inside itself/);
  });

  it('rejects dropping a group inside its own descendant', () => {
    const { error } = moveStackNode(nestedTree(), 'grp1', { parentId: 'grp2', kind: 'append' });
    expect(error).toMatch(/own descendant/);
  });

  it('rejects a parentId that is not a group', () => {
    const { error } = moveStackNode(nestedTree(), 'A', { parentId: 'B', kind: 'append' });
    expect(error).toMatch(/not a group/);
  });

  it('rejects an unknown refId', () => {
    const { error } = moveStackNode(nestedTree(), 'A', { parentId: null, kind: 'after', refId: 'nope' });
    expect(error).toMatch(/No layer "nope"/);
  });

  it('is a no-op when the ref is the node itself', () => {
    const tree = nestedTree();
    const { nodes, error } = moveStackNode(tree, 'A', { parentId: null, kind: 'after', refId: 'A' });
    expect(error).toBeUndefined();
    expect(nodes.map((n) => n.id)).toEqual(['A', 'grp1']);
  });
});
