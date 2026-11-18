import { copyProviderHistoryState } from '@/core/providers/providerHistory';

import { mergePersistedProviderState } from '../../../core/providers/providerState';
import type {
  ProviderConversationHistoryService,
  ProviderHistoryEnvironment,
  ProviderHistoryInput,
  ProviderHistoryUpdate,
} from '../../../core/providers/types';
import {
  buildPersistedCopilotProviderState,
  COPILOT_PROVIDER_STATE_KEYS,
  parseCopilotProviderState,
} from '../types';
import { resolveCopilotHome } from './CopilotHistoryPaths';
import { loadCopilotHistory, readCopilotHistoryRevision } from './CopilotHistoryStore';

/** Native history is Copilot's per-session `events.jsonl`; ACP load replay is not used for display. */
export class CopilotConversationHistoryService implements ProviderConversationHistoryService {
  async hydrateConversationHistory(
    input: ProviderHistoryInput,
    _vaultPath: string | null,
    pathContext?: ProviderHistoryEnvironment,
  ): Promise<ProviderHistoryUpdate> {
    const conversation = copyProviderHistoryState(input);
    const sessionId = conversation.sessionId;
    const copilotHome = pathContext ? resolveCopilotHome(pathContext.environment, pathContext.hostPlatform) : null;
    if (!sessionId || !copilotHome) return conversation;
    const messages = await loadCopilotHistory(copilotHome, sessionId);
    if (messages.length === 0) return conversation;
    conversation.messages = messages;
    const state = parseCopilotProviderState(conversation.providerState);
    // An event log under the live binding proves Copilot holds the conversation context.
    if (state.nativeConversationContextEstablished === false) {
      conversation.providerState = mergePersistedProviderState(
        conversation.providerState,
        COPILOT_PROVIDER_STATE_KEYS,
        buildPersistedCopilotProviderState({ ...state, nativeConversationContextEstablished: true }) as
          Record<string, unknown> | undefined,
      );
    }
    return conversation;
  }

  async readNativeHistoryRevision(
    conversation: ProviderHistoryInput,
    _vaultPath: string | null,
    pathContext?: ProviderHistoryEnvironment,
  ): Promise<string | null> {
    if (!conversation.sessionId || !pathContext) return null;
    const copilotHome = resolveCopilotHome(pathContext.environment, pathContext.hostPlatform);
    return copilotHome ? readCopilotHistoryRevision(copilotHome, conversation.sessionId) : null;
  }

  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null {
    return conversation?.sessionId ?? null;
  }

  isPendingForkConversation(): boolean {
    return false;
  }

  buildForkProviderState(): Record<string, unknown> {
    throw new Error('Copilot does not support forking conversations.');
  }

  buildPersistedProviderState(conversation: ProviderHistoryInput): Record<string, unknown> | undefined {
    return mergePersistedProviderState(
      conversation.providerState,
      COPILOT_PROVIDER_STATE_KEYS,
      buildPersistedCopilotProviderState(parseCopilotProviderState(conversation.providerState)) as Record<string, unknown> | undefined,
    );
  }
}
