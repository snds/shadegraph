import { describe, expect, it } from 'vitest';

import { flattenVisibleTree, makeNode, nodeId } from './tree';
import type { AssetTreeNode } from './tree';

function indexById(nodes: AssetTreeNode[]): Record<string, AssetTreeNode> {
  return Object.fromEntries(nodes.map((n) => [n.id, n]));
}

describe('makeNode / nodeId', () => {
  it('derives id from the joined path and depth from path length', () => {
    const node = makeNode(['refs', 'planets'], 'planets', 'folder', 'refs');
    expect(node.id).toBe(nodeId(['refs', 'planets']));
    expect(node.id).toBe('refs/planets');
    expect(node.depth).toBe(1);
    expect(node.parentId).toBe('refs');
    expect(node.expanded).toBe(false);
    expect(node.childIds).toBeUndefined();
  });
});

describe('flattenVisibleTree', () => {
  it('includes only the root level when nothing is expanded', () => {
    const a = makeNode(['a'], 'a', 'folder');
    const b = makeNode(['b'], 'b', 'file');
    const nodesById = indexById([a, b]);
    const flat = flattenVisibleTree(nodesById, [a.id, b.id]);
    expect(flat.map((n) => n.id)).toEqual(['a', 'b']);
  });

  it('inlines a folder\'s children only when expanded AND already loaded', () => {
    const folder = { ...makeNode(['a'], 'a', 'folder'), expanded: true, childIds: ['a/x'] };
    const child = makeNode(['a', 'x'], 'x', 'file', 'a');
    const notYetLoaded = { ...makeNode(['b'], 'b', 'folder'), expanded: true }; // childIds still undefined

    const nodesById = indexById([folder, child, notYetLoaded]);
    const flat = flattenVisibleTree(nodesById, [folder.id, notYetLoaded.id]);

    expect(flat.map((n) => n.id)).toEqual(['a', 'a/x', 'b']);
  });

  it('omits a collapsed folder\'s children even if they were loaded previously', () => {
    const folder = { ...makeNode(['a'], 'a', 'folder'), expanded: false, childIds: ['a/x'] };
    const child = makeNode(['a', 'x'], 'x', 'file', 'a');
    const nodesById = indexById([folder, child]);

    expect(flattenVisibleTree(nodesById, [folder.id]).map((n) => n.id)).toEqual(['a']);
  });

  it('recurses through nested expanded folders in depth-first order', () => {
    const root = { ...makeNode(['root'], 'root', 'folder'), expanded: true, childIds: ['root/mid'] };
    const mid = {
      ...makeNode(['root', 'mid'], 'mid', 'folder', 'root'),
      expanded: true,
      childIds: ['root/mid/leaf'],
    };
    const leaf = makeNode(['root', 'mid', 'leaf'], 'leaf', 'file', 'root/mid');
    const nodesById = indexById([root, mid, leaf]);

    expect(flattenVisibleTree(nodesById, [root.id]).map((n) => n.id)).toEqual([
      'root',
      'root/mid',
      'root/mid/leaf',
    ]);
  });
});
