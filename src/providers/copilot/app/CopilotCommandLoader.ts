import type { ProviderCommandDiscoveryResult } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import { loadRuntimeCommands } from '@/core/providers/commands/RuntimeCommandLoader';
import type {
  ProviderCommandLoader,
  ProviderCommandLoaderContext,
} from '@/core/providers/types';
import type { SlashCommand } from '@/core/types';
import { t } from '@/i18n/i18n';

import { filterCopilotCommands } from '../commands/CopilotCommandCatalog';
import { getCopilotProviderSettings } from '../settings';
import type { CopilotMetadataProbe } from './CopilotMetadataProbe';

export class CopilotCommandLoader implements ProviderCommandLoader {
  constructor(private readonly metadataProbe: Pick<CopilotMetadataProbe, 'load'>) {}

  getCacheFingerprint(settings: Record<string, unknown>): string {
    const current = getCopilotProviderSettings(settings);
    const configuredCli = current.cliPath.length > 0
      || Object.values(current.cliPathsByHost).some(path => path.trim().length > 0);
    return ['copilot:commands:v1', current.enabled ? 'enabled' : 'disabled', configuredCli ? 'configured-cli' : 'auto-cli'].join(':');
  }

  isAvailable(settings: Record<string, unknown>): boolean {
    return getCopilotProviderSettings(settings).enabled;
  }

  loadCommands(context: ProviderCommandLoaderContext): Promise<ProviderCommandDiscoveryResult<SlashCommand>> {
    return loadRuntimeCommands({
      allowIsolatedMetadataCreation: context.allowIsolatedMetadataCreation,
      discover: async signal => (await this.metadataProbe.load(signal)).commands,
      errorMessage: t('chat.copilot.commandsLoadFailed'),
      projectItems: commands => filterCopilotCommands(commands),
      readyCommandSnapshot: context.readyCommandSnapshot,
      requiresSessionMessage: t('chat.copilot.commandsNotLoaded'),
      signal: context.signal,
    });
  }
}
