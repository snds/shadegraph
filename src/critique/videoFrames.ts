// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique: video reference → extracted still frames
// ───────────────────────────────────────────────────────────────────────────
// Implements the sketch's settled video-reference pattern exactly (see the
// "Asset folder handling" addendum): an OFFSCREEN (never appended to the
// DOM, never played) `<video>`, seeked to N configurable timestamps, each
// frame captured to an OFFSCREEN `<canvas>` on the `seeked` event and
// extracted as a still image, then discarded.
//
// HARD REQUIREMENT, verified by construction here: the network request must
// never receive raw video bytes, only extracted stills.
//   - `extractVideoStills` takes `videoSrc` (the asset store's local
//     `blob:` object URL for the reference file — see
//     `src/storage/assetStore.ts`'s `loadPreview`) and returns
//     `StillImage[]` — plain `{ dataUrl, label }` values holding ONLY the
//     small base64 PNG each `canvas.toDataURL()` call produces.
//   - `videoSrc` itself is used exactly once, to set `video.src` locally so
//     the browser's own (local, disk/memory-backed) media pipeline can
//     decode individual frames on seek — it is never read, copied, or
//     returned by this function, and never appears anywhere in its return
//     value. There is no code path in this module that could put the video
//     source (or the video element itself) into the returned `StillImage[]`.
//   - `anthropicClient.ts`'s `buildAnthropicRequest` only ever receives this
//     return value (`StillImage[]`), never `videoSrc` — see that module and
//     `videoFrames.test.ts` / `anthropicClient.test.ts` for tests that
//     inspect the exact constructed request body and assert the original
//     video source string is absent from it.
//
// `VideoFrameExtractorDeps` is the injectable seam (same pattern as
// `DirectoryReader`/`HandleStore` in `src/storage/types.ts`): a real
// implementation creates real, unmounted DOM elements; a test implementation
// is a synchronous in-memory fake, so this whole pipeline is unit-testable
// without a real video decoder (none exists in this repo's Node test
// environment).
// ═══════════════════════════════════════════════════════════════════════════

import { CritiqueError } from './errors';
import type { StillImage } from './types';

type MediaEventType = 'loadedmetadata' | 'seeked' | 'error';

/** The minimal `HTMLVideoElement` slice this module needs. A real
 *  `HTMLVideoElement` satisfies this structurally; a test fake can implement
 *  just this much. */
export interface OffscreenVideoLike {
  muted: boolean;
  preload: string;
  src: string;
  currentTime: number;
  readonly videoWidth: number;
  readonly videoHeight: number;
  addEventListener(type: MediaEventType, listener: () => void): void;
  removeEventListener(type: MediaEventType, listener: () => void): void;
}

/** The minimal offscreen-canvas-2d slice this module needs. `source` on
 *  `drawImage` is deliberately `unknown`, not `CanvasImageSource` — this
 *  interface exists to be satisfied by BOTH a real `HTMLCanvasElement`'s
 *  `getContext('2d')` result and a plain test fake holding a fabricated
 *  "video" object that is not itself a real `HTMLVideoElement`. */
export interface OffscreenCanvasLike {
  width: number;
  height: number;
  getContext(id: '2d'): { drawImage(source: unknown, dx: number, dy: number, dw: number, dh: number): void } | null;
  toDataURL(type?: string): string;
}

export interface VideoFrameExtractorDeps {
  createVideo(): OffscreenVideoLike;
  createCanvas(): OffscreenCanvasLike;
}

/** Real, browser-backed deps: plain, never-mounted `<video>`/`<canvas>`
 *  elements. Kept separate from `extractVideoStills` itself so the
 *  extraction/seek/draw logic stays testable without a DOM — only this one
 *  factory function ever touches `document.createElement`. */
export function createBrowserVideoFrameExtractorDeps(): VideoFrameExtractorDeps {
  return {
    createVideo: () => document.createElement('video'),
    createCanvas: () => document.createElement('canvas'),
  };
}

function waitForEvent(
  target: Pick<OffscreenVideoLike, 'addEventListener' | 'removeEventListener'>,
  successType: MediaEventType,
  errorMessage: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new CritiqueError('invalid-still', errorMessage));
    };
    function cleanup() {
      target.removeEventListener(successType, onSuccess);
      target.removeEventListener('error', onError);
    }
    target.addEventListener(successType, onSuccess);
    target.addEventListener('error', onError);
  });
}

/**
 * Seeks an offscreen `video` (loaded from the LOCAL `videoSrc`, typically a
 * `blob:` object URL already held by the asset store) to each of
 * `timestamps` in order, capturing a still frame at each via an offscreen
 * canvas. Returns one `StillImage` per timestamp, in the same order.
 *
 * Never buffers or returns the source video itself — see this file's header
 * comment for exactly what "never raw video bytes" means here.
 */
export async function extractVideoStills(
  videoSrc: string,
  timestamps: number[],
  deps: VideoFrameExtractorDeps,
  labelFor: (index: number, timestampSeconds: number) => string = (_i, t) => `Reference frame @ ${t.toFixed(2)}s`,
): Promise<StillImage[]> {
  if (timestamps.length === 0) {
    throw new CritiqueError('missing-reference', 'No sample timestamps configured for the reference video.');
  }

  const video = deps.createVideo();
  const loaded = waitForEvent(video, 'loadedmetadata', 'Could not load the reference video for frame extraction.');
  video.muted = true;
  video.preload = 'auto';
  video.src = videoSrc;
  await loaded;

  const canvas = deps.createCanvas();
  canvas.width = video.videoWidth || 512;
  canvas.height = video.videoHeight || 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new CritiqueError('invalid-still', 'Could not acquire a 2D drawing context for frame extraction.');
  }

  const stills: StillImage[] = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const timestampSeconds = timestamps[i];
    const seeked = waitForEvent(video, 'seeked', `Failed to seek the reference video to ${timestampSeconds}s.`);
    video.currentTime = timestampSeconds;
    await seeked;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    stills.push({ dataUrl, label: labelFor(i, timestampSeconds) });
  }

  // Release the decoder eagerly rather than waiting for GC — this element
  // was never appended to the DOM, so nothing else references it once this
  // function returns.
  video.src = '';

  return stills;
}
