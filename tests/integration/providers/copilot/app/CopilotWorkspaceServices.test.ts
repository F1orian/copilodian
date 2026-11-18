import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { copilotConfigOptions, CopilotNativeProcess } from '@test/helpers/providers/copilot/CopilotNativeProcess';
import spawn from 'cross-spawn';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import {
  type CopilotWorkspaceServices,
  createCopilotWorkspaceServices,
} from '@/providers/copilot/app/CopilotWorkspaceServices';
import { copilotModelPolicy } from '@/providers/copilot/CopilotModelPolicy';
import { readCopilotSessionModels } from '@/providers/copilot/models';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

/** Part of the built-in list copilot 1.0.114 publishes for a new session. */
const COPILOT_COMMANDS = ['add-dir', 'allow-all', 'permissions', 'autopilot', 'compact', 'context', 'cwd', 'model', 'plan',
  'review', 'every', 'usage'].map(name => ({ description: `${name} command`, name }));

let host: ProviderHost;
let native: CopilotNativeProcess;
let services: CopilotWorkspaceServices;

beforeEach(async () => {
  ({ host } = await createProviderHostFixture({
    overrides: { getResolvedProviderCliPath: async () => 'copilot' },
    settings: { providerConfigs: { copilot: { enabled: true } } },
  }));
  native = new CopilotNativeProcess(['--acp', '--stdio']);
  native.newSessionId = 'session-probe';
  native.availableCommands = COPILOT_COMMANDS;
  native.addModel('gpt-5-mini', 'GPT-5 mini', ['low', 'medium', 'high']);
  native.addModel('claude-haiku-4.5', 'Claude Haiku 4.5');
  vi.mocked(spawn).mockReturnValue(native.child);
  services = await createCopilotWorkspaceServices(host);
});

afterEach(async () => {
  await services.dispose();
  vi.mocked(spawn).mockReset();
});

function levels(model: string): string[] {
  return copilotModelPolicy.getReasoningOptions(`copilot/${model}`, host.settings).map(option => option.value);
}

function loaderContext(): ProviderCommandLoaderContext {
  return { allowIsolatedMetadataCreation: true, conversation: null, plugin: host };
}

describe('Copilot workspace metadata discovery', () => {
  it('lists Copilot commands except those that conflict with Claudian controls', async () => {
    const result = await services.commandLoader!.loadCommands(loaderContext());

    if (result.status !== 'ready') throw new Error(`Expected ready commands, got ${result.status}`);
    expect(result.items.map(command => command.name)).toEqual(['compact', 'context', 'review', 'usage']);
    // The discovery session is closed without a prompt, so Copilot does not list it.
    expect(native.closeRequests).toEqual(['session-probe']);
    expect(native.prompts).toHaveLength(0);
  });

  it('selects each model on the discovery session to learn its reasoning levels', async () => {
    await services.modelCatalog!.refresh({ force: true });

    expect(services.modelCatalog!.getSnapshot().models.map(model => model.id))
      .toEqual(['auto', 'claude-sonnet-4.6', 'gpt-5-mini', 'claude-haiku-4.5']);
    expect(levels('claude-sonnet-4.6')).toEqual(['low', 'medium', 'high', 'max']);
    expect(levels('gpt-5-mini')).toEqual(['low', 'medium', 'high']);
    expect(levels('claude-haiku-4.5')).toEqual([]);
    expect(copilotModelPolicy.getDefaultReasoningValue('copilot/gpt-5-mini', host.settings)).toBe('high');
    // The current model already reported its levels; every other model was selected once.
    expect(native.configRequests.map(request => request.value)).toEqual(['auto', 'gpt-5-mini', 'claude-haiku-4.5']);
  });

  it('keeps levels learned for other models when a live session reports only its current model', async () => {
    await services.modelCatalog!.refresh({ force: true });
    // A live session running `auto`, which offers no reasoning option, describes no model's levels.
    const options = copilotConfigOptions()
      .filter(option => option.id !== 'reasoning_effort')
      .map(option => (option.id === 'model' && option.type === 'select' ? { ...option, currentValue: 'auto' } : option));
    const live = readCopilotSessionModels(options);

    await services.modelCatalogOwner.mergeLiveModels(live.models, null);

    // The live session advertises only the captured models; its report decides which models exist.
    expect(services.modelCatalog!.getSnapshot().models.map(model => model.id)).toEqual(['auto', 'claude-sonnet-4.6']);
    expect(levels('claude-sonnet-4.6')).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('does not start a discovery session once a live session has reported models', async () => {
    const live = readCopilotSessionModels(copilotConfigOptions());
    await services.modelCatalogOwner.mergeLiveModels(live.models, live.currentModelId);

    await services.modelCatalog!.refresh({ force: true });

    expect(spawn).not.toHaveBeenCalled();
    expect(copilotModelPolicy.getModelOptions(host.settings).map(option => option.value))
      .toEqual(['copilot/claude-sonnet-4.6', 'copilot/auto']);
  });
});
