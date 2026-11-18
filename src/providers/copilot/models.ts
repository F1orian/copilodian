import {
  DEFAULT_REASONING_VALUE,
  formatReasoningValueLabel,
} from '../../core/providers/reasoning';
import type { ACPSessionConfigOption, ACPSessionConfigSelectOption } from '../acp';

export interface CopilotReasoningEffort {
  label: string;
  value: string;
}

export interface CopilotModel {
  displayName: string;
  rawId: string;
  reasoningEfforts: CopilotReasoningEffort[];
}

export const COPILOT_MODEL_PREFIX = 'copilot/';
export const COPILOT_MODEL_CONFIG_ID = 'model';
/** Copilot names its effort option `reasoning_effort` (ACP category `thought_level`). */
export const COPILOT_REASONING_CONFIG_ID = 'reasoning_effort';
export const COPILOT_MODE_CONFIG_ID = 'mode';
export const COPILOT_ALLOW_ALL_CONFIG_ID = 'allow_all';
/** Copilot's native Agent mode; Claudian never selects Plan or Autopilot. */
export const COPILOT_AGENT_MODE = 'https://agentclientprotocol.com/protocol/session-modes#agent';

export function encodeCopilotModelId(rawModelId: string): string {
  const normalized = rawModelId.trim();
  if (!normalized || normalized === COPILOT_MODEL_PREFIX) return '';
  return normalized.startsWith(COPILOT_MODEL_PREFIX)
    ? normalized
    : `${COPILOT_MODEL_PREFIX}${normalized}`;
}

export function decodeCopilotModelId(model: string): string | null {
  const normalized = model.trim();
  if (!normalized.startsWith(COPILOT_MODEL_PREFIX)) return null;
  return normalized.slice(COPILOT_MODEL_PREFIX.length).trim() || null;
}

export function isCopilotModelSelectionId(model: string): boolean {
  return decodeCopilotModelId(model) !== null;
}

export function findCopilotModel(
  models: readonly CopilotModel[],
  modelId: string,
): CopilotModel | null {
  const rawId = decodeCopilotModelId(modelId) ?? modelId.trim();
  return rawId ? models.find(model => model.rawId === rawId) ?? null : null;
}

export function resolveCopilotDefaultReasoning(
  model: CopilotModel | null | undefined,
  preferred?: string,
): string {
  const values = model?.reasoningEfforts.map(effort => effort.value) ?? [];
  const normalized = preferred?.trim();
  if (normalized && values.includes(normalized)) return normalized;
  // Without High there is no default to choose; Copilot then keeps its own.
  return values.includes(DEFAULT_REASONING_VALUE) ? DEFAULT_REASONING_VALUE : '';
}

/**
 * The session's `model` select option is Copilot's authoritative list of model ids, names and the current model;
 * Copilot rejects ids it did not advertise. `reasoning_effort` describes only the current model, so other models
 * report no levels here; callers merge levels learned for them elsewhere.
 */
export function readCopilotSessionModels(
  configOptions: readonly ACPSessionConfigOption[] | null | undefined,
): { currentModelId: string | null; models: CopilotModel[] } {
  const modelOption = findSelectOption(configOptions, COPILOT_MODEL_CONFIG_ID);
  if (!modelOption) return { currentModelId: null, models: [] };
  const currentModelId = modelOption.currentValue || null;
  const sessionLevels = readCopilotReasoningLevels(configOptions);
  return {
    currentModelId,
    models: normalizeCopilotModels(flattenSelectOptions(modelOption.options).map(option => ({
      displayName: option.name,
      rawId: option.value,
      reasoningEfforts: option.value === currentModelId ? sessionLevels : [],
    }))),
  };
}

/** Reasoning levels the session offers for its current model; none for a fixed-effort model. */
export function readCopilotReasoningLevels(
  configOptions: readonly ACPSessionConfigOption[] | null | undefined,
): CopilotReasoningEffort[] {
  return flattenSelectOptions(findSelectOption(configOptions, COPILOT_REASONING_CONFIG_ID)?.options)
    .map(option => ({ label: formatReasoningValueLabel(option.value), value: option.value }));
}

export function readCopilotConfigValue(
  configOptions: readonly ACPSessionConfigOption[] | null | undefined,
  configId: string,
): string | null {
  return findSelectOption(configOptions, configId)?.currentValue ?? null;
}

/**
 * Combines a newer report with known models: the report decides which models exist and their order, while levels a
 * report does not describe (Copilot reports levels for the current model only) are kept from earlier reports.
 */
export function mergeCopilotModels(
  known: readonly CopilotModel[],
  reported: readonly CopilotModel[],
): CopilotModel[] {
  return reported.map(model => {
    if (model.reasoningEfforts.length > 0) return model;
    const previous = known.find(entry => entry.rawId === model.rawId);
    return previous ? { ...model, reasoningEfforts: previous.reasoningEfforts } : model;
  });
}

export function normalizeCopilotModels(value: unknown): CopilotModel[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, CopilotModel>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const rawId = readTrimmedString(entry.rawId);
    if (!rawId || byId.has(rawId)) continue;
    byId.set(rawId, {
      displayName: readTrimmedString(entry.displayName) || rawId,
      rawId,
      reasoningEfforts: normalizeEfforts(entry.reasoningEfforts),
    });
  }
  return [...byId.values()];
}

function normalizeEfforts(value: unknown): CopilotReasoningEffort[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const efforts: CopilotReasoningEffort[] = [];
  for (const entry of value) {
    const effort = isRecord(entry) ? readTrimmedString(entry.value) : '';
    if (!effort || seen.has(effort)) continue;
    seen.add(effort);
    efforts.push({
      label: (isRecord(entry) && readTrimmedString(entry.label)) || formatReasoningValueLabel(effort),
      value: effort,
    });
  }
  return efforts;
}

function findSelectOption(
  configOptions: readonly ACPSessionConfigOption[] | null | undefined,
  configId: string,
): Extract<ACPSessionConfigOption, { type: 'select' }> | null {
  const option = configOptions?.find(entry => entry.id === configId);
  return option?.type === 'select' ? option : null;
}

function flattenSelectOptions(
  options: Extract<ACPSessionConfigOption, { type: 'select' }>['options'] | undefined,
): ACPSessionConfigSelectOption[] {
  return (options ?? []).flatMap(option => ('options' in option ? option.options : [option]));
}

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
