// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Project-manifest panel
// ───────────────────────────────────────────────────────────────────────────
// Save/load controls for the `ProjectManifest` (`useManifestStore`), plus a
// minimal connected-folders list. Deliberately NOT the discovered-object
// browsing list — that is a separate, later task (see the task note).
//
// Mirrors `DocToolbar.tsx`'s Save/Load treatment: file I/O mechanics live in
// `manifestPersistence.ts`; this component is only the controls that drive
// them, and a malformed file is validated into a complete manifest BEFORE it
// ever reaches `loadManifest` — a bad load leaves the current manifest
// untouched and only raises a visible error.
//
// Props-free — reads `useManifestStore` directly, same contract as every
// other pane (`DocToolbar`, `SettingsPanel`).
// ═══════════════════════════════════════════════════════════════════════════

import { useRef, useState } from 'react';

import { downloadManifest, manifestFileName, parseManifestText } from './manifestPersistence';
import { useManifestStore } from './manifestStore';
import './manifest.css';

export function ManifestPanel() {
  const manifest = useManifestStore((s) => s.manifest);
  const lastError = useManifestStore((s) => s.lastError);
  const addConnectedFolder = useManifestStore((s) => s.addConnectedFolder);
  const removeConnectedFolder = useManifestStore((s) => s.removeConnectedFolder);
  const loadManifest = useManifestStore((s) => s.loadManifest);
  const newManifest = useManifestStore((s) => s.newManifest);
  const clearError = useManifestStore((s) => s.clearError);

  const fileInput = useRef<HTMLInputElement>(null);
  const [folderName, setFolderName] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  function handleNew() {
    newManifest();
    setStatus('New project manifest');
  }

  function handleSave() {
    setStatus(`Saved ${downloadManifest(manifest)}`);
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
      useManifestStore.setState({
        lastError: `Could not read "${file.name}": ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    // Validated into a complete manifest before anything touches the store: a
    // malformed file leaves the open manifest exactly as it was.
    const result = parseManifestText(text);
    if (!result.ok) {
      useManifestStore.setState({ lastError: `Could not open "${file.name}": ${result.message}` });
      return;
    }
    loadManifest(result.manifest);
    setStatus(`Loaded ${file.name}`);
  }

  function handleAddFolder() {
    const name = folderName.trim();
    if (!name) return;
    addConnectedFolder(name);
    setFolderName('');
  }

  return (
    <div className="sg-manifest">
      <h2 className="sg-pane__title">Project manifest</h2>

      <p className="sg-hint">{manifest.name}</p>

      {lastError && (
        <p className="sg-manifest__error" role="alert">
          {lastError}
          <button type="button" className="sg-linkbtn" onClick={clearError}>
            dismiss
          </button>
        </p>
      )}

      <div className="sg-manifest__actions">
        {status && <span className="sg-hint sg-status">{status}</span>}
        <button type="button" className="sg-btn" onClick={handleNew}>
          New
        </button>
        <button type="button" className="sg-btn" onClick={handleSave} title={manifestFileName(manifest.name)}>
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
      </div>

      <section className="sg-manifest__section">
        <h3 className="sg-manifest__section-title">Connected folders</h3>

        {manifest.connectedFolders.length === 0 && (
          <p className="sg-pane__empty">No folders connected yet.</p>
        )}
        <ul className="sg-manifest__folders">
          {manifest.connectedFolders.map((folder) => (
            <li key={folder.id} className="sg-manifest__folder">
              <span>{folder.name}</span>
              <button
                type="button"
                className="sg-linkbtn"
                aria-label={`Remove ${folder.name}`}
                onClick={() => removeConnectedFolder(folder.id)}
              >
                remove
              </button>
            </li>
          ))}
        </ul>

        <div className="sg-manifest__add-folder">
          <input
            className="sg-field"
            type="text"
            placeholder="Folder name"
            aria-label="New connected folder name"
            value={folderName}
            onChange={(e) => setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddFolder();
            }}
          />
          <button type="button" className="sg-btn" onClick={handleAddFolder}>
            + Add folder
          </button>
        </div>
      </section>
    </div>
  );
}
