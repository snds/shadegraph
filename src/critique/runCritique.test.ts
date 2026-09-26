import { describe, expect, it, vi } from 'vitest';

import type { ReferenceCritiqueApiConfig, ReferenceCritiqueMcpConfig } from '../model/settings';
import { CritiqueError } from './errors';
import { runCritique } from './runCritique';
import type { StillImage } from './types';

const render: StillImage = { dataUrl: 'data:image/png;base64,AAAA', label: 'Current render' };
const reference: StillImage = { dataUrl: 'data:image/png;base64,BBBB', label: 'ref.png' };
const secretApiKey = 'sk-ant-super-secret-do-not-leak';

describe('runCritique', () => {
  it('throws missing-api-key when no provider is configured, without calling the provider', async () => {
    const call = vi.fn();
    await expect(runCritique({ config: undefined, render, references: [reference] }, { call })).rejects.toBeInstanceOf(
      CritiqueError,
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('throws a specific error for the unimplemented mcp provider, without calling the provider', async () => {
    const mcpConfig: ReferenceCritiqueMcpConfig = { provider: 'mcp', mcpServerId: 'local' };
    const call = vi.fn();
    await expect(runCritique({ config: mcpConfig, render, references: [reference] }, { call })).rejects.toMatchObject({
      kind: 'missing-api-key',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('throws missing-reference when no reference stills are given, without calling the provider', async () => {
    const apiConfig: ReferenceCritiqueApiConfig = { provider: 'api', apiKeyRef: secretApiKey };
    const call = vi.fn();
    await expect(runCritique({ config: apiConfig, render, references: [] }, { call })).rejects.toMatchObject({
      kind: 'missing-reference',
    });
    expect(call).not.toHaveBeenCalled();
  });

  it('calls the injected provider with the given config/render/references/prompt and parses its reply', async () => {
    const apiConfig: ReferenceCritiqueApiConfig = { provider: 'api', apiKeyRef: secretApiKey, model: 'claude-sonnet-5' };
    const call = vi.fn(async () => '```json\n{"verdict": "pass", "reasoning": "Matches well."}\n```');

    const result = await runCritique({ config: apiConfig, render, references: [reference], prompt: 'custom rubric' }, { call });

    expect(result).toEqual({
      verdict: 'pass',
      reasoning: 'Matches well.',
      raw: '```json\n{"verdict": "pass", "reasoning": "Matches well."}\n```',
    });
    expect(call).toHaveBeenCalledWith(apiConfig, render, [reference], 'custom rubric');
  });

  it('uses the default prompt when none is supplied', async () => {
    const apiConfig: ReferenceCritiqueApiConfig = { provider: 'api', apiKeyRef: secretApiKey };
    const call = vi.fn(async (_c: ReferenceCritiqueApiConfig, _r: StillImage, _refs: StillImage[], prompt: string) => {
      void prompt;
      return '{"verdict": "unclear", "reasoning": "n/a"}';
    });
    await runCritique({ config: apiConfig, render, references: [reference] }, { call });
    const promptArg = call.mock.calls[0][3];
    expect(typeof promptArg).toBe('string');
    expect(promptArg.length).toBeGreaterThan(0);
  });

  it('propagates a provider-thrown CritiqueError without ever including the api key in its message', async () => {
    const apiConfig: ReferenceCritiqueApiConfig = { provider: 'api', apiKeyRef: secretApiKey };
    const call = vi.fn(async () => {
      throw new CritiqueError('missing-api-key', 'The Anthropic API rejected the configured API key.');
    });
    try {
      await runCritique({ config: apiConfig, render, references: [reference] }, { call });
      throw new Error('expected runCritique to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CritiqueError);
      expect((err as CritiqueError).message).not.toContain(secretApiKey);
    }
  });
});
