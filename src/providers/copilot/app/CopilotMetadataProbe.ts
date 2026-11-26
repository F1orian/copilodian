import { OwnedProbeRegistry } from '@/core/providers/metadata/OwnedProbeRegistry';
import { ProviderTransitionFence } from '@/core/providers/metadata/ProviderTransitionFence';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import type { SlashCommand } from '@/core/types';
import {
  type ACPSessionNotification,
  CANCELLED_ACP_PERMISSION_RESPONSE,
  normalizeACPAvailableCommands,
} from '@/providers/acp';

import { COPILOT_ACP_ARGS, CopilotNativeConnection } from '../execution/CopilotNativeConnection';
import {
  COPILOT_MODEL_CONFIG_ID,
  type CopilotModel,
  readCopilotReasoningLevels,
  readCopilotSessionModels,
} from '../models';
import { resolveCopilotLaunchSpec } from '../runtime/CopilotExecutionContext';

export interface CopilotMetadata {
  readonly commands: SlashCommand[];
  readonly currentModelId: string | null;
  readonly models: CopilotModel[];
}

const ABORT_MESSAGE = 'Copilot metadata probe aborted';
const DISPOSED_MESSAGE = 'Copilot metadata probe is disposed.';
/** Copilot publishes commands in a notification right after `session/new`, and again once skills load. */
const COMMANDS_WAIT_MS = 3_000;

/**
 * Reads models and commands from a prompt-less session that is closed at once. Copilot does not list sessions that
 * received no prompt, so discovery leaves no visible conversation behind (an empty session directory remains).
 * Copilot reports reasoning levels only for the current model, so the probe selects each advertised model in turn;
 * a model the account cannot select (for example `auto` with a custom provider) keeps no levels.
 */
export class CopilotMetadataProbe {
  private disposeFlight: Promise<void> | null = null;
  private inFlight: Promise<CopilotMetadata> | null = null;
  private readonly probes = new OwnedProbeRegistry<CopilotNativeConnection>({
    abortMessage: ABORT_MESSAGE,
    dispose: native => native.shutdown(),
    unavailableError: () => new Error(DISPOSED_MESSAGE),
  });
  private readonly transitionFence = new ProviderTransitionFence({ abortMessage: ABORT_MESSAGE });

  constructor(private readonly host: ProviderRuntimeHost) {}

  /** Concurrent callers share one probe. */
  async load(signal?: AbortSignal): Promise<CopilotMetadata> {
    if (this.transitionFence.isUnavailable()) {
      const available = await this.transitionFence.waitUntilAvailable(signal);
      if (!available) throw new Error(DISPOSED_MESSAGE);
    }
    if (signal?.aborted) throw new Error(ABORT_MESSAGE);
    if (!this.inFlight) {
      const flight = this.#probe();
      this.inFlight = flight;
      const clear = () => { if (this.inFlight === flight) this.inFlight = null; };
      flight.then(clear, clear);
    }
    const flight = this.inFlight;
    if (!signal) return flight;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error(ABORT_MESSAGE));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([flight, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort!);
    }
  }

  #probe(): Promise<CopilotMetadata> {
    return this.probes.run({
      create: async (ownedSignal) => {
        const launch = await resolveCopilotLaunchSpec(this.host, COPILOT_ACP_ARGS);
        ownedSignal.throwIfAborted();
        return new CopilotNativeConnection({
          launch,
          requestPermission: async () => CANCELLED_ACP_PERMISSION_RESPONSE,
          version: this.host.clientVersion ?? '0.0.0',
        });
      },
      initialize: native => native.initialize(),
      query: async (native, ownedSignal) => {
        let resolveCommands!: (commands: SlashCommand[]) => void;
        const commandsReceived = new Promise<SlashCommand[]>(resolve => { resolveCommands = resolve; });
        let sessionId: string | null = null;
        const pending: ACPSessionNotification[] = [];
        const accept = (notification: ACPSessionNotification) => {
          if (notification.update.sessionUpdate === 'available_commands_update' && notification.sessionId === sessionId) {
            resolveCommands(normalizeACPAvailableCommands(notification.update.availableCommands));
          }
        };
        const unsubscribe = native.onNotification(notification => {
          if (sessionId) accept(notification);
          else pending.push(notification);
        });
        try {
          const response = await native.newSession({ cwd: native.launch.targetCwd, mcpServers: [] });
          sessionId = response.sessionId;
          pending.splice(0).forEach(accept);
          let timer: number | undefined;
          const commands = await Promise.race([
            commandsReceived,
            new Promise<SlashCommand[]>(resolve => { timer = window.setTimeout(() => resolve([]), COMMANDS_WAIT_MS); }),
          ]).finally(() => window.clearTimeout(timer));
          ownedSignal.throwIfAborted();
          const { currentModelId, models } = readCopilotSessionModels(response.configOptions);
          const described = await describeModelLevels(native, response.sessionId, models, ownedSignal);
          await native.closeSession(response.sessionId).catch(() => undefined);
          return { commands, currentModelId, models: described };
        } finally {
          unsubscribe();
        }
      },
    });
  }

  beginEnvironmentTransition(): void {
    this.transitionFence.beginTransition();
  }

  endEnvironmentTransition(): void {
    this.transitionFence.endTransition();
  }

  quiesceForEnvironmentChange(): Promise<void> {
    return this.probes.quiesce();
  }

  dispose(): Promise<void> {
    if (this.disposeFlight) return this.disposeFlight;
    this.transitionFence.dispose();
    this.disposeFlight = this.probes.dispose();
    return this.disposeFlight;
  }
}

async function describeModelLevels(
  native: CopilotNativeConnection,
  sessionId: string,
  models: readonly CopilotModel[],
  signal: AbortSignal,
): Promise<CopilotModel[]> {
  const described: CopilotModel[] = [];
  for (const model of models) {
    signal.throwIfAborted();
    if (model.reasoningEfforts.length > 0) {
      described.push(model);
      continue;
    }
    try {
      const response = await native.setConfigOption({ configId: COPILOT_MODEL_CONFIG_ID, sessionId, value: model.rawId });
      described.push({ ...model, reasoningEfforts: readCopilotReasoningLevels(response.configOptions) });
    } catch {
      described.push(model);
    }
  }
  return described;
}
