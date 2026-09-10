// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — left pivot rail
// ───────────────────────────────────────────────────────────────────────────
// Renders `pivotItems` (a plain typed array — see `pivotItems.tsx`) as a
// vertical list of icon+label buttons, plus a collapse toggle and, in a
// visually separate bottom dock, Settings + the user-profile stub. Nothing
// here is hardcoded per-panel: adding, removing, or reordering an entry is
// entirely a `pivotItems.tsx` edit.
//
// Props-free selection state lives in the parent (`Shell.tsx`) so the panel
// host and the rail always agree on which pivot is active.
// ═══════════════════════════════════════════════════════════════════════════

import { Icon } from './Icon';
import type { PivotItem } from './pivotItems';
import { SettingsDock } from './SettingsDock';
import './shell.css';
import { UserProfileDock } from './UserProfileDock';

interface PivotRailProps {
  items: PivotItem[];
  activeId: string;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function PivotRail({ items, activeId, onSelect, collapsed, onToggleCollapsed }: PivotRailProps) {
  return (
    <nav className={collapsed ? 'sg-rail sg-rail--collapsed' : 'sg-rail'} aria-label="Panels">
      <button
        type="button"
        className="sg-rail__collapse"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand panel rail' : 'Collapse panel rail'}
        title={collapsed ? 'Expand rail' : 'Collapse rail'}
      >
        <Icon name={collapsed ? 'chevron_right' : 'chevron_left'} />
      </button>

      <div className="sg-rail__items">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={
              item.id === activeId ? 'sg-rail__item sg-rail__item--active' : 'sg-rail__item'
            }
            onClick={() => onSelect(item.id)}
            aria-pressed={item.id === activeId}
            title={item.label}
          >
            <Icon name={item.icon} />
            {!collapsed && <span className="sg-rail__label">{item.label}</span>}
          </button>
        ))}
      </div>

      <div className="sg-rail__dock">
        <SettingsDock collapsed={collapsed} />
        <UserProfileDock collapsed={collapsed} />
      </div>
    </nav>
  );
}
