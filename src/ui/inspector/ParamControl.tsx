// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Param control
// ───────────────────────────────────────────────────────────────────────────
// Dispatches on `param.ui` to the right widget and wires it to the store.
//
// Two write strategies, matching `fields.tsx`'s header:
//   • Continuous controls (range slider, colour swatch, toggle, select) have
//     no partial/invalid states worth protecting, so they call `setParam`
//     straight through on every change.
//   • Typed entry (the slider's numeric readout, a bare `number` param, vector
//     components, texture asset ids, colour hex) goes through the buffered
//     `NumberField`/`TextField` from `fields.tsx`, so an in-progress keystroke
//     is never clobbered by the document re-render it causes.
// ═══════════════════════════════════════════════════════════════════════════

import type { NodeParam, ShaderNode } from '../../model/document';
import { useEditorStore } from '../store';
import { NumberField, TextField } from './fields';
import {
  applyHex,
  asScalarOrVector,
  clampToParam,
  componentLabels,
  rgbToHex,
  setComponent,
  toBoolean,
  toNumber,
  toText,
  toVector,
  vectorArity,
} from './paramValues';

export interface ParamControlProps {
  node: ShaderNode;
  param: NodeParam;
}

/** One control, keyed to `param.ui`. */
export function ParamControl({ node, param }: ParamControlProps) {
  const setParam = useEditorStore((s) => s.setParam);
  const commit = (value: Parameters<typeof setParam>[2]) => setParam(node.id, param.id, value);
  const clamp = (value: number) => clampToParam(value, param);

  switch (param.ui) {
    case 'slider': {
      const value = toNumber(param.value);
      const step = param.step ?? (param.type === 'int' ? 1 : 0.01);
      return (
        <div className="sg-param__slider-row">
          <input
            type="range"
            className="sg-param__range"
            min={param.min}
            max={param.max}
            step={step}
            value={value}
            aria-label={param.label}
            onChange={(event) => commit(clamp(Number(event.target.value)))}
          />
          <NumberField
            value={value}
            step={step}
            label={`${param.label} value`}
            className="sg-param__slider-readout"
            clamp={clamp}
            onCommit={commit}
          />
        </div>
      );
    }

    case 'number':
      return (
        <NumberField
          value={toNumber(param.value)}
          step={param.step}
          label={param.label}
          clamp={clamp}
          onCommit={commit}
        />
      );

    case 'toggle':
      return (
        <input
          type="checkbox"
          className="sg-param__toggle"
          checked={toBoolean(param.value)}
          aria-label={param.label}
          onChange={(event) => commit(event.target.checked)}
        />
      );

    case 'select': {
      const options = param.options ?? [];
      return (
        <select
          className="sg-param__select"
          value={toText(param.value)}
          aria-label={param.label}
          onChange={(event) => commit(event.target.value)}
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }

    case 'color': {
      const rgb = toVector(param.value, vectorArity(param.type));
      const hex = rgbToHex(rgb);
      return (
        <div className="sg-param__color-row">
          <input
            type="color"
            className="sg-param__swatch"
            value={hex}
            aria-label={`${param.label} swatch`}
            onChange={(event) => {
              const next = applyHex(rgb, event.target.value);
              if (next) commit(asScalarOrVector(next));
            }}
          />
          <TextField
            value={hex}
            label={`${param.label} hex`}
            className="sg-param__hex"
            onCommit={(text) => {
              const next = applyHex(rgb, text);
              if (!next) return false;
              commit(asScalarOrVector(next));
            }}
          />
        </div>
      );
    }

    case 'vector': {
      const arity = vectorArity(param.type);
      const labels = componentLabels(param.type);
      const components = toVector(param.value, arity);
      return (
        <div className="sg-param__vector-row">
          {components.map((component, index) => (
            <NumberField
              key={labels[index] ?? index}
              value={component}
              step={param.step}
              label={`${param.label} ${labels[index] ?? index}`}
              className="sg-param__vector-cell"
              clamp={clamp}
              onCommit={(next) => commit(asScalarOrVector(setComponent(components, index, next)))}
            />
          ))}
        </div>
      );
    }

    case 'texture':
      return (
        <TextField
          value={toText(param.value)}
          label={param.label}
          placeholder="asset id"
          onCommit={(text) => commit(text)}
        />
      );

    default: {
      // Exhaustive over `ParamUiHint`; a new hint fails to typecheck here.
      const exhaustive: never = param.ui;
      return exhaustive;
    }
  }
}
