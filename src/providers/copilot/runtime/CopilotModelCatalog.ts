import { getInstallationKey } from '@/core/device/InstallationKey';

import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type { ProviderModelCatalogRefreshResult } from '../../../core/providers/types';
import { t } from '../../../i18n/i18n';
import type { CopilotMetadata } from '../app/CopilotMetadataProbe';
import {
  type CopilotCatalogSnapshot,
  decodeCopilotConfig,
  updateCopilotConfig,
} from '../config';
import { type CopilotModel, mergeCopilotModels } from '../models';
import { computeCopilotRuntimeInputHash } from './CopilotRuntimeEnvironment';

/**
 * Sole writer of the discovered catalog. Each report lists every model Copilot offers, which decides the catalog's
 * models and order; a live session reports reasoning levels only for its current model, so levels known for other
 * models are kept. Live sessions are preferred: the prompt-less discovery probe leaves an empty native session
 * directory behind, so it runs only while no live session has reported models for the current CLI and environment.
 */
export class CopilotModelCatalog {
  private disposed = false;
  /** Latest live report, retained so an unsuccessful settings write can be retried without probing. */
  private liveReport: { contextKey: string; models: CopilotModel[]; defaultModelId: string | null } | null = null;

  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly discover: (signal: AbortSignal) => Promise<CopilotMetadata>,
  ) {}

  async refresh(signal: AbortSignal): Promise<ProviderModelCatalogRefreshResult> {
    if (this.disposed || signal.aborted || !decodeCopilotConfig(this.host.config, this.host.selection).enabled) {
      return { changed: false };
    }
    const contextKey = this.#getContextKey();
    const live = this.liveReport;
    if (live?.contextKey === contextKey) return this.#persist(live.models, live.defaultModelId, contextKey, 'live', signal);
    const metadata = await this.discover(signal);
    if (metadata.models.length === 0) {
      return { changed: false, diagnostics: t('chat.copilot.noModels') };
    }
    return this.#persist(metadata.models, metadata.currentModelId, contextKey, 'probe', signal);
  }

  mergeLiveModels(models: CopilotModel[], defaultModelId: string | null): Promise<ProviderModelCatalogRefreshResult> {
    if (this.disposed || models.length === 0) return Promise.resolve({ changed: false });
    const contextKey = this.#getContextKey();
    this.liveReport = { contextKey, models, defaultModelId };
    return this.#persist(models, defaultModelId, contextKey, 'live');
  }

  dispose(): void {
    this.disposed = true;
  }

  async #persist(
    models: CopilotModel[],
    defaultModelId: string | null,
    contextKey: string,
    source: 'live' | 'probe',
    signal?: AbortSignal,
  ): Promise<ProviderModelCatalogRefreshResult> {
    let result: ProviderModelCatalogRefreshResult = { changed: false };
    await this.host.updateConfig((config, selection) => {
      const current = decodeCopilotConfig(config, selection);
      // Reports from a superseded CLI or environment must not overwrite the current catalog.
      if (this.disposed || signal?.aborted || computeCopilotRuntimeInputHash(current, this.host.environmentText) !== contextKey) {
        return false;
      }
      // A probe started before a live report must not replace it when it finishes later.
      if (source === 'probe' && this.liveReport?.contextKey === contextKey) return false;
      const previous = current.currentCatalog;
      const next: CopilotCatalogSnapshot = {
        defaultModelId: defaultModelId ?? previous?.defaultModelId ?? null,
        models: mergeCopilotModels(previous?.models ?? [], models),
        refreshedAt: Date.now(),
      };
      const changed = JSON.stringify([previous?.defaultModelId, previous?.models]) !== JSON.stringify([next.defaultModelId, next.models]);
      if (!changed) return false;
      updateCopilotConfig(config, selection, {
        catalogsByHost: { ...current.catalogsByHost, [getInstallationKey()]: next },
      });
      result = { changed: true, persistedSettingsChanged: true };
      return true;
    });
    if (result.changed) this.host.notifyChatOptionsChanged();
    return result;
  }

  #getContextKey(): string {
    return computeCopilotRuntimeInputHash(
      decodeCopilotConfig(this.host.config, this.host.selection),
      this.host.environmentText,
    );
  }
}
