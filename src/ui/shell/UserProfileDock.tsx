// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — user-profile stub, bottom-docked in the pivot rail
// ───────────────────────────────────────────────────────────────────────────
// A display name (persisted to `localStorage`, editable) + an initials-based
// avatar placeholder. No auth, no upload — exactly what this phase's task
// scope calls for. Docked next to `SettingsDock`, not a pivot item.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState } from 'react';

import { Icon } from './Icon';

const STORAGE_KEY = 'shadegraph.userProfile.displayName';
const DEFAULT_NAME = 'You';

function readStoredName(): string {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored && stored.trim() ? stored : DEFAULT_NAME;
  } catch {
    // localStorage can throw (private browsing, disabled storage); the stub
    // still works for the session, just without persistence.
    return DEFAULT_NAME;
  }
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0] + parts[parts.length - 1]![0]).toUpperCase();
}

export function UserProfileDock({ collapsed }: { collapsed: boolean }) {
  const [name, setName] = useState(readStoredName);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, name);
    } catch {
      // See `readStoredName` — persistence is best-effort only.
    }
  }, [name]);

  function handleSave() {
    const trimmed = draft.trim();
    setName(trimmed || DEFAULT_NAME);
    setOpen(false);
  }

  return (
    <div className="sg-rail__profile">
      <button
        type="button"
        className="sg-rail__dock-item"
        onClick={() => {
          setDraft(name);
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-label={`User profile: ${name}`}
        title={name}
      >
        <span className="sg-rail__avatar" aria-hidden="true">
          {initials(name)}
        </span>
        {!collapsed && <span className="sg-rail__label">{name}</span>}
      </button>

      {open && (
        <div className="sg-rail__profile-popover" role="dialog" aria-label="Edit display name">
          <label className="sg-rail__profile-field-label" htmlFor="sg-profile-name">
            Display name
          </label>
          <input
            id="sg-profile-name"
            type="text"
            className="sg-field"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave();
              if (e.key === 'Escape') setOpen(false);
            }}
            autoFocus
          />
          <div className="sg-rail__profile-actions">
            <button type="button" className="sg-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="sg-btn" onClick={handleSave}>
              <Icon name="check" /> Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
