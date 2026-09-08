import { describe, expect, it } from 'vitest';

import { CritiqueError } from './errors';
import { extractVideoStills, type OffscreenCanvasLike, type OffscreenVideoLike, type VideoFrameExtractorDeps } from './videoFrames';

type MediaEventType = 'loadedmetadata' | 'seeked' | 'error';

interface FakeVideoOptions {
  videoWidth?: number;
  videoHeight?: number;
  failLoad?: boolean;
  failSeekAt?: number;
}

function createFakeVideo(opts: FakeVideoOptions = {}): OffscreenVideoLike & { currentTimes: number[] } {
  let loadedListeners: Array<() => void> = [];
  let seekedListeners: Array<() => void> = [];
  let errorListeners: Array<() => void> = [];
  let src = '';
  let currentTimeValue = 0;
  const currentTimes: number[] = [];

  return {
    muted: false,
    preload: '',
    videoWidth: opts.videoWidth ?? 640,
    videoHeight: opts.videoHeight ?? 360,
    currentTimes,
    get src() {
      return src;
    },
    set src(value: string) {
      src = value;
      if (value === '') return; // the extractor's own end-of-run cleanup, not a "load"
      queueMicrotask(() => {
        if (opts.failLoad) errorListeners.forEach((l) => l());
        else loadedListeners.forEach((l) => l());
      });
    },
    get currentTime() {
      return currentTimeValue;
    },
    set currentTime(value: number) {
      currentTimeValue = value;
      currentTimes.push(value);
      queueMicrotask(() => {
        if (opts.failSeekAt !== undefined && value === opts.failSeekAt) errorListeners.forEach((l) => l());
        else seekedListeners.forEach((l) => l());
      });
    },
    addEventListener(type: MediaEventType, listener: () => void) {
      if (type === 'loadedmetadata') loadedListeners.push(listener);
      else if (type === 'seeked') seekedListeners.push(listener);
      else errorListeners.push(listener);
    },
    removeEventListener(type: MediaEventType, listener: () => void) {
      if (type === 'loadedmetadata') loadedListeners = loadedListeners.filter((l) => l !== listener);
      else if (type === 'seeked') seekedListeners = seekedListeners.filter((l) => l !== listener);
      else errorListeners = errorListeners.filter((l) => l !== listener);
    },
  };
}

function createFakeCanvas(): OffscreenCanvasLike & { drawCalls: Array<{ source: unknown }> } {
  const drawCalls: Array<{ source: unknown }> = [];
  let calls = 0;
  return {
    width: 0,
    height: 0,
    drawCalls,
    getContext(id: '2d') {
      if (id !== '2d') return null;
      return {
        drawImage(source: unknown) {
          drawCalls.push({ source });
        },
      };
    },
    toDataURL(type?: string) {
      calls += 1;
      return `data:${type ?? 'image/png'};base64,FRAME_${calls}`;
    },
  };
}

describe('extractVideoStills', () => {
  it('throws missing-reference when no timestamps are given', async () => {
    const deps: VideoFrameExtractorDeps = { createVideo: () => createFakeVideo(), createCanvas: () => createFakeCanvas() };
    await expect(extractVideoStills('blob:local-video', [], deps)).rejects.toThrow(CritiqueError);
  });

  it('seeks to each configured timestamp, in order, and returns one still per timestamp', async () => {
    const video = createFakeVideo();
    const canvas = createFakeCanvas();
    const stills = await extractVideoStills('blob:local-video', [0, 1.5, 3], {
      createVideo: () => video,
      createCanvas: () => canvas,
    });
    expect(video.currentTimes).toEqual([0, 1.5, 3]);
    expect(stills).toHaveLength(3);
    expect(stills.every((s) => s.dataUrl.startsWith('data:image/png;base64,'))).toBe(true);
    expect(stills[1].label).toContain('1.50');
  });

  it('sizes the offscreen canvas from the video element natural dimensions', async () => {
    const video = createFakeVideo({ videoWidth: 1280, videoHeight: 720 });
    const canvas = createFakeCanvas();
    await extractVideoStills('blob:local-video', [0], { createVideo: () => video, createCanvas: () => canvas });
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
  });

  it('rejects with a CritiqueError if the video fails to load metadata', async () => {
    const video = createFakeVideo({ failLoad: true });
    const canvas = createFakeCanvas();
    await expect(
      extractVideoStills('blob:local-video', [0], { createVideo: () => video, createCanvas: () => canvas }),
    ).rejects.toThrow(CritiqueError);
  });

  it('rejects with a CritiqueError if a seek fails partway through', async () => {
    const video = createFakeVideo({ failSeekAt: 2 });
    const canvas = createFakeCanvas();
    await expect(
      extractVideoStills('blob:local-video', [0, 2], { createVideo: () => video, createCanvas: () => canvas }),
    ).rejects.toThrow(CritiqueError);
  });

  it('draws the video ELEMENT (not the source string) into the canvas each time', async () => {
    const video = createFakeVideo();
    const canvas = createFakeCanvas();
    await extractVideoStills('blob:local-video', [0, 1], { createVideo: () => video, createCanvas: () => canvas });
    expect(canvas.drawCalls).toHaveLength(2);
    expect(canvas.drawCalls[0].source).toBe(video);
    expect(canvas.drawCalls[1].source).toBe(video);
  });

  it('releases the video source once extraction finishes', async () => {
    const video = createFakeVideo();
    const canvas = createFakeCanvas();
    await extractVideoStills('blob:local-video', [0], { createVideo: () => video, createCanvas: () => canvas });
    expect(video.src).toBe('');
  });

  // The task's hard requirement: the network request must never receive raw
  // video bytes, only extracted stills. This test proves the video's own
  // source (a stand-in for "the raw video", since a real object URL is
  // backed by the actual file bytes) never ends up anywhere in what this
  // function returns — the only thing downstream code (anthropicClient.ts)
  // ever sees.
  it('never leaks the original video source into the returned stills', async () => {
    const secretVideoSrc = 'blob:http://localhost/super-secret-source-id';
    const video = createFakeVideo();
    const canvas = createFakeCanvas();
    const stills = await extractVideoStills(secretVideoSrc, [0, 1], {
      createVideo: () => video,
      createCanvas: () => canvas,
    });
    const serialized = JSON.stringify(stills);
    expect(serialized).not.toContain(secretVideoSrc);
    expect(serialized).not.toContain('super-secret-source-id');
  });
});
