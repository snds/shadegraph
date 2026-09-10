// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Node gallery "more info" dialog
// ───────────────────────────────────────────────────────────────────────────
// Fuller documentation for one node type: the hover guidance, plus its real
// inputs/outputs/params read straight off the `NodeDefinition` — never a
// hand-duplicated description that can drift from the registry. Same
// overlay + dialog + close-button chrome as `SettingsDock.tsx`'s dialog, so
// the app has one dialog "shape" rather than several.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeDefinition } from '../../nodes/registry';
import { Icon } from '../shell/Icon';
import { categoryIcon } from './nodeCategoryIcons';
import './nodeGallery.css';

function formatDefault(value: unknown): string | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) return `[${value.join(', ')}]`;
  return String(value);
}

export interface NodeInfoDialogProps {
  def: NodeDefinition;
  onClose: () => void;
}

export function NodeInfoDialog({ def, onClose }: NodeInfoDialogProps) {
  return (
    <div className="sg-node-info__overlay" role="dialog" aria-label={`${def.title} details`} onMouseDown={onClose}>
      <div className="sg-node-info__dialog" onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" className="sg-node-info__close" onClick={onClose} aria-label="Close">
          <Icon name="close" title="Close" />
        </button>
        <div className="sg-node-info__head">
          <Icon name={categoryIcon(def.category)} className="sg-node-info__icon" />
          <div>
            <h3 className="sg-node-info__title">{def.title}</h3>
            <code className="sg-node-info__type">{def.type}</code>
          </div>
        </div>
        <p className="sg-node-info__blurb">{def.guidance ?? def.description ?? 'No description yet.'}</p>

        {def.inputs.length > 0 && (
          <section className="sg-node-info__section">
            <h4>Inputs</h4>
            <ul>
              {def.inputs.map((s) => (
                <li key={s.id}>
                  <span>{s.label}</span>
                  <code>{s.type}</code>
                </li>
              ))}
            </ul>
          </section>
        )}

        {def.outputs.length > 0 && (
          <section className="sg-node-info__section">
            <h4>Outputs</h4>
            <ul>
              {def.outputs.map((s) => (
                <li key={s.id}>
                  <span>{s.label}</span>
                  <code>{s.type}</code>
                </li>
              ))}
            </ul>
          </section>
        )}

        {def.params && def.params.length > 0 && (
          <section className="sg-node-info__section">
            <h4>Params</h4>
            <ul>
              {def.params.map((p) => {
                const dflt = formatDefault(p.value);
                return (
                  <li key={p.id}>
                    <span>{p.label}</span>
                    <code>
                      {p.type}
                      {dflt ? ` · default ${dflt}` : ''}
                    </code>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
