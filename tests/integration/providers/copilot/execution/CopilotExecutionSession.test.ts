import { existsSync } from 'node:fs';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { CopilotNativeProcess } from '@test/helpers/providers/copilot/CopilotNativeProcess';
import spawn from 'cross-spawn';

import type {
  ProviderApprovalInteractionRequest,
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderExecutionSession,
  ProviderInteractionPort,
  ProviderSessionConfig,
} from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ACPRequestPermissionRequest } from '@/providers/acp';
import { CopilotExecutionBackend } from '@/providers/copilot/execution/CopilotExecutionBackend';
import type { CopilotModel } from '@/providers/copilot/models';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const sessions: ProviderExecutionSession[] = [];
let spawned: CopilotNativeProcess[] = [];
let spawnWaiters: Array<{ count: number; resolve: () => void }> = [];
let vault: string;
/** Copilot's session store, shared by the processes a test starts. */
let nativeStore = new Set<string>();

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  spawned = [];
  spawnWaiters = [];
  nativeStore = new Set(['session-existing']);
  vi.mocked(spawn).mockReset();
  vi.restoreAllMocks();
});

function createInteractionPort() {
  return {
    askUserQuestion: vi.fn<ProviderInteractionPort['askUserQuestion']>(),
    dismissInteraction: vi.fn<ProviderInteractionPort['dismissInteraction']>(),
    requestApproval: vi.fn<ProviderInteractionPort['requestApproval']>(),
  } satisfies ProviderInteractionPort;
}

async function createHost(): Promise<ProviderHost> {
  const { host } = await createProviderHostFixture({
    overrides: { getResolvedProviderCliPath: async () => 'copilot' },
    settings: { providerConfigs: { copilot: { enabled: true } } },
  });
  vault = host.workingDirectory!;
  return host;
}

async function createSession(
  overrides: Partial<ProviderSessionConfig> = {},
  peerSetup: (peer: CopilotNativeProcess) => void = () => {},
  modelSink?: { mergeLiveModels: (models: CopilotModel[], defaultModelId: string | null) => Promise<unknown> },
): Promise<ProviderExecutionSession> {
  vi.mocked(spawn).mockImplementation((_command, args, options) => {
    const peer = new CopilotNativeProcess(args ?? [], options?.env, nativeStore);
    peerSetup(peer);
    spawned.push(peer);
    spawnWaiters = spawnWaiters.filter(waiter => (spawned.length >= waiter.count ? (waiter.resolve(), false) : true));
    return peer.child;
  });
  const backend = new CopilotExecutionBackend((await createHost()).getRuntimeHost('copilot'), modelSink ? { modelSink } : {});
  const session = backend.createSession({
    interactionPort: createInteractionPort(),
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    workingDirectory: vault,
    ...overrides,
  });
  sessions.push(session);
  return session;
}

function request(
  text = 'hello',
  options: { instructions?: string; model?: string; permissionMode?: string; reasoning?: string | null } = {},
): ProviderExecutionRequest {
  return {
    configuration: {
      model: options.model ?? 'copilot/claude-sonnet-4.6',
      permissionMode: options.permissionMode ?? 'normal',
      reasoning: options.reasoning === undefined ? 'high' : options.reasoning,
      systemInstructions: { instructions: options.instructions ?? 'Be exact.', kind: 'main-agent' },
    },
    input: [{ text, type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
  };
}

function titleRequest(): ProviderExecutionRequest {
  return {
    ...request(),
    configuration: { ...request().configuration, systemInstructions: { instructions: 'Title only.', kind: 'explicit', purpose: 'title' } },
    toolPolicy: { kind: 'passive' },
  };
}

async function collect(events: AsyncIterable<ProviderExecutionEvent>): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function spawnedProcess(count: number): Promise<CopilotNativeProcess> {
  if (spawned.length < count) await new Promise<void>(resolve => { spawnWaiters.push({ count, resolve }); });
  return spawned[count - 1];
}

function textOf(events: readonly ProviderExecutionEvent[]): string {
  return events.flatMap(event => (event.type === 'text_delta' ? [event.text] : [])).join('');
}

/** Permission requests as copilot 1.0.114 sends them; a file creation carries its diff. */
function permissionRequest(kind: string, title: string, sessionId = 'session-new'): ACPRequestPermissionRequest {
  const rawInput = kind === 'edit'
    ? { diff: '\ndiff --git a/vault/out.md b/vault/out.md\ncreate file mode 100644\n--- a/dev/null\n+++ b/vault/out.md\n', fileName: '/vault/out.md' }
    : kind === 'execute' ? { command: 'rm -rf build' } : {};
  return {
    options: [
      { kind: 'allow_once', name: 'Allow once', optionId: 'allow_once' },
      { kind: 'allow_always', name: 'Always allow', optionId: 'allow_always' },
      { kind: 'reject_once', name: 'Deny', optionId: 'reject_once' },
    ],
    sessionId,
    toolCall: { kind, rawInput, status: 'pending', title, toolCallId: 'tool-1' } as ACPRequestPermissionRequest['toolCall'],
  };
}

describe('CopilotExecutionSession', () => {
  it('creates a session, delivers Claudian instructions at launch and streams the turn', async () => {
    const merged: Array<{ defaultModelId: string | null; models: CopilotModel[] }> = [];
    const session = await createSession({}, () => {}, {
      mergeLiveModels: async (models, defaultModelId) => { merged.push({ defaultModelId, models }); },
    });
    const run = session.execute(request('hello', { instructions: 'Answer in haiku.' }));
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);

    expect(peer.args).toEqual(['--acp', '--stdio']);
    expect(peer.instructionsAtLaunch).toEqual(['Answer in haiku.']);
    expect(peer.newRequests).toHaveLength(1);
    expect(peer.newRequests[0].cwd).toBe(vault);
    // Only options that differ are set: reasoning effort; Agent mode and allow-all off are already current.
    expect(peer.configRequests.map(({ configId, value }) => [configId, value])).toEqual([['reasoning_effort', 'high']]);
    expect(peer.prompts[0].request.prompt).toEqual([{ text: 'hello', type: 'text' }]);
    expect(merged[0]).toMatchObject({
      defaultModelId: 'claude-sonnet-4.6',
      models: [
        { rawId: 'auto', reasoningEfforts: [] },
        { rawId: 'claude-sonnet-4.6', reasoningEfforts: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }, { value: 'max' }] },
      ],
    });

    peer.emit({ content: { text: 'Info: Disabled tools: bash', type: 'text' }, sessionUpdate: 'agent_message_chunk' });
    peer.emit({ content: { text: 'Hi', type: 'text' }, messageId: 'm1', sessionUpdate: 'agent_message_chunk' });
    peer.emit({ sessionUpdate: 'usage_update', size: 136000, used: 14259 });
    peer.finishPrompt({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
    const events = await collect(run.events);

    expect(textOf(events)).toBe('Hi');
    expect(events.find(event => event.type === 'usage_updated')).toMatchObject({
      usage: { contextTokens: 14259, contextWindow: 136000 },
    });
    expect(events.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
    expect(session.getSnapshot()).toMatchObject({
      providerSessionId: 'session-new',
      providerState: { nativeConversationContextEstablished: true },
    });
  });

  it('loads an existing binding without presenting the replay as output', async () => {
    const session = await createSession({
      resumeSeed: { providerSessionId: 'session-existing', providerState: { nativeConversationContextEstablished: true } },
    });
    const run = session.execute(request('next'));
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    expect(peer.newRequests).toHaveLength(0);
    expect(peer.loadRequests.map(entry => entry.sessionId)).toEqual(['session-existing']);
    peer.emit({ content: { text: 'Fresh', type: 'text' }, messageId: 'm2', sessionUpdate: 'agent_message_chunk' }, 'session-existing');
    peer.finishPrompt();
    const events = await collect(run.events);
    expect(textOf(events)).toBe('Fresh');
  });

  it('fails a send whose native session is missing and keeps the binding', async () => {
    const session = await createSession({
      resumeSeed: { providerSessionId: 'session-gone', providerState: {} },
    });
    const events = await collect(session.execute(request()).events);
    expect(events.at(-1)).toMatchObject({ category: 'provider-session-missing', recoverable: true, type: 'execution_error' });
    expect(session.getSnapshot().providerSessionId).toBe('session-gone');
    expect(spawned[0].prompts).toHaveLength(0);
  });

  it('replaces the process and reloads the session when the instructions change', async () => {
    const session = await createSession();
    const first = session.execute(request('one', { instructions: 'First.' }));
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(first.events);

    const second = session.execute(request('two', { instructions: 'Second.' }));
    const next = await spawnedProcess(2);
    await next.waitForPrompts(1);
    expect(next.instructionsAtLaunch).toEqual(['Second.']);
    expect(next.newRequests).toHaveLength(0);
    expect(next.loadRequests.map(entry => entry.sessionId)).toEqual(['session-new']);
    next.finishPrompt();
    await collect(second.events);
  });

  it('removes the instructions directory with its process', async () => {
    const session = await createSession();
    const run = session.execute(request());
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    const directory = vi.mocked(spawn).mock.calls[0][2]?.env?.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? '';
    expect(directory).not.toBe('');
    expect(existsSync(directory)).toBe(true);
    peer.finishPrompt();
    await collect(run.events);
    await session.dispose();
    expect(existsSync(directory)).toBe(false);
  });

  it('runs passive work without tools and denies every permission request', async () => {
    const port = createInteractionPort();
    const session = await createSession({ interactionPort: port });
    const run = session.execute(titleRequest());
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    expect(peer.args).toEqual(['--acp', '--stdio', '--available-tools=claudian_no_tools']);
    expect(peer.instructionsAtLaunch[0]).toContain('Title only.');
    await expect(peer.requestPermission(permissionRequest('execute', 'ls'))).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(port.requestApproval).not.toHaveBeenCalled();
    peer.finishPrompt();
    await collect(run.events);
  });

  it('turns Copilot allow-all on for YOLO and off again when leaving it', async () => {
    const session = await createSession();
    const yolo = session.execute(request('go', { permissionMode: 'yolo' }));
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    expect(peer.configValue('allow_all')).toBe('on');
    peer.finishPrompt();
    await collect(yolo.events);

    const ask = session.execute(request('careful'));
    await peer.waitForPrompts(2);
    expect(peer.configValue('allow_all')).toBe('off');
    expect(peer.configValue('mode')).toBe('https://agentclientprotocol.com/protocol/session-modes#agent');
    peer.finishPrompt();
    await collect(ask.events);
  });

  it.each([
    ['normal', 'edit', 'Create file', true, 'Write'],
    ['acceptEdits', 'edit', 'Create file', false, undefined],
    ['acceptEdits', 'execute', 'Run command', true, 'Bash'],
  ] as const)('in %s mode a %s request asks the user: %s', async (permissionMode, kind, title, asks, toolName) => {
    const port = createInteractionPort();
    port.requestApproval.mockImplementation(async (approval: ProviderApprovalInteractionRequest) => ({
      interactionId: approval.interactionId, value: 'reject_once',
    }));
    const session = await createSession({ interactionPort: port });
    const run = session.execute(request('edit', { permissionMode }));
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    const answer = await peer.requestPermission(permissionRequest(kind, title));
    expect(answer).toEqual({ outcome: { optionId: asks ? 'reject_once' : 'allow_once', outcome: 'selected' } });
    expect(port.requestApproval.mock.calls.map(([approval]) => approval.toolName)).toEqual(toolName ? [toolName] : []);
    peer.finishPrompt();
    await collect(run.events);
  });

  it('lets read-only work read but denies changes without asking, and still allows session tools', async () => {
    const port = createInteractionPort();
    const session = await createSession({ interactionPort: port, sessionTools: { list: vi.fn(), read: vi.fn(), send: vi.fn() } });
    const run = session.execute({ ...request('edit'), toolPolicy: { kind: 'read-only' } });
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    await expect(peer.requestPermission(permissionRequest('read', 'Read /etc/hosts')))
      .resolves.toEqual({ outcome: { optionId: 'allow_once', outcome: 'selected' } });
    await expect(peer.requestPermission(permissionRequest('edit', 'Create file'))).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    await expect(peer.requestPermission(permissionRequest('execute', 'Run command'))).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    await expect(peer.requestPermission(permissionRequest('other', 'claudian_list_destinations')))
      .resolves.toEqual({ outcome: { optionId: 'allow_once', outcome: 'selected' } });
    expect(port.requestApproval).not.toHaveBeenCalled();
    // Read-only work keeps Copilot's own approvals on.
    expect(peer.configValue('allow_all')).toBe('off');
    peer.finishPrompt();
    await collect(run.events);
  });

  it('attaches Claudian session tools over MCP and approves them without asking', async () => {
    const port = createInteractionPort();
    const list = vi.fn(async () => ({ sessions: [] }));
    const session = await createSession({ interactionPort: port, sessionTools: { list, read: vi.fn(), send: vi.fn() } });
    const run = session.execute(request());
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    expect(peer.prompts[0].mcpServersAtReceipt).toEqual([expect.objectContaining({ name: 'claudian_sessions', type: 'http' })]);
    await expect(peer.requestPermission(permissionRequest('other', 'claudian_list_destinations')))
      .resolves.toEqual({ outcome: { optionId: 'allow_once', outcome: 'selected' } });
    await peer.callMCP('session-new', 'claudian_list_destinations', {});
    expect(list).toHaveBeenCalledTimes(1);
    expect(port.requestApproval).not.toHaveBeenCalled();
    peer.finishPrompt();
    await collect(run.events);
  });

  it('presents Copilot tool calls under Claudian tool names', async () => {
    const session = await createSession();
    const run = session.execute(request());
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    // Captured from copilot 1.0.114: titles are display text; the native tool is implied by kind and input.
    peer.emit({ kind: 'read', locations: [{ path: '/vault/note.md' }], rawInput: { path: '/vault/note.md' }, sessionUpdate: 'tool_call', status: 'pending', title: 'Viewing /vault/note.md', toolCallId: 't1' });
    peer.emit({ rawOutput: { content: 'hello world\n', detailedContent: 'diff' }, sessionUpdate: 'tool_call_update', status: 'completed', toolCallId: 't1' });
    peer.emit({ kind: 'execute', rawInput: { command: 'false', description: 'Fail' }, sessionUpdate: 'tool_call', status: 'pending', title: 'Fail', toolCallId: 't2' });
    peer.emit({
      content: [{ content: { text: 'oops\n<shellId: 1 completed with exit code 1>', type: 'text' }, type: 'content' }],
      rawOutput: { content: 'oops\n<shellId: 1 completed with exit code 1>', contents: [{ exitCode: 1, type: 'shell_exit' }] },
      sessionUpdate: 'tool_call_update', status: 'completed', toolCallId: 't2',
    });
    peer.finishPrompt();
    const events = await collect(run.events);
    // A start is re-announced when Copilot adds native output; the first announcement names the tool.
    const firstStarts = [...new Map(events.flatMap(event => (event.type === 'tool_started' ? [[event.toolCallId, event] as const] : [])).reverse()).values()].reverse();
    expect(firstStarts).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ file_path: '/vault/note.md' }), name: 'Read', toolCallId: 't1' }),
      expect.objectContaining({ input: expect.objectContaining({ command: 'false' }), name: 'Bash', toolCallId: 't2' }),
    ]);
    expect(events.filter(event => event.type === 'tool_completed')).toEqual([
      expect.objectContaining({ content: 'hello world\n', isError: false, toolCallId: 't1' }),
      expect.objectContaining({ content: 'exit: 1\noops', isError: true, toolCallId: 't2' }),
    ]);
  });

  it('cancels the running prompt natively', async () => {
    const session = await createSession();
    const run = session.execute(request());
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    run.cancel();
    const events = await collect(run.events);
    expect(peer.cancelRequests).toEqual(['session-new']);
    expect(events.at(-1)).toMatchObject({ type: 'cancelled' });
    expect(session.getStatus()).toBe('idle');
  });

  it('switches models and rejects a model the session does not offer', async () => {
    const session = await createSession({}, peer => { peer.addModel('gpt-5-mini', 'GPT-5 mini'); });
    const run = session.execute(request('hi', { model: 'copilot/gpt-5-mini', reasoning: 'high' }));
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    // gpt-5-mini offers no reasoning option, so no effort is sent for it.
    expect(peer.configRequests.map(({ configId, value }) => [configId, value])).toEqual([['model', 'gpt-5-mini']]);
    peer.finishPrompt();
    await collect(run.events);

    const events = await collect(session.execute(request('hi', { model: 'copilot/unknown-model' })).events);
    expect(events.at(-1)).toMatchObject({
      category: 'configuration',
      message: expect.stringContaining('unknown-model'),
      type: 'execution_error',
    });
  });

  it('replays visible history into a new native session', async () => {
    const session = await createSession();
    const run = session.execute({
      ...request('and now?'),
      conversationHistory: [
        { content: 'Earlier question', id: 'u1', role: 'user', timestamp: 1 },
        { content: 'Earlier answer', id: 'a1', role: 'assistant', timestamp: 2 },
      ],
    });
    const peer = await spawnedProcess(1);
    await peer.waitForPrompts(1);
    const [block] = peer.prompts[0].request.prompt;
    expect(block).toMatchObject({ type: 'text' });
    expect((block as { text: string }).text).toContain('Earlier answer');
    expect((block as { text: string }).text).toContain('and now?');
    peer.finishPrompt();
    await collect(run.events);
  });
});
