// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Document toolbar
// ───────────────────────────────────────────────────────────────────────────
// The document-level surface: name, New, Save, Load, and the autosave restore
// affordance. All persistence mechanics live in `persistence.ts`; this file is
// only the controls that drive them.
//
// Contract with `App.tsx` (which must not be edited):
//   • props-free — reads `useEditorStore` directly
//   • renders exactly one root element: the whole <header className="sg-topbar">
//   • named export `DocToolbar`
//
// Boot wiring (autosave subscription + restore) is triggered from HERE, not
// from App.tsx, so this task owns one file end to end. Both calls are
// idempotent, so StrictMode's double-invoked effects are harmless.
//
// `PerfRoot` (the performance-budget popover) is mounted here, in the action
// group, rather than as a fixed-position sibling of `<App />` — it's a
// props-free, self-contained control, so dropping it in doesn't change this
// file's own props-free/single-root contract.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';

import type { TargetLang } from '../compiler/backend';
import { notify } from './notice';
import { PerfRoot } from './perf/PerfRoot';
import {
  clearAutosave,
  documentFileName,
  downloadDocument,
  parseDocumentText,
  restoreAutosave,
  startAutosave,
} from './persistence';
import { useEditorStore } from './store';
import './toolbar.css';

/** "2026-09-05T14:39:13Z" → "14:39" — enough to recognise your own last edit. */
function shortTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'earlier';
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function DocToolbar() {
  const name = useEditorStore((s) => s.doc.name);
  const rig = useEditorStore((s) => s.doc.previewRig);
  const target = useEditorStore((s) => s.target);
  const setTarget = useEditorStore((s) => s.setTarget);
  const loadDocument = useEditorStore((s) => s.loadDocument);
  const newDocument = useEditorStore((s) => s.newDocument);
  const renameDocument = useEditorStore((s) => s.renameDocument);

  const fileInput = useRef<HTMLInputElement>(null);
  const [draftName, setDraftName] = useState(name);
  const [editingName, setEditingName] = useState(false);
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Boot: restore the autosave *before* subscribing, so the restore itself is
  // not immediately mirrored back to storage.
  useEffect(() => {
    const restored = restoreAutosave();
    if (restored) setRestoredAt(restored.savedAt);
    startAutosave();
  }, []);

  // The store is the source of truth for the name; the draft only exists while
  // the field has focus, so an external load/new is never overwritten by a
  // stale keystroke buffer.
  useEffect(() => {
    if (!editingName) setDraftName(name);
  }, [name, editingName]);

  /** Committed on blur/Enter rather than per keystroke, matching the draft
   *  buffering pattern above. `renameDocument` no-ops on an empty/unchanged
   *  name, so the draft is simply reset to whatever the store ends up with. */
  function commitName() {
    setEditingName(false);
    renameDocument(draftName);
    setDraftName(useEditorStore.getState().doc.name);
  }

  function handleNew() {
    newDocument();
    setRestoredAt(null);
    setStatus('New document');
  }

  function handleSave() {
    const doc = useEditorStore.getState().doc;
    setStatus(`Saved ${downloadDocument(doc)}`);
    setRestoredAt(null);
  }

  async function handleFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset immediately so picking the same file twice still fires `change`.
    event.target.value = '';
    if (!file) return;

    let text: string;
    try {
      text = await file.text();
    } catch (err) {
      notify(`Could not read "${file.name}": ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Validated into a complete document before anything touches the store: a
    // malformed file leaves the open document exactly as it was.
    const result = parseDocumentText(text);
    if (!result.ok) {
      notify(`Could not open "${file.name}": ${result.message}`);
      return;
    }
    loadDocument(result.doc);
    setRestoredAt(null);
    setStatus(`Loaded ${file.name}`);
  }

  function discardRestored() {
    clearAutosave();
    newDocument();
    setRestoredAt(null);
    setStatus('Discarded autosave');
  }

  return (
    <header className="sg-topbar">
      <span className="sg-logo">ShadeGraph</span>

      <input
        className="sg-doc sg-doc-name"
        value={draftName}
        aria-label="Document name"
        onChange={(e) => {
          setEditingName(true);
          setDraftName(e.target.value);
        }}
        onFocus={() => setEditingName(true)}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            setDraftName(useEditorStore.getState().doc.name);
            setEditingName(false);
            e.currentTarget.blur();
          }
        }}
      />

      <span className="sg-hint">rig: {rig}</span>

      <select
        className="sg-select sg-target"
        aria-label="Compile target"
        value={target}
        onChange={(e) => setTarget(e.target.value as TargetLang)}
      >
        <option value="glsl-es">GLSL ES</option>
        <option value="wgsl">WGSL</option>
      </select>

      {restoredAt !== null && (
        <span className="sg-restored" role="status">
          restored from local storage · {shortTime(restoredAt)}
          <button type="button" className="sg-linkbtn" onClick={discardRestored}>
            discard
          </button>
        </span>
      )}

      <span className="sg-toolbar-actions">
        {status && <span className="sg-hint sg-status">{status}</span>}
        <PerfRoot />
        <button type="button" className="sg-btn" onClick={handleNew}>
          New
        </button>
        <button
          type="button"
          className="sg-btn"
          onClick={handleSave}
          title={documentFileName(name)}
        >
          Save
        </button>
        <button type="button" className="sg-btn" onClick={() => fileInput.current?.click()}>
          Load
        </button>
        <input
          ref={fileInput}
          className="sg-file-input"
          type="file"
          accept="application/json,.json"
          onChange={handleFile}
        />
      </span>
    </header>
  );
}
