// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — asset storage: preview-kind detection
// ───────────────────────────────────────────────────────────────────────────
// Pure extension sniffing, deliberately dumb — good enough to decide whether
// a file gets an `<img>`/`<video>` preview at all. Not a MIME-sniffing or
// codec-support check.
// ═══════════════════════════════════════════════════════════════════════════

import type { PreviewKind } from './types';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']);

/** `undefined` for anything not recognized as previewable image/video. */
export function previewKindForName(name: string): PreviewKind | undefined {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return undefined;
  const ext = name.slice(dot + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return undefined;
}
