// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Text/number entry fields
// ───────────────────────────────────────────────────────────────────────────
// THE FOCUS RULE. Every store write replaces `doc`, which re-renders the whole
// inspector. A naïve `value={param.value} onChange={setParam}` input would
// therefore be re-driven from the document on every keystroke — reformatting
// "0.10" to "0.1", stealing the caret, and making "-" or "1." impossible to
// type at all, because neither parses to a number yet.
//
// So typed entry is *buffered*: the field owns a local draft string while it is
// being edited, and commits on blur or Enter. Escape reverts. The document is
// re-read into the draft only when the field is NOT being edited, which is what
// keeps an external change (undo, file load, a slider drag) visible.
//
// Continuous controls (slider, swatch, toggle, select) are the opposite case:
// they have no partial states to protect, so they write straight through — see
// `ParamControl.tsx`.
//
// Arrow Up/Down nudge by `step` (Shift = ×10), so a value can be dialled in
// without a pointer.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect, useState, type KeyboardEvent } from 'react';

import { formatNumber, parseNumber } from './paramValues';

interface DraftBinding {
  value: string;
  onChange: (event: { target: { value: string } }) => void;
  onBlur: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

/**
 * A text input bound to an external value but safe to type in.
 *
 * `commit` receives the raw draft; it may ignore junk, because ending an edit
 * always re-syncs the draft from `external`.
 */
function useCommittedDraft(
  external: string,
  commit: (text: string) => void,
  onArrowStep?: (direction: 1 | -1, coarse: boolean) => void,
): DraftBinding {
  const [draft, setDraft] = useState(external);
  const [editing, setEditing] = useState(false);

  // Only while the user is not mid-edit — otherwise this is the caret thief.
  useEffect(() => {
    if (!editing) setDraft(external);
  }, [external, editing]);

  return {
    value: editing ? draft : external,
    onChange(event) {
      setDraft(event.target.value);
      setEditing(true);
    },
    onBlur() {
      if (editing) commit(draft);
      setEditing(false);
    },
    onKeyDown(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (editing) commit(draft);
        setEditing(false);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setEditing(false);
        setDraft(external);
      } else if (onArrowStep && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault();
        setEditing(false);
        onArrowStep(event.key === 'ArrowUp' ? 1 : -1, event.shiftKey);
      }
    },
  };
}

export interface NumberFieldProps {
  id?: string;
  /** The committed value from the document. */
  value: number;
  step?: number;
  label: string;
  className?: string;
  /** Range/rounding rules from the param definition. */
  clamp: (value: number) => number;
  onCommit: (value: number) => void;
}

/** One numeric cell: sliders' readouts, `number` params, vector components. */
export function NumberField({
  id,
  value,
  step,
  label,
  className,
  clamp,
  onCommit,
}: NumberFieldProps) {
  const write = (next: number) => {
    const clamped = clamp(next);
    if (clamped !== value) onCommit(clamped);
  };

  const binding = useCommittedDraft(
    formatNumber(value, step),
    (text) => {
      const parsed = parseNumber(text);
      if (parsed !== null) write(parsed);
    },
    (direction, coarse) => write(value + direction * (step ?? 1) * (coarse ? 10 : 1)),
  );

  return (
    <input
      {...binding}
      id={id}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      className={className ? `sg-field ${className}` : 'sg-field'}
    />
  );
}

export interface TextFieldProps {
  id?: string;
  value: string;
  label: string;
  placeholder?: string;
  className?: string;
  /** Return `false` to reject the text and revert (used by the hex field). */
  onCommit: (text: string) => boolean | void;
}

/** One free-text cell: texture asset ids, colour hex. */
export function TextField({ id, value, label, placeholder, className, onCommit }: TextFieldProps) {
  const binding = useCommittedDraft(value, (text) => {
    onCommit(text);
  });

  return (
    <input
      {...binding}
      id={id}
      type="text"
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder}
      aria-label={label}
      className={className ? `sg-field ${className}` : 'sg-field'}
    />
  );
}
