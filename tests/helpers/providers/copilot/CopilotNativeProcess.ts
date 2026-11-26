import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import sessionConfigOptions from '@test/fixtures/providers/copilot/runtime/session-config-options.json';
import { createNativeRPCPeer, type NativeRPCPeer } from '@test/helpers/providers/NativeRPCTestProcess';

import type {
  ACPInitializeRequest,
  ACPLoadSessionRequest,
  ACPMCPServer,
  ACPNewSessionRequest,
  ACPPromptRequest,
  ACPPromptResponse,
  ACPRequestPermissionRequest,
  ACPRequestPermissionResponse,
  ACPSessionConfigOption,
  ACPSetSessionConfigOptionRequest,
} from '@/providers/acp';

/** Config options as `copilot --acp` 1.0.114 reports them on session/new and session/load. */
export function copilotConfigOptions(): ACPSessionConfigOption[] {
  return structuredClone(sessionConfigOptions) as ACPSessionConfigOption[];
}

interface HeldPrompt {
  readonly request: ACPPromptRequest;
  /** MCP servers the session was opened with when the prompt arrived. */
  readonly mcpServersAtReceipt: readonly ACPMCPServer[];
  settled: boolean;
  resolve(response: ACPPromptResponse): void;
}

/** The custom instruction files Copilot reads, once, when its process starts. */
function readInstructionFiles(env: NodeJS.ProcessEnv | undefined): string[] {
  const directories = env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS?.split(',').map(entry => entry.trim()).filter(Boolean) ?? [];
  return directories.flatMap(directory => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return [];
    }
    return entries.filter(name => name.endsWith('.instructions.md'))
      .map(name => readFileSync(path.join(directory, name), 'utf8'));
  });
}

/**
 * `copilot --acp --stdio` peer. Prompts stay pending until the test resolves them; `session/cancel` answers the
 * running prompt with `cancelled`, as Copilot does.
 */
export class CopilotNativeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly cancelRequests: string[] = [];
  readonly closeRequests: string[] = [];
  readonly configRequests: ACPSetSessionConfigOptionRequest[] = [];
  readonly initializeRequests: ACPInitializeRequest[] = [];
  readonly loadRequests: ACPLoadSessionRequest[] = [];
  readonly newRequests: ACPNewSessionRequest[] = [];
  readonly prompts: HeldPrompt[] = [];
  /** Instruction file contents present when the process started. */
  readonly instructionsAtLaunch: readonly string[];
  readonly openMCPServers = new Map<string, ACPMCPServer[]>();
  /** Reasoning levels Copilot offers per model; a model absent here offers none. */
  readonly reasoningByModel = new Map<string, string[]>([['claude-sonnet-4.6', ['low', 'medium', 'high', 'max']]]);
  configOptions = copilotConfigOptions();
  newSessionId = 'session-new';
  availableCommands: Array<{ description: string; name: string }> = [];
  /** Text Copilot replays while loading a session. */
  replayText = 'Earlier reply';
  /** Runs after Copilot applied a config change and before it answers; tests hold it to interleave. */
  configGate: (request: ACPSetSessionConfigOptionRequest) => Promise<void> | void = () => {};
  private readonly peer: NativeRPCPeer;
  private readonly promptWaiters: Array<{ count: number; resolve: () => void }> = [];

  /**
   * `knownSessions` is Copilot's session store (under `COPILOT_HOME`), shared by every process of a test;
   * `session/load` fails for any other id.
   */
  constructor(
    readonly args: readonly string[],
    env?: NodeJS.ProcessEnv,
    readonly knownSessions: Set<string> = new Set(['session-existing']),
  ) {
    this.instructionsAtLaunch = readInstructionFiles(env);
    // Requests arrive as decoded JSON records; the casts bridge that wire shape to the protocol types.
    this.peer = createNativeRPCPeer(async (method, params) => {
      switch (method) {
        case 'initialize':
          this.initializeRequests.push(params as unknown as ACPInitializeRequest);
          return {
            agentCapabilities: {
              auth: { logout: {} },
              loadSession: true,
              mcpCapabilities: { http: true, sse: true },
              promptCapabilities: { audio: false, embeddedContext: true, image: true },
              sessionCapabilities: { close: {}, list: {} },
            },
            agentInfo: { name: 'Copilot', title: 'Copilot', version: '1.0.114' },
            authMethods: [{ id: 'copilot-login', name: 'Log in with Copilot CLI' }],
            protocolVersion: 1,
          };
        case 'session/new': {
          const request = params as unknown as ACPNewSessionRequest;
          this.newRequests.push(request);
          const sessionId = this.newSessionId;
          this.knownSessions.add(sessionId);
          this.openMCPServers.set(sessionId, request.mcpServers);
          this.#publishCommands(sessionId);
          return { configOptions: this.configOptions, sessionId };
        }
        case 'session/load': {
          const request = params as unknown as ACPLoadSessionRequest;
          this.loadRequests.push(request);
          if (!this.knownSessions.has(request.sessionId)) {
            throw new Error(`Resource not found: Session ${request.sessionId} not found`);
          }
          this.openMCPServers.set(request.sessionId, request.mcpServers);
          // Copilot replays the stored conversation before answering.
          this.emit({ content: { text: 'Earlier question', type: 'text' }, sessionUpdate: 'user_message_chunk' }, request.sessionId);
          this.emit({ content: { text: this.replayText, type: 'text' }, messageId: 'replayed', sessionUpdate: 'agent_message_chunk' }, request.sessionId);
          this.#publishCommands(request.sessionId);
          return { configOptions: this.configOptions };
        }
        case 'session/close':
          this.closeRequests.push(String(params.sessionId));
          return {};
        case 'session/set_config_option': {
          const request = params as unknown as ACPSetSessionConfigOptionRequest;
          this.configRequests.push(request);
          const target = this.configOptions.find(option => option.id === request.configId);
          if (target?.type !== 'select' || !target.options.some(option => 'value' in option && option.value === request.value)) {
            throw new Error(`Invalid ${request.configId} '${String(request.value)}'`);
          }
          this.configOptions = this.configOptions.map(option => (
            option.id === request.configId && option.type === 'select'
              ? { ...option, currentValue: String(request.value) }
              : option
          ));
          if (request.configId === 'model') this.#offerReasoningFor(String(request.value));
          this.emit({ configOptions: this.configOptions, sessionUpdate: 'config_option_update' }, request.sessionId);
          await this.configGate(request);
          return { configOptions: this.configOptions };
        }
        case 'session/prompt': {
          const request = params as unknown as ACPPromptRequest;
          return new Promise<ACPPromptResponse>(resolve => {
            const held: HeldPrompt = {
              mcpServersAtReceipt: structuredClone(this.openMCPServers.get(request.sessionId) ?? []),
              request,
              resolve: response => {
                if (held.settled) return;
                held.settled = true;
                resolve(response);
              },
              settled: false,
            };
            this.prompts.push(held);
            for (const waiter of this.promptWaiters.splice(0)) {
              if (this.prompts.length >= waiter.count) waiter.resolve();
              else this.promptWaiters.push(waiter);
            }
          });
        }
        default:
          throw new Error('Unexpected native method: ' + method);
      }
    }, (method, params) => {
      if (method !== 'session/cancel') return;
      this.cancelRequests.push(String(params.sessionId));
      this.prompts.at(-1)?.resolve({ stopReason: 'cancelled' });
    });
    this.child = this.peer.child;
  }

  /** Adds a model Copilot advertises, with the reasoning levels it offers once selected. */
  addModel(id: string, name: string, levels: string[] = []): void {
    this.configOptions = this.configOptions.map((option): ACPSessionConfigOption => (option.id === 'model' && option.type === 'select'
      ? { ...option, options: [...option.options.flatMap(entry => ('options' in entry ? entry.options : [entry])), { description: name, name, value: id }] }
      : option));
    if (levels.length > 0) this.reasoningByModel.set(id, levels);
  }

  waitForPrompts(count: number): Promise<void> {
    if (this.prompts.length >= count) return Promise.resolve();
    return new Promise(resolve => { this.promptWaiters.push({ count, resolve }); });
  }

  finishPrompt(response: ACPPromptResponse = { stopReason: 'end_turn' }): void {
    this.prompts.at(-1)!.resolve(response);
  }

  emit(update: Record<string, unknown>, sessionId = 'session-new'): void {
    this.child.stdout.push(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } }) + '\n');
  }

  requestPermission(request: ACPRequestPermissionRequest): Promise<ACPRequestPermissionResponse> {
    return this.peer.request('session/request_permission', request) as Promise<ACPRequestPermissionResponse>;
  }

  configValue(configId: string): string | undefined {
    const option = this.configOptions.find(entry => entry.id === configId);
    return option?.type === 'select' ? option.currentValue : undefined;
  }

  /** Exercises the MCP route the client attached to a session. */
  async callMCP(sessionId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const server = this.openMCPServers.get(sessionId)?.find(entry => entry.name === 'copilodian_sessions');
    if (!server || !('url' in server)) throw new Error('MCP unavailable');
    const response = await fetch(server.url, {
      method: 'POST',
      headers: { ...Object.fromEntries((server.headers ?? []).map(header => [header.name, header.value])),
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return response.json();
  }

  #offerReasoningFor(modelId: string): void {
    const template = copilotConfigOptions().find(option => option.id === 'reasoning_effort');
    const levels = this.reasoningByModel.get(modelId);
    this.configOptions = this.configOptions.filter(option => option.id !== 'reasoning_effort');
    if (!template || template.type !== 'select' || !levels) return;
    const options = levels.map(value => ({ description: value, name: value, value }));
    this.configOptions.splice(2, 0, { ...template, currentValue: levels.includes('medium') ? 'medium' : levels[0], options });
  }

  #publishCommands(sessionId: string): void {
    if (this.availableCommands.length === 0) return;
    const update = { availableCommands: this.availableCommands, sessionUpdate: 'available_commands_update' };
    setImmediate(() => this.emit(update, sessionId));
  }
}
