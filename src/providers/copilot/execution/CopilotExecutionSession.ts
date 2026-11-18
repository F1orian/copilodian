import { randomUUID } from 'node:crypto';

import { parseCompactCommand } from '@/core/commands/compactCommand';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '@/core/prompt/historyContext';
import { appendExecutionContext } from '@/core/prompt/promptContext';
import { invokeSessionTool } from '@/core/session-tools/invokeSessionTool';
import { SESSION_TOOL_ROUTE_HEADER, type SessionToolRoute } from '@/core/session-tools/SessionToolEndpoint';
import { SESSION_TOOL_MCP_SERVER_NAME } from '@/core/session-tools/sessionToolMCP';
import { isSessionTool } from '@/core/tools/toolNames';
import {
  type ACPContentBlock,
  ACPInteractionController,
  type ACPMCPServer,
  ACPNativeOwnerSlot,
  type ACPPromptResponse,
  ACPRequestedTurn,
  type ACPRequestPermissionRequest,
  type ACPRequestPermissionResponse,
  type ACPSessionConfigOption,
  type ACPSessionNotification,
  buildACPUsageInfo,
  mapACPApprovalDecision,
  normalizeACPAvailableCommands,
} from '@/providers/acp';

import {
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionInvalidation,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  RequestedRunChannel,
  SessionSnapshotState,
} from '../../../core/execution';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type { ChatMessage, SlashCommand } from '../../../core/types';
import { filterCopilotCommands } from '../commands/CopilotCommandCatalog';
import {
  COPILOT_AGENT_MODE,
  COPILOT_ALLOW_ALL_CONFIG_ID,
  COPILOT_MODE_CONFIG_ID,
  COPILOT_MODEL_CONFIG_ID,
  COPILOT_REASONING_CONFIG_ID,
  type CopilotModel,
  decodeCopilotModelId,
  readCopilotConfigValue,
  readCopilotReasoningLevels,
  readCopilotSessionModels,
} from '../models';
import {
  createCopilotToolStreamAdapter,
  deriveCopilotNativeToolName,
  isCopilotNotice,
  normalizeCopilotToolName,
  presentCopilotUpdate,
} from '../normalization/copilotToolNormalization';
import {
  shouldAllowAllCopilotPermissions,
  shouldAutoApproveCopilotEdits,
} from '../permissionModes';
import { resolveCopilotLaunchSpec } from '../runtime/CopilotExecutionContext';
import {
  COPILOT_CUSTOM_INSTRUCTIONS_DIRS_ENV,
  type CopilotInstructionsDirectory,
  createCopilotInstructionsDirectory,
} from '../runtime/CopilotInstructions';
import { parseCopilotProviderState } from '../types';
import { COPILOT_ACP_ARGS, COPILOT_NO_TOOLS_ARGS, CopilotNativeConnection } from './CopilotNativeConnection';

export interface CopilotLiveModelSink {
  mergeLiveModels(models: CopilotModel[], defaultModelId: string | null): Promise<unknown>;
}

export interface CopilotExecutionSessionOptions {
  readonly modelSink?: CopilotLiveModelSink;
}

/** What decides Copilot's approvals: the run's tool policy and permission mode. */
interface ApprovalPolicy {
  readonly permissionMode: ProviderExecutionRequest['configuration']['permissionMode'];
  readonly toolPolicy: ProviderExecutionRequest['toolPolicy'];
}

interface ActiveExecution {
  readonly abortController: AbortController;
  /** Set once the run starts native work; cancelling before any prompt then retires the process. */
  nativeTouched: boolean;
  prompt: Promise<ACPPromptResponse> | null;
  readonly request: ProviderExecutionRequest;
  readonly run: RequestedRunChannel;
  readonly turn: ACPRequestedTurn;
}

/**
 * What Copilot reads only when its process starts. A run that needs different values replaces the process and
 * reloads its session there.
 */
interface CopilotLaunchKey {
  /** Literal instruction text delivered through a custom-instructions directory. */
  readonly instructions: string;
  /** Passive sessions run with no tools at all. */
  readonly noTools: boolean;
}

interface NativeOwner {
  /** Latest filtered `available_commands_update` per native session; it can precede session capture. */
  readonly commandsBySession: Map<string, SlashCommand[]>;
  configOptions: ACPSessionConfigOption[];
  initialized: boolean;
  readonly instructionsDirectory: CopilotInstructionsDirectory | null;
  readonly launchKey: CopilotLaunchKey;
  /** The native session this process has opened (created or loaded). */
  loadedSessionId: string | null;
  readonly native: CopilotNativeConnection;
  unsubscribe: () => void;
}

const CANCEL_SETTLE_TIMEOUT_MS = 2_000;
const CANCELLED_PERMISSION: ACPRequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

const PASSIVE_TOOL_INSTRUCTION = [
  'Do not use any tools for this request.',
  'Answer only from information supplied directly in the prompt.',
].join(' ');

/** Copilot answers `session/load` for an unknown id with ACP's resource-not-found error. */
const MISSING_SESSION_PATTERN = /resource not found|session \S+ not found/i;
const AUTHENTICATION_PATTERN = /\b401\b|unauthori[sz]ed|not (?:signed|logged) in|authenticat|\blog ?in\b|sign[ -]?in|credential/i;

export class CopilotExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'copilot' as const;
  readonly sessionInstanceId = randomUUID();

  private active: ActiveExecution | null = null;
  private cancellationFlight: Promise<void> | null = null;
  private disposalFlight: Promise<void> | null = null;
  private disposed = false;
  private nativeConversationContextEstablished: boolean;
  private readonly nativeSlot = new ACPNativeOwnerSlot<NativeOwner>(async (owner, wasCurrent) => {
    if (wasCurrent) owner.unsubscribe();
    try {
      await owner.native.shutdown();
    } finally {
      await owner.instructionsDirectory?.dispose();
    }
  });
  private providerSessionId: string | undefined;
  private sessionToolRoute: Promise<SessionToolRoute> | null = null;
  private readonly interactionController: ACPInteractionController;
  private readonly state: SessionSnapshotState;

  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: CopilotExecutionSessionOptions = {},
  ) {
    this.providerSessionId = config.resumeSeed?.providerSessionId;
    const providerState = parseCopilotProviderState(config.resumeSeed?.providerState);
    this.state = new SessionSnapshotState({
      providerId: this.providerId,
      providerState: { ...providerState },
      readProviderSessionId: () => this.providerSessionId,
      sessionInstanceId: this.sessionInstanceId,
    });
    this.nativeConversationContextEstablished = Boolean(
      this.providerSessionId && providerState.nativeConversationContextEstablished !== false,
    );
    this.interactionController = new ACPInteractionController({
      getTurnId: () => this.active?.run.turnId ?? null,
      interactionPort: config.interactionPort,
      presentPermission: request => {
        const name = presentPermissionToolName(request);
        return { description: request.toolCall.title || name, toolName: name };
      },
      sessionInstanceId: this.sessionInstanceId,
    });
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('Copilot execution session is disposed.');
    if (this.active) throw new Error('Copilot execution session is already executing.');
    const run = new RequestedRunChannel({
      onCancel: source => { void this.#cancelRun(run, source === 'abort-signal' ? 'aborted' : 'cancelled'); },
      sessionInstanceId: this.sessionInstanceId,
    });
    const active: ActiveExecution = {
      abortController: new AbortController(),
      nativeTouched: false,
      prompt: null,
      request,
      run,
      turn: new ACPRequestedTurn({
        onAccept: () => {
          if (this.nativeConversationContextEstablished) return;
          this.#setNativeConversationContextEstablished(true);
          this.#updateSnapshot('executing');
          this.#emitCurrentSnapshot();
        },
        run,
        toolStreamAdapter: createCopilotToolStreamAdapter(),
      }),
    };
    this.active = active;
    this.#updateSnapshot('executing');
    this.#emitCurrentSnapshot();
    run.attachAbortSignal(request.signal);
    if (!run.isCancellationRequested) void this.#performExecution(active);
    return run;
  }

  cancel(): void {
    this.active?.run.cancel();
  }

  getCommandSnapshot(): readonly SlashCommand[] | undefined {
    const sessionId = this.providerSessionId;
    const commands = sessionId ? this.nativeSlot.current?.commandsBySession.get(sessionId) : undefined;
    return commands?.map(command => ({ ...command }));
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.state.getSnapshot();
  }

  getStatus(): ProviderSessionStatus {
    return this.state.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    return this.state.onEvent(listener);
  }

  dispose(): Promise<void> {
    if (this.disposalFlight) return this.disposalFlight;
    this.disposed = true;
    this.disposalFlight = (async () => {
      try {
        const active = this.active;
        if (active) await this.#cancelRun(active.run, 'session-disposed');
        if (this.cancellationFlight) await this.cancellationFlight;
        await this.nativeSlot.shutdown();
      } finally {
        const route = await this.sessionToolRoute?.catch(() => null);
        route?.dispose();
        this.interactionController.dispose();
        this.state.clearListeners();
        this.#updateSnapshot('disposed');
      }
    })();
    return this.disposalFlight;
  }

  async #performExecution(active: ActiveExecution): Promise<void> {
    if (active.request.toolPolicy.kind === 'allow-list') {
      this.#failUnrecoverable(active, 'Copilot does not support exact tool allow-lists.');
      return;
    }
    let unsubscribeClose: (() => void) | undefined;
    try {
      if (this.cancellationFlight) await this.cancellationFlight;
      if (this.#isCancellationRequested(active)) return;
      active.nativeTouched = true;
      const owner = await this.#ensureSession(active);
      if (this.#isCancellationRequested(active)) return;
      await this.#applyConfiguration(owner, active);
      if (this.#isCancellationRequested(active)) return;
      const sessionId = this.providerSessionId!;
      const compact = parseCompactCommand(getInputText(active.request));
      if (compact && !this.nativeConversationContextEstablished && active.request.conversationHistory?.length) {
        throw new Error('Send a normal message to restore the native conversation before using /compact.');
      }
      active.turn.beginLiveOutput();
      const closed = new Promise<never>((_resolve, reject) => {
        unsubscribeClose = owner.native.onClose(error => reject(new Error('Copilot transport closed', { cause: error })));
      });
      const blocks = compact
        ? [{ text: `/compact${compact.instructions ? ` ${compact.instructions}` : ''}`, type: 'text' as const }]
        : buildPromptBlocks(active.request, !this.nativeConversationContextEstablished);
      active.prompt = owner.native.prompt({ prompt: blocks, sessionId });
      // Consumers treat the first user boundary as the turn's own input.
      active.run.emit({ content: getInputText(active.request), type: 'user_message_started' });
      const response = await Promise.race([closed, active.prompt]);
      if (this.#isCancellationRequested(active)) return;
      const compacted = compact !== null && response.stopReason === 'end_turn';
      if (compacted) active.run.emit({ type: 'context_compacted' });
      this.#finishCompleted(active, response, compacted);
    } catch (error) {
      if (this.#isCancellationRequested(active)) return;
      this.#failRecoverable(active, error);
    } finally {
      unsubscribeClose?.();
    }
  }

  async #ensureNative(active: ActiveExecution, launchKey: CopilotLaunchKey): Promise<NativeOwner> {
    const started = await this.nativeSlot.ensure(
      owner => owner.initialized && owner.native.isAlive() && sameLaunchKey(owner.launchKey, launchKey),
      () => this.#startNative(active, launchKey),
    );
    this.#throwIfCancellationRequested(active);
    return started;
  }

  async #startNative(active: ActiveExecution, launchKey: CopilotLaunchKey): Promise<NativeOwner> {
    const previous = this.nativeSlot.current;
    if (previous) await this.nativeSlot.detach(previous);
    const args = [...COPILOT_ACP_ARGS, ...(launchKey.noTools ? COPILOT_NO_TOOLS_ARGS : [])];
    const baseLaunch = await resolveCopilotLaunchSpec(this.host, args, this.config.workingDirectory);
    this.#throwIfCancellationRequested(active);
    const instructionsDirectory = launchKey.instructions
      ? await createCopilotInstructionsDirectory(launchKey.instructions, baseLaunch.env[COPILOT_CUSTOM_INSTRUCTIONS_DIRS_ENV])
      : null;
    if (this.#isCancellationRequested(active)) {
      await instructionsDirectory?.dispose();
      throw new CopilotExecutionCancellationError();
    }
    const launch = instructionsDirectory
      ? { ...baseLaunch, env: { ...baseLaunch.env, ...instructionsDirectory.environment } }
      : baseLaunch;
    const native = new CopilotNativeConnection({
      launch,
      requestPermission: request => this.#handlePermission(request),
      version: this.host.clientVersion ?? '0.0.0',
    });
    const owner: NativeOwner = {
      commandsBySession: new Map(),
      configOptions: [],
      initialized: false,
      instructionsDirectory,
      launchKey,
      loadedSessionId: null,
      native,
      unsubscribe: () => {},
    };
    this.nativeSlot.install(owner);
    try {
      owner.unsubscribe = native.onNotification(notification => {
        if (this.#isCurrentOwner(owner)) this.#handleNotification(owner, notification);
      });
      await native.initialize();
      if (this.disposed || !this.#isCurrentOwner(owner)) throw new CopilotExecutionCancellationError();
      owner.initialized = true;
      return owner;
    } catch (error) {
      await this.nativeSlot.detach(owner).catch(() => undefined);
      throw error;
    }
  }

  async #ensureSession(active: ActiveExecution): Promise<NativeOwner> {
    const { systemInstructions } = active.request.configuration;
    const noTools = active.request.toolPolicy.kind === 'passive';
    const instructions = noTools
      ? [systemInstructions.instructions, PASSIVE_TOOL_INSTRUCTION].filter(Boolean).join('\n\n')
      : systemInstructions.instructions;
    const owner = await this.#ensureNative(active, { instructions: instructions.trim(), noTools });
    if (this.providerSessionId && owner.loadedSessionId === this.providerSessionId) return owner;
    const mcpServers = await this.#getMCPServers();
    this.#throwIfCancellationRequested(active);
    const request = { cwd: owner.native.launch.targetCwd, mcpServers };
    if (!this.providerSessionId) {
      const response = await owner.native.newSession(request);
      // Publish the native id at once, including when cancellation won the race.
      this.providerSessionId = response.sessionId;
      owner.loadedSessionId = response.sessionId;
      this.#setNativeConversationContextEstablished(false);
      this.#emitCurrentSnapshot();
      this.#throwIfCancellationRequested(active);
      this.#adoptConfigOptions(owner, response.configOptions, 'new-session');
    } else {
      // Copilot replays the session while loading it; that replay is not live output.
      const response = await owner.native.loadSession({ ...request, sessionId: this.providerSessionId });
      this.#throwIfCancellationRequested(active);
      owner.loadedSessionId = this.providerSessionId;
      // A loaded session's current model is the one it last used, not Copilot's default.
      this.#adoptConfigOptions(owner, response.configOptions, 'model-switch');
    }
    this.#updateSnapshot(this.active ? 'executing' : 'idle');
    this.#emitCurrentSnapshot();
    return owner;
  }

  async #applyConfiguration(owner: NativeOwner, active: ActiveExecution): Promise<void> {
    const sessionId = this.providerSessionId!;
    const { configuration, toolPolicy } = active.request;
    const rawModel = configuration.model ? decodeCopilotModelId(configuration.model) : null;
    if (rawModel) {
      const { models } = readCopilotSessionModels(owner.configOptions);
      if (models.length > 0 && !models.some(model => model.rawId === rawModel)) {
        throw new Error(`Copilot model "${rawModel}" is not available in this session.`);
      }
      await this.#setConfigOption(owner, active, sessionId, COPILOT_MODEL_CONFIG_ID, rawModel);
    }
    const reasoning = configuration.reasoning?.trim();
    // Copilot offers no reasoning option for fixed-effort models.
    const efforts = readCopilotReasoningLevels(owner.configOptions);
    if (reasoning && efforts.length > 0) {
      if (!efforts.some(effort => effort.value === reasoning)) {
        throw new Error(`Copilot does not support reasoning effort "${reasoning}".`);
      }
      await this.#setConfigOption(owner, active, sessionId, COPILOT_REASONING_CONFIG_ID, reasoning);
    }
    await this.#setConfigOption(owner, active, sessionId, COPILOT_MODE_CONFIG_ID, COPILOT_AGENT_MODE);
    const allowAll = shouldAllowAllCopilotPermissions(configuration.permissionMode)
      && (toolPolicy.kind === 'provider-default' || toolPolicy.kind === 'unrestricted');
    await this.#setConfigOption(owner, active, sessionId, COPILOT_ALLOW_ALL_CONFIG_ID, allowAll ? 'on' : 'off');
  }

  async #setConfigOption(
    owner: NativeOwner,
    active: ActiveExecution,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const current = readCopilotConfigValue(owner.configOptions, configId);
    // An option the session does not offer cannot be set; Copilot rejects unknown ids.
    if (current === null || current === value) return;
    const response = await owner.native.setConfigOption({ configId, sessionId, value });
    this.#throwIfCancellationRequested(active);
    this.#adoptConfigOptions(owner, response.configOptions, configId === COPILOT_MODEL_CONFIG_ID ? 'model-switch' : 'none');
  }

  /**
   * Publishes the session's models, with the current model's reasoning levels, to the catalog. Only a new session's
   * current model is Copilot's default; a loaded or switched session's is only its selection.
   */
  #adoptConfigOptions(
    owner: NativeOwner,
    configOptions: ACPSessionConfigOption[] | null | undefined,
    report: 'model-switch' | 'new-session' | 'none',
  ): void {
    if (!configOptions?.length) return;
    owner.configOptions = configOptions;
    if (report === 'none') return;
    const { currentModelId, models } = readCopilotSessionModels(configOptions);
    if (models.length > 0) {
      void this.options.modelSink?.mergeLiveModels(models, report === 'new-session' ? currentModelId : null)
        .catch(() => undefined);
    }
  }

  async #getMCPServers(): Promise<ACPMCPServer[]> {
    if (!this.config.sessionTools) return [];
    this.sessionToolRoute ??= this.host.sessionToolEndpoint.registerMCPRoute(call => {
      // Capture ownership before dispatch: a pending call must never adopt a later turn.
      const active = this.active;
      return invokeSessionTool(call.name, call.args, {
        port: this.config.sessionTools,
        signal: active ? AbortSignal.any([active.abortController.signal, call.signal]) : AbortSignal.abort(),
        toolPolicy: active?.request.toolPolicy,
      });
    }).then(route => {
      if (this.disposed) {
        route.dispose();
        throw new CopilotExecutionCancellationError();
      }
      return route;
    }).catch(error => {
      this.sessionToolRoute = null;
      throw error;
    });
    const route = await this.sessionToolRoute;
    return [{
      headers: [{ name: SESSION_TOOL_ROUTE_HEADER, value: route.routeId }],
      name: SESSION_TOOL_MCP_SERVER_NAME,
      type: 'http',
      url: route.url,
    }];
  }

  #handlePermission(request: ACPRequestPermissionRequest): Promise<ACPRequestPermissionResponse> {
    if (request.sessionId !== this.providerSessionId) return Promise.resolve(CANCELLED_PERMISSION);
    const active = this.active;
    if (!active || this.#isCancellationRequested(active)) return Promise.resolve(CANCELLED_PERMISSION);
    return this.#decidePermission(request, approvalPolicyOf(active.request), active.abortController.signal);
  }

  #decidePermission(
    request: ACPRequestPermissionRequest,
    { permissionMode, toolPolicy }: ApprovalPolicy,
    signal: AbortSignal,
  ): Promise<ACPRequestPermissionResponse> {
    const policy = toolPolicy.kind;
    if (policy === 'passive') return Promise.resolve(CANCELLED_PERMISSION);
    // Copilot titles a permission request for an MCP tool with the bare tool name.
    if (isSessionTool(request.toolCall.title?.trim() ?? '')) {
      return Promise.resolve(this.config.sessionTools && (policy === 'provider-default' || policy === 'unrestricted')
        ? mapACPApprovalDecision('allow', request.options)
        : CANCELLED_PERMISSION);
    }
    // Copilot reads files without asking; anything it asks about changes something or reaches outside the vault.
    if (policy === 'read-only') {
      return Promise.resolve(request.toolCall.kind === 'read'
        ? mapACPApprovalDecision('allow', request.options) : CANCELLED_PERMISSION);
    }
    if (policy === 'unrestricted' || shouldAllowAllCopilotPermissions(permissionMode)) {
      return Promise.resolve(mapACPApprovalDecision('allow', request.options));
    }
    if (shouldAutoApproveCopilotEdits(permissionMode) && request.toolCall.kind === 'edit') {
      return Promise.resolve(mapACPApprovalDecision('allow', request.options));
    }
    return this.interactionController.requestPermission(request, signal);
  }

  #handleNotification(owner: NativeOwner, notification: ACPSessionNotification): void {
    if (notification.update.sessionUpdate === 'available_commands_update') {
      owner.commandsBySession.set(
        notification.sessionId,
        filterCopilotCommands(normalizeACPAvailableCommands(notification.update.availableCommands)),
      );
      if (notification.sessionId === this.providerSessionId) this.state.emit({ type: 'commands_changed' });
      return;
    }
    if (notification.sessionId !== this.providerSessionId) return;
    const { update } = notification;
    switch (update.sessionUpdate) {
      // Claudian emits its own user boundaries and owns conversation titles.
      case 'user_message_chunk':
      case 'session_info_update':
        return;
      default:
        break;
    }
    if (isCopilotNotice(update)) return;
    const active = this.active;
    if (!active || this.#isCancellationRequested(active)) {
      // Configuration reported between runs still describes the session.
      if (update.sessionUpdate === 'config_option_update') this.#adoptConfigOptions(owner, update.configOptions, 'none');
      return;
    }
    const metadata = active.turn.handleUpdate(presentCopilotUpdate(update));
    if (metadata?.type === 'config_options') this.#adoptConfigOptions(owner, metadata.configOptions, 'none');
  }

  #finishCompleted(active: ActiveExecution, response: ACPPromptResponse, compacted: boolean): void {
    // A successful response proves acceptance even when Copilot streamed no output for it.
    active.turn.accept();
    if (response.usage) {
      const model = active.request.configuration.model
        ? decodeCopilotModelId(active.request.configuration.model) ?? undefined
        : undefined;
      // The response sums every model call in the turn; the latest usage_update measures the context.
      const contextUsage = active.turn.contextUsage;
      const usage = buildACPUsageInfo({
        contextWindow: { size: contextUsage?.size ?? 0, used: compacted ? 0 : contextUsage?.used ?? 0 },
        model,
        promptUsage: response.usage,
      });
      if (usage) active.run.emit({ type: 'usage_updated', usage });
    }
    this.#updateSnapshot('idle');
    this.#emitCurrentSnapshot();
    active.abortController.abort();
    this.#endRun(active, {
      providerPayload: response,
      reason: response.stopReason === 'max_tokens' ? 'max-tokens' : response.stopReason === 'end_turn' ? 'completed' : 'provider-ended',
      type: 'turn_completed',
    });
  }

  #failUnrecoverable(active: ActiveExecution, message: string): void {
    this.#updateSnapshot('invalidated', { message, reason: 'configuration-changed', recoverable: false });
    this.#emitCurrentSnapshot();
    active.abortController.abort();
    this.#endRun(active, { category: 'configuration', message, recoverable: false, type: 'execution_error' });
  }

  #failRecoverable(active: ActiveExecution, error: unknown): void {
    const category = classifyError(error);
    const message = describeError(error, category);
    this.#updateSnapshot('invalidated', {
      message,
      reason: category === 'provider-session-missing'
        ? 'provider-session-missing'
        : category === 'transport' ? 'transport-closed' : 'provider-error',
      recoverable: true,
    });
    this.#emitCurrentSnapshot();
    active.abortController.abort();
    this.#endRun(active, { category, message, recoverable: true, type: 'execution_error' });
  }

  async #cancelRun(run: RequestedRunChannel, reason: string): Promise<void> {
    const active = this.active;
    if (!active || active.run !== run || run.isTerminal) return;
    if (this.cancellationFlight) return this.cancellationFlight;
    this.#updateSnapshot('cancelling');
    this.#emitCurrentSnapshot();
    active.abortController.abort();
    this.interactionController.dismissAll('cancelled');
    const owner = this.nativeSlot.current;
    const sessionId = this.providerSessionId;
    this.cancellationFlight = (async () => {
      try {
        const prompt = active.prompt;
        if (owner && sessionId && prompt) {
          owner.native.cancel(sessionId);
          // Copilot answers a cancelled prompt with `cancelled` at once; a process that does not is replaced.
          const settled = await settleWithin(prompt, CANCEL_SETTLE_TIMEOUT_MS);
          if (!settled) await this.nativeSlot.shutdown();
          else if (await prompt.then(() => true, () => false)) active.turn.accept();
        } else if (active.nativeTouched) {
          // Startup, loading or configuration was interrupted; its native outcome is unknown.
          await this.nativeSlot.shutdown();
        }
      } catch {
        // Teardown failure cannot replace the already-requested cancellation terminal.
      } finally {
        if (!this.disposed) {
          this.#updateSnapshot('idle');
          this.#emitCurrentSnapshot();
        }
        this.#endRun(active, { reason, type: 'cancelled' });
      }
    })().finally(() => { this.cancellationFlight = null; });
    return this.cancellationFlight;
  }

  /** The one way a run ends: its terminal event, its turn's disposal, and release of the session slot. */
  #endRun(active: ActiveExecution, terminal: Parameters<RequestedRunChannel['finish']>[0]): void {
    active.run.finish(terminal);
    active.turn.dispose();
    if (this.active === active) this.active = null;
  }

  #isCancellationRequested(active: ActiveExecution): boolean {
    return this.disposed || active.run.isCancellationRequested || this.active !== active || active.run.isTerminal;
  }

  #throwIfCancellationRequested(active: ActiveExecution): void {
    if (this.#isCancellationRequested(active)) throw new CopilotExecutionCancellationError();
  }

  #isCurrentOwner(owner: NativeOwner): boolean {
    return !this.disposed && this.nativeSlot.isCurrent(owner);
  }

  #setNativeConversationContextEstablished(established: boolean): void {
    this.nativeConversationContextEstablished = established;
    this.state.setProviderStateValue('nativeConversationContextEstablished', established);
  }

  #updateSnapshot(status: ProviderSessionStatus, invalidation?: ProviderSessionInvalidation): void {
    if (status === 'invalidated') this.state.invalidate(invalidation!);
    else this.state.setStatus(status);
  }

  #emitCurrentSnapshot(): void {
    const active = this.active;
    const event = { snapshot: this.state.getSnapshot(), type: 'session_state_changed' as const };
    if (active && !active.run.isTerminal) {
      active.run.emit(event);
      return;
    }
    this.state.emit(event);
  }
}

class CopilotExecutionCancellationError extends Error {
  constructor() {
    super('Copilot execution was cancelled.');
    this.name = 'CopilotExecutionCancellationError';
  }
}

function sameLaunchKey(left: CopilotLaunchKey, right: CopilotLaunchKey): boolean {
  return left.instructions === right.instructions && left.noTools === right.noTools;
}

function presentPermissionToolName(request: ACPRequestPermissionRequest): string {
  const { kind, rawInput, title } = request.toolCall;
  // Permission requests describe edits with `fileName`/`diff` rather than the tool's own arguments.
  const input = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {};
  const diff = typeof input.diff === 'string' ? input.diff : '';
  const edit = kind === 'edit' && typeof input.fileName === 'string'
    ? (/^(?:new|create) file mode|^--- a\/dev\/null/m.test(diff) ? 'create' : 'edit')
    : undefined;
  const derived = edit ?? deriveCopilotNativeToolName(kind, title, rawInput);
  return normalizeCopilotToolName(derived ?? title ?? kind ?? 'tool');
}

function approvalPolicyOf(request: ProviderExecutionRequest): ApprovalPolicy {
  return { permissionMode: request.configuration.permissionMode, toolPolicy: request.toolPolicy };
}

function getInputText(request: ProviderExecutionRequest): string {
  return request.input.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function buildPromptBlocks(request: ProviderExecutionRequest, replayConversationHistory = false): ACPContentBlock[] {
  const blocks: ACPContentBlock[] = [];
  let text = appendExecutionContext(getInputText(request), request.context);
  if (replayConversationHistory && request.conversationHistory?.length) {
    const history = [...request.conversationHistory] as ChatMessage[];
    text = buildPromptWithHistoryContext(buildContextFromHistory(history), text, text, history);
  }
  if (text) blocks.push({ text, type: 'text' });
  for (const block of request.input) {
    if (block.type === 'image' && block.image.data) {
      blocks.push({ data: block.image.data, mimeType: block.image.mediaType, type: 'image' });
    }
  }
  return blocks;
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: number | undefined;
  const timeout = new Promise<false>(resolve => { timer = window.setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

type CopilotErrorCategory = 'authentication' | 'configuration' | 'provider-session-missing' | 'transport' | 'unknown';

function describeError(error: unknown, category: CopilotErrorCategory): string {
  const message = error instanceof Error ? error.message : String(error);
  return category === 'authentication'
    ? `${message}\nSign in by running \`copilot login\` in a terminal, or configure a model provider for Copilot.`
    : message;
}

function classifyError(error: unknown): CopilotErrorCategory {
  const message = error instanceof Error ? error.message : String(error);
  if (MISSING_SESSION_PATTERN.test(message)) return 'provider-session-missing';
  if (AUTHENTICATION_PATTERN.test(message)) return 'authentication';
  const lower = message.toLowerCase();
  if (lower.includes('transport') || lower.includes('closed')) return 'transport';
  if (lower.includes('model') || lower.includes('reasoning effort') || lower.includes('config')) return 'configuration';
  return 'unknown';
}
