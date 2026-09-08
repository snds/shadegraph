// ═══════════════════════════════════════════════════════════════════════════
// ShadeGraph — Reference critique: image reference loading
// ───────────────────────────────────────────────────────────────────────────
// Turns an already-loaded `blob:` object URL — exactly what
// `useAssetStore.loadPreview` already produces for an image-kind
// `AssetTreeNode` (see `src/storage/assetStore.ts`) — into a `StillImage`
// data URL, ready for `runCritique`.
//
// `fetch()` on a `blob:` URL resolves ENTIRELY IN-PROCESS: the browser hands
// back bytes it already holds for that object URL (from
// `FileSystemFileHandle.getFile()`, per `src/storage/`'s own contract), no
// network request is ever issued for a `blob:` scheme. So this function
// never sends anything over the wire itself — it only re-encodes a file
// that is already local, in memory the asset store already owns, into the
// one shape (`StillImage`) `anthropicClient.ts` knows how to serialize into
// the ONE outbound request `runCritique` eventually makes.
//
// Thin, browser-API glue (fetch + FileReader) — deliberately NOT unit
// tested here, mirroring `captureMainViewerStill` in `screenshot.ts`: the
// logic worth testing (data-URL parsing, request construction) lives in
// `dataUrl.ts`/`anthropicClient.ts`, already covered independently.
// ═══════════════════════════════════════════════════════════════════════════

import { CritiqueError } from './errors';
import type { StillImage } from './types';

export async function loadImageStill(objectUrl: string, label: string): Promise<StillImage> {
  let blob: Blob;
  try {
    const response = await fetch(objectUrl);
    blob = await response.blob();
  } catch {
    throw new CritiqueError('invalid-still', 'Could not read the selected reference image.');
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new CritiqueError('invalid-still', 'Could not decode the selected reference image.'));
    reader.readAsDataURL(blob);
  });

  return { dataUrl, label };
}
