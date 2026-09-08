// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique: orchestration
// ───────────────────────────────────────────────────────────────────────────
// The one function `src/ui/critique/CritiquePanel.tsx` calls. Ties together
// config validation, the (already-extracted) render + reference stills, and
// the provider call — but owns none of screenshot capture, frame
// extraction, request construction, or response parsing itself, so each of
// those stays independently unit-testable (see their own `*.test.ts` files).
//
// `deps.call` defaults to the real `callAnthropic` but is always
// overridable, so this orchestration — including its config-validation and
// error-mapping branches — is testable without a real network call.
// ═══════════════════════════════════════════════════════════════════════════

import type { ReferenceCritiqueConfig } from '../model/settings';
import { callAnthropic } from './anthropicClient';
import { CritiqueError } from './errors';
import { parseCritiqueResponse } from './parseCritique';
import { DEFAULT_CRITIQUE_PROMPT } from './prompt';
import type { CritiqueResult, StillImage } from './types';

export interface RunCritiqueInput {
  config: ReferenceCritiqueConfig | undefined;
  render: StillImage;
  references: StillImage[];
  prompt?: string;
}

export interface RunCritiqueDeps {
  call?: typeof callAnthropic;
}

/**
 * Validates the configured provider and inputs, calls it, and parses the
 * result. Every failure mode (no config, unimplemented provider, no
 * reference selected, the provider call itself failing) surfaces as a typed
 * `CritiqueError` — never a silent failure or an unhandled rejection reaching
 * the UI unlabeled.
 */
export async function runCritique(input: RunCritiqueInput, deps: RunCritiqueDeps = {}): Promise<CritiqueResult> {
  const { config, render, references, prompt = DEFAULT_CRITIQUE_PROMPT } = input;

  if (!config) {
    throw new CritiqueError(
      'missing-api-key',
      'No reference-critique provider configured — set one under Project Settings → Reference critique.',
    );
  }
  if (config.provider !== 'api') {
    // `ReferenceCritiqueMcpConfig` is a documented-but-unimplemented stretch
    // goal (see `src/model/settings.ts`) — nothing constructs one from the
    // Settings panel today, but this branch exists so selecting it later
    // fails loudly and specifically rather than silently, if that ever
    // changes ahead of an actual MCP implementation landing.
    throw new CritiqueError(
      'missing-api-key',
      'Only the direct-API provider is implemented for reference critique — MCP is a documented stretch goal, not yet built.',
    );
  }
  if (references.length === 0) {
    throw new CritiqueError('missing-reference', 'No reference image or video selected.');
  }

  const call = deps.call ?? callAnthropic;
  const raw = await call(config, render, references, prompt);
  return parseCritiqueResponse(raw);
}
