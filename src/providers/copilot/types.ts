export interface CopilotProviderState {
  /** False until a new native session accepts its first prompt; until then history is replayed inline. */
  nativeConversationContextEstablished?: boolean;
}

export const COPILOT_PROVIDER_STATE_KEYS = ['nativeConversationContextEstablished'] as const;

export function parseCopilotProviderState(value: unknown): CopilotProviderState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return typeof record.nativeConversationContextEstablished === 'boolean'
    ? { nativeConversationContextEstablished: record.nativeConversationContextEstablished }
    : {};
}

export function buildPersistedCopilotProviderState(
  state: CopilotProviderState,
): CopilotProviderState | undefined {
  const persisted = parseCopilotProviderState(state);
  return Object.keys(persisted).length > 0 ? persisted : undefined;
}
