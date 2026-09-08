// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique: data-URL parsing
// ───────────────────────────────────────────────────────────────────────────
// Pure, DOM-free string parsing — `StillImage.dataUrl` → the
// `{ mediaType, base64 }` pair the Anthropic Messages API's image content
// block wants. Split out from `anthropicClient.ts` purely so it is trivial
// to unit test in isolation.
// ═══════════════════════════════════════════════════════════════════════════

import { CritiqueError } from './errors';

export interface ParsedDataUrl {
  mediaType: string;
  base64: string;
}

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.+)$/s;

export function parseDataUrl(dataUrl: string): ParsedDataUrl {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    throw new CritiqueError('invalid-still', 'Expected a base64-encoded data URL (e.g. from canvas.toDataURL()).');
  }
  const [, mediaType, base64] = match;
  return { mediaType, base64 };
}
