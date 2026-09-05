// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Add-node palette
// ───────────────────────────────────────────────────────────────────────────
// Opens at the pointer (double-click or right-click on empty canvas, or the
// toolbar button) and drops a node exactly where you asked for it. The list is
// the registry itself, grouped by category — a new node definition appears here
// with no change to this file.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { nodes, type NodeCategory, type NodeDefinition } from '../../nodes/registry';

/** Palette grouping order. Anything not listed is appended alphabetically. */
const CATEGORY_ORDER: NodeCategory[] = [
  'input',
  'math',
  'noise',
  'color',
  'sdf',
  'lighting',
  'texture',
  'util',
  'legion',
  'output',
];

function rank(category: NodeCategory): number {
  const i = CATEGORY_ORDER.indexOf(category);
  return i < 0 ? CATEGORY_ORDER.length : i;
}

/** Definitions matching `query`, flattened in palette order. */
function search(query: string): NodeDefinition[] {
  const q = query.trim().toLowerCase();
  return nodes
    .all()
    .filter(
      (d) =>
        q === '' ||
        d.title.toLowerCase().includes(q) ||
        d.type.toLowerCase().includes(q) ||
        d.category.toLowerCase().includes(q) ||
        (d.description?.toLowerCase().includes(q) ?? false),
    )
    .sort((a, b) => rank(a.category) - rank(b.category) || a.title.localeCompare(b.title));
}

export interface AddNodePaletteProps {
  /** Where to anchor the panel, in client (screen) coordinates. */
  at: { x: number; y: number };
  onPick: (type: string) => void;
  onClose: () => void;
}

export function AddNodePalette({ at, onPick, onClose }: AddNodePaletteProps) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => search(query), [query]);
  const active = results[Math.min(cursor, results.length - 1)];

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, results]);

  function onKeyDown(event: ReactKeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((c) => Math.min(c + 1, results.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      onPick(active.type);
    }
  }

  let lastCategory: NodeCategory | null = null;

  return (
    <>
      {/* Click-away shield. Sits under the panel, over the canvas. */}
      <div className="sg-palette__shield" onMouseDown={onClose} onContextMenu={(e) => e.preventDefault()} />
      <div
        className="sg-palette"
        style={{ left: at.x, top: at.y }}
        role="dialog"
        aria-label="Add node"
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="sg-palette__search"
          placeholder="Add node…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search node types"
        />
        <div className="sg-palette__list" ref={listRef}>
          {results.length === 0 ? <div className="sg-palette__empty">No node matches “{query}”.</div> : null}
          {results.map((def, i) => {
            const header = def.category !== lastCategory ? def.category : null;
            lastCategory = def.category;
            return (
              <div key={def.type}>
                {header ? <div className="sg-palette__group">{header}</div> : null}
                <button
                  type="button"
                  className="sg-palette__item"
                  data-active={i === Math.min(cursor, results.length - 1)}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => onPick(def.type)}
                >
                  <span className="sg-palette__title">{def.title}</span>
                  <span className="sg-palette__type">{def.type}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="sg-palette__hint">↑↓ navigate · ⏎ add · esc close</div>
      </div>
    </>
  );
}
