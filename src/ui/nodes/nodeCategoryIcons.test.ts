import { describe, expect, it } from 'vitest';

import type { NodeCategory } from '../../nodes/registry';
import { categoryIcon, NODE_CATEGORY_ICON } from './nodeCategoryIcons';

const ALL_CATEGORIES: NodeCategory[] = [
  'input',
  'math',
  'noise',
  'color',
  'sdf',
  'lighting',
  'texture',
  'util',
  'imported',
  'output',
];

describe('NODE_CATEGORY_ICON', () => {
  it('has a non-empty icon name for every node category', () => {
    for (const category of ALL_CATEGORIES) {
      expect(NODE_CATEGORY_ICON[category]).toBeTruthy();
    }
  });

  it('assigns a distinct icon per category', () => {
    const icons = ALL_CATEGORIES.map((c) => NODE_CATEGORY_ICON[c]);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe('categoryIcon', () => {
  it('returns the mapped icon for a known category', () => {
    expect(categoryIcon('noise')).toBe('grain');
  });

  it('falls back to a generic glyph for an unmapped category', () => {
    expect(categoryIcon('bogus' as NodeCategory)).toBe('category');
  });
});
