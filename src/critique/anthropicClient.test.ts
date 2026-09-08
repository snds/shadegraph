import { describe, expect, it, vi } from 'vitest';

import type { ReferenceCritiqueApiConfig } from '../model/settings';
import { extractVideoStills, type OffscreenCanvasLike, type OffscreenVideoLike, type VideoFrameExtractorDeps } from './videoFrames';
import { ANTHROPIC_MESSAGES_URL, buildAnthropicRequest, callAnthropic } from './anthropicClient';
import { CritiqueError } from './errors';
import type { StillImage } from './types';

const config: ReferenceCritiqueApiConfig = { provider: 'api', apiKeyRef: 'sk-ant-test-key-do-not-log', model: 'claude-sonnet-4-5' };
const render: StillImage = { dataUrl: 'data:image/png;base64,UkVOREVSREFUQQ==', label: 'Current render' };
const reference: StillImage = { dataUrl: 'data:image/png;base64,UkVGRVJFTkNFREFUQQ==', label: 'ref.png' };

function parseBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe('buildAnthropicRequest', () => {
  it('targets the Anthropic Messages endpoint with the required headers', () => {
    const spec = buildAnthropicRequest(config, render, [reference], 'Judge this.');
    expect(spec.url).toBe(ANTHROPIC_MESSAGES_URL);
    const headers = spec.init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(config.apiKeyRef);
    expect(headers['anthropic-version']).toBeTruthy();
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
  });

  it('uses the configured model, falling back to a default when unset', () => {
    const withModel = parseBody(buildAnthropicRequest(config, render, [], 'p').init);
    expect(withModel.model).toBe('claude-sonnet-4-5');

    const noModelConfig: ReferenceCritiqueApiConfig = { provider: 'api', apiKeyRef: 'k' };
    const withoutModel = parseBody(buildAnthropicRequest(noModelConfig, render, [], 'p').init);
    expect(typeof withoutModel.model).toBe('string');
    expect((withoutModel.model as string).length).toBeGreaterThan(0);
  });

  it('includes the render and every reference as base64 image blocks, plus the prompt text', () => {
    const body = parseBody(buildAnthropicRequest(config, render, [reference], 'Rubric text here').init);
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const content = messages[0].content;

    const imageBlocks = content.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(2); // render + one reference
    expect((imageBlocks[0].source as Record<string, unknown>).data).toBe('UkVOREVSREFUQQ==');
    expect((imageBlocks[1].source as Record<string, unknown>).data).toBe('UkVGRVJFTkNFREFUQQ==');

    const textBlocks = content.filter((b) => b.type === 'text');
    expect(textBlocks.some((b) => (b.text as string).includes('Rubric text here'))).toBe(true);
  });

  it('never includes the raw apiKeyRef anywhere in the serialized request body', () => {
    const spec = buildAnthropicRequest(config, render, [reference], 'p');
    expect(spec.init.body as string).not.toContain(config.apiKeyRef);
  });

  // The task's hard requirement, verified end-to-end from a fabricated video
  // source through frame extraction and into the exact request this module
  // constructs: the network request body contains only extracted stills'
  // base64 data, never the original video source.
  it('end-to-end: a video reference source never appears in the constructed request body — only its extracted stills do', async () => {
    const secretVideoSrc = 'blob:http://localhost/do-not-leak-this-video-source';
    const stills = await extractVideoStills(secretVideoSrc, [0, 1], createFakeVideoDeps());

    const spec = buildAnthropicRequest(config, render, stills, 'p');
    const serializedBody = spec.init.body as string;

    expect(serializedBody).not.toContain(secretVideoSrc);
    expect(serializedBody).not.toContain('do-not-leak-this-video-source');

    // The stills' own extracted pixel data DOES show up, proving the request
    // carries real image content — just never the video source string.
    const body = parseBody(spec.init);
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const imageBlocks = messages[0].content.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(3); // render + 2 extracted frames
  });
});

function createFakeVideoDeps(): VideoFrameExtractorDeps {
  let loaded: Array<() => void> = [];
  let seeked: Array<() => void> = [];
  let frame = 0;
  let src = '';
  let currentTimeValue = 0;
  const video: OffscreenVideoLike = {
    muted: false,
    preload: '',
    videoWidth: 64,
    videoHeight: 64,
    get src() {
      return src;
    },
    set src(value: string) {
      src = value;
      queueMicrotask(() => loaded.forEach((l) => l()));
    },
    get currentTime() {
      return currentTimeValue;
    },
    set currentTime(value: number) {
      currentTimeValue = value;
      queueMicrotask(() => seeked.forEach((l) => l()));
    },
    addEventListener(type, listener) {
      if (type === 'loadedmetadata') loaded.push(listener);
      if (type === 'seeked') seeked.push(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'loadedmetadata') loaded = loaded.filter((l) => l !== listener);
      if (type === 'seeked') seeked = seeked.filter((l) => l !== listener);
    },
  };
  const canvas: OffscreenCanvasLike = {
    width: 0,
    height: 0,
    getContext: (id: '2d') => (id === '2d' ? { drawImage: () => {} } : null),
    toDataURL: () => {
      frame += 1;
      return `data:image/png;base64,FRAME_${frame}`;
    },
  };
  return { createVideo: () => video, createCanvas: () => canvas };
}

describe('callAnthropic', () => {
  it('throws missing-api-key without calling fetch when the config has no key', async () => {
    const noKey: ReferenceCritiqueApiConfig = { provider: 'api', apiKeyRef: '' };
    const fetchImpl = vi.fn();
    await expect(callAnthropic(noKey, render, [reference], 'p', fetchImpl)).rejects.toMatchObject({ kind: 'missing-api-key' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('parses the model text reply from a successful response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'looks good' }] }), { status: 200 }));
    const text = await callAnthropic(config, render, [reference], 'p', fetchImpl as unknown as typeof fetch);
    expect(text).toBe('looks good');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps a 401 response to a missing-api-key CritiqueError without echoing the key', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 }));
    try {
      await callAnthropic(config, render, [reference], 'p', fetchImpl as unknown as typeof fetch);
      throw new Error('expected callAnthropic to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CritiqueError);
      expect((err as CritiqueError).kind).toBe('missing-api-key');
      expect((err as CritiqueError).message).not.toContain(config.apiKeyRef);
    }
  });

  it('maps a non-401/403 failure response to an api-error CritiqueError', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 529 }));
    await expect(callAnthropic(config, render, [reference], 'p', fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      kind: 'api-error',
    });
  });

  it('maps a network-level fetch rejection to a network CritiqueError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(callAnthropic(config, render, [reference], 'p', fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('throws a parse CritiqueError when the response has no text content block', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ content: [] }), { status: 200 }));
    await expect(callAnthropic(config, render, [reference], 'p', fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      kind: 'parse',
    });
  });
});
