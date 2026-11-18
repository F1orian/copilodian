// @test-ci {"inputs":["tests/fixtures/providers/copilot/runtime/**"]}
import sessionConfigOptions from '@test/fixtures/providers/copilot/runtime/session-config-options.json';

import type { ACPSessionConfigOption } from '@/providers/acp';
import {
  mergeCopilotModels,
  readCopilotSessionModels,
  resolveCopilotDefaultReasoning,
} from '@/providers/copilot/models';

const captured = sessionConfigOptions as ACPSessionConfigOption[];

describe('Copilot models', () => {
  it('reads the advertised models with reasoning levels for the current model only', () => {
    expect(readCopilotSessionModels(captured)).toEqual({
      currentModelId: 'claude-sonnet-4.6',
      models: [
        { displayName: 'Auto', rawId: 'auto', reasoningEfforts: [] },
        {
          displayName: 'claude-sonnet-4-6',
          rawId: 'claude-sonnet-4.6',
          reasoningEfforts: ['Low', 'Medium', 'High', 'Max'].map(label => ({ label, value: label.toLowerCase() })),
        },
      ],
    });
  });

  it('keeps known levels for models a newer report does not describe, and drops models it no longer lists', () => {
    const known = [
      { displayName: 'GPT', rawId: 'gpt', reasoningEfforts: [{ label: 'High', value: 'high' }] },
      { displayName: 'Old', rawId: 'old', reasoningEfforts: [{ label: 'Low', value: 'low' }] },
    ];
    expect(mergeCopilotModels(known, [
      { displayName: 'GPT 2', rawId: 'gpt', reasoningEfforts: [] },
      { displayName: 'New', rawId: 'new', reasoningEfforts: [] },
    ])).toEqual([
      { displayName: 'GPT 2', rawId: 'gpt', reasoningEfforts: [{ label: 'High', value: 'high' }] },
      { displayName: 'New', rawId: 'new', reasoningEfforts: [] },
    ]);
  });

  it('defaults to High, or to no override when a model lacks High', () => {
    const model = (values: string[]) => ({ displayName: 'm', rawId: 'm', reasoningEfforts: values.map(value => ({ label: value, value })) });
    expect(resolveCopilotDefaultReasoning(model(['low', 'medium', 'high', 'max']))).toBe('high');
    expect(resolveCopilotDefaultReasoning(model(['low', 'medium', 'high']), 'low')).toBe('low');
    expect(resolveCopilotDefaultReasoning(model(['low', 'medium']))).toBe('');
  });
});
