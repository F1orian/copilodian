import type { ProviderCapabilities } from '../../core/providers/types';

/**
 * Copilot's ACP server has no fork, rewind or non-persistent sessions, and its handling of a prompt sent during a
 * running turn is unverified; those features stay off.
 */
export const COPILOT_PROVIDER_CAPABILITIES: Readonly<ProviderCapabilities> = Object.freeze({
  providerId: 'copilot',
  supportsResponseThroughput: false,
  supportsNativeHistory: true,
  supportsEphemeralSessions: false,
  supportsRewind: false,
  supportsFork: false,
  supportsProviderCommands: true,
  supportsImageAttachments: true,
  supportsTurnSteer: false,
  reasoningControl: 'effort',
});
