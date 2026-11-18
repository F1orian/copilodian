import type {
  ProviderModelPolicy,
  ProviderUIOption,
} from '../../core/providers/types';
import { getOrderedCopilotVisibleModelIds } from './config';
import {
  type CopilotModel,
  decodeCopilotModelId,
  encodeCopilotModelId,
  findCopilotModel,
  isCopilotModelSelectionId,
  resolveCopilotDefaultReasoning,
} from './models';
import { COPILOT_PERMISSION_MODE_POLICY } from './permissionModes';
import {
  COPILOT_PROVIDER_ID,
  getCopilotProviderSettings,
  updateCopilotProviderSettings,
} from './settings';

export const copilotModelPolicy: ProviderModelPolicy = {
  permissionModes: COPILOT_PERMISSION_MODE_POLICY,

  getModelOptions(settings): ProviderUIOption[] {
    const current = getCopilotProviderSettings(settings);
    const catalogModels = current.currentCatalog?.models ?? [];
    const options: ProviderUIOption[] = [];
    for (const rawId of getOrderedCopilotVisibleModelIds(current)) {
      const model = catalogModels.find(entry => entry.rawId === rawId);
      const value = encodeCopilotModelId(rawId);
      if (!model || options.some(option => option.value === value)) continue;
      options.push({
        label: Object.hasOwn(current.modelAliases, rawId) ? current.modelAliases[rawId] : model.displayName,
        value,
      });
    }
    return options;
  },

  getDefaultModel(settings): string | null {
    const current = getCopilotProviderSettings(settings);
    const rawId = getOrderedCopilotVisibleModelIds(current)
      .find(id => current.currentCatalog?.models.some(model => model.rawId === id));
    return rawId ? encodeCopilotModelId(rawId) : null;
  },

  ownsModel(model): boolean {
    return isCopilotModelSelectionId(model);
  },

  supportsReasoningEffort(model, settings): boolean {
    return (getSelectedModel(model, settings)?.reasoningEfforts.length ?? 0) > 0;
  },

  getReasoningOptions(model, settings): ProviderUIOption[] {
    return (getSelectedModel(model, settings)?.reasoningEfforts ?? [])
      .map(effort => ({ label: effort.label, value: effort.value }));
  },

  getDefaultReasoningValue(model, settings): string {
    const rawId = decodeCopilotModelId(model);
    const selected = getSelectedModel(model, settings);
    if (!rawId || !selected) return '';
    const preferred = getCopilotProviderSettings(settings).preferredReasoningByModel;
    return resolveCopilotDefaultReasoning(selected, Object.hasOwn(preferred, rawId) ? preferred[rawId] : undefined);
  },

  isDefaultModel(): boolean {
    return false;
  },

  applyModelDefaults(model, settings): void {
    if (!isRecord(settings)) return;
    const normalized = normalizeSelection(model);
    if (!isCopilotModelSelectionId(normalized)) return;
    clearSavedEffortProjection(settings);
    settings.model = normalized;
    settings.effortLevel = this.getDefaultReasoningValue(normalized, settings);
  },

  applyModelProjectionDefaults(model, settings): void {
    if (!isRecord(settings)) return;
    clearSavedEffortProjection(settings);
    if (!decodeCopilotModelId(model)) {
      delete settings.effortLevel;
      return;
    }
    settings.effortLevel = this.getDefaultReasoningValue(model, settings);
  },

  applyReasoningSelection(model, value, settings): void {
    if (!isRecord(settings)) return;
    const rawId = decodeCopilotModelId(model);
    if (!rawId) {
      clearSavedEffortProjection(settings);
      delete settings.effortLevel;
      return;
    }
    const supported = new Set(getSelectedModel(model, settings)?.reasoningEfforts.map(effort => effort.value) ?? []);
    const preferredReasoningByModel = { ...getCopilotProviderSettings(settings).preferredReasoningByModel };
    if (supported.has(value)) {
      Object.defineProperty(preferredReasoningByModel, rawId, { value, enumerable: true, writable: true, configurable: true });
    } else {
      delete preferredReasoningByModel[rawId];
    }
    updateCopilotProviderSettings(settings, { preferredReasoningByModel });
  },

  normalizeModelVariant(model): string {
    return normalizeSelection(model);
  },
};

/** Only enabled models resolve; a selection missing from the catalog has no reasoning options. */
function getSelectedModel(model: string, settings: Record<string, unknown>): CopilotModel | null {
  const rawId = decodeCopilotModelId(model);
  if (!rawId) return null;
  const current = getCopilotProviderSettings(settings);
  const catalogModels = current.currentCatalog?.models ?? [];
  const visible = current.visibleModels ?? catalogModels.map(entry => entry.rawId);
  if (!visible.includes(rawId)) return null;
  return findCopilotModel(catalogModels, rawId) ?? { displayName: rawId, rawId, reasoningEfforts: [] };
}

function normalizeSelection(model: string): string {
  const rawId = decodeCopilotModelId(model);
  return rawId ? encodeCopilotModelId(rawId) : model;
}

function clearSavedEffortProjection(settings: Record<string, unknown>): void {
  if (isRecord(settings.savedProviderEffort)) delete settings.savedProviderEffort[COPILOT_PROVIDER_ID];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
