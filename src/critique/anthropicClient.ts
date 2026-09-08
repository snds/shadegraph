// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique: Anthropic Messages API client
// ───────────────────────────────────────────────────────────────────────────
// The ONE concrete LLM provider implementation for v1 (Phase 4 sketch,
// "Open questions — SETTLED": API-first, confirmed) — Anthropic's Messages
// API, called directly from the browser with a vision-capable Claude model.
// `ProjectSettings.referenceCritique.model` is already the right place for
// the model name (see `src/model/settings.ts`); `DEFAULT_MODEL` below is
// only the fallback when that field is left blank.
//
// Deliberately split in two so a future second provider never has to touch
// `runCritique.ts`'s orchestration:
//   - `buildAnthropicRequest` — PURE request construction (url + fetch
//     `RequestInit`), independent of the network. This is the one function
//     to replace (or add a sibling to) if a second provider is ever added.
//   - `callAnthropic` — the one function that actually calls `fetch`, with
//     `fetchImpl` injectable so tests never make a real HTTPS call.
//
// Browser CORS note: Anthropic's API requires the
// `anthropic-dangerous-direct-browser-access: true` header to allow a
// same-origin browser `fetch` at all (its default CORS policy assumes a
// server-side caller) — without it, every request is rejected before it
// reaches this feature's logic. This is exactly the "small bridge-free
// direct-API path" the Phase 4 sketch recommended.
//
// SECRET HYGIENE: `config.apiKeyRef` is read exactly once here, to set the
// `x-api-key` header. It is never interpolated into a thrown `CritiqueError`
// message, a log line, or the request body.
// ═══════════════════════════════════════════════════════════════════════════

import type { ReferenceCritiqueApiConfig } from '../model/settings';
import { parseDataUrl } from './dataUrl';
import { CritiqueError } from './errors';
import type { StillImage } from './types';

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 1024;

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

export interface AnthropicRequestSpec {
  url: string;
  init: RequestInit;
}

function textBlock(text: string): AnthropicTextBlock {
  return { type: 'text', text };
}

function imageBlock(still: StillImage): AnthropicImageBlock {
  const { mediaType, base64 } = parseDataUrl(still.dataUrl);
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
}

/**
 * Builds the exact `fetch(url, init)` call for one critique request. Pure —
 * no network access, no DOM — so the resulting request body can be
 * inspected directly in a test (e.g. to confirm it contains only extracted
 * stills, never a raw video source).
 */
export function buildAnthropicRequest(
  config: ReferenceCritiqueApiConfig,
  render: StillImage,
  references: StillImage[],
  prompt: string,
): AnthropicRequestSpec {
  const content: AnthropicContentBlock[] = [
    textBlock(prompt),
    textBlock(`Current render (${render.label}):`),
    imageBlock(render),
  ];
  for (const reference of references) {
    content.push(textBlock(`Reference (${reference.label}):`), imageBlock(reference));
  }

  return {
    url: ANTHROPIC_MESSAGES_URL,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKeyRef,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content }],
      }),
    },
  };
}

interface AnthropicMessageResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { type?: string; message?: string };
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as AnthropicMessageResponse;
    return body.error?.message ?? '';
  } catch {
    return '';
  }
}

/**
 * Calls the Anthropic Messages API and returns the model's raw text reply.
 * `fetchImpl` defaults to the global `fetch` but is always overridable —
 * `runCritique.test.ts`/`anthropicClient.test.ts` inject a mock so no test
 * in this repo ever makes a real HTTPS request.
 */
export async function callAnthropic(
  config: ReferenceCritiqueApiConfig,
  render: StillImage,
  references: StillImage[],
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!config.apiKeyRef || config.apiKeyRef.trim().length === 0) {
    throw new CritiqueError('missing-api-key', 'No Anthropic API key configured — add one in Project Settings.');
  }

  const { url, init } = buildAnthropicRequest(config, render, references, prompt);

  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new CritiqueError('network', 'Could not reach the Anthropic API — check your network connection.');
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new CritiqueError(
        'missing-api-key',
        'The Anthropic API rejected the configured API key — check it under Project Settings → Reference critique.',
      );
    }
    const detail = await readErrorDetail(response);
    throw new CritiqueError(
      'api-error',
      `The Anthropic API request failed (HTTP ${response.status}).${detail ? ` ${detail}` : ''}`,
    );
  }

  let body: AnthropicMessageResponse;
  try {
    body = (await response.json()) as AnthropicMessageResponse;
  } catch {
    throw new CritiqueError('parse', 'The Anthropic API returned a response that was not valid JSON.');
  }

  const text = body.content?.find((block) => block.type === 'text' && typeof block.text === 'string')?.text;
  if (!text) {
    throw new CritiqueError('parse', 'The Anthropic API returned no text content to parse.');
  }
  return text;
}
