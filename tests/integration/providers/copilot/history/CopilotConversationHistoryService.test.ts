// @test-ci {"inputs":["tests/fixtures/providers/copilot/history/**"]}
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHistoryEnvironment, ProviderHistoryInput } from '@/core/providers/types';
import { CopilotConversationHistoryService } from '@/providers/copilot/history/CopilotConversationHistoryService';

/** Event logs captured from copilot 1.0.114 (paths rewritten to /vault, opaque reasoning trimmed). */
const FIXTURES = path.resolve('tests/fixtures/providers/copilot/history');
const service = new CopilotConversationHistoryService();
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-copilot-home-'));
});

afterEach(async () => {
  await fs.rm(home, { force: true, recursive: true });
});

async function installEvents(copilotHome: string, sessionId: string, fixture: string): Promise<void> {
  const directory = path.join(copilotHome, 'session-state', sessionId);
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(path.join(FIXTURES, fixture), path.join(directory, 'events.jsonl'));
}

function conversation(overrides: Partial<ProviderHistoryInput>): ProviderHistoryInput {
  return { messages: [], providerState: undefined, sessionId: null, ...overrides } as ProviderHistoryInput;
}

function homeContext(): ProviderHistoryEnvironment {
  return { environment: { HOME: home, USERPROFILE: home }, hostPlatform: process.platform };
}

describe('CopilotConversationHistoryService', () => {
  it('rebuilds a tool-using turn from the event log under ~/.copilot', async () => {
    await installEvents(path.join(home, '.copilot'), 'session-live', 'tool-turn.jsonl');
    const hydrated = await service.hydrateConversationHistory(conversation({ sessionId: 'session-live' }), null, homeContext());
    const messages = hydrated.messages ?? [];
    const [user, assistant] = messages;

    // The session continued after a reload with two more prompts.
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(messages[3].toolCalls?.map(call => call.name)).toEqual(['Bash']);
    expect(user).toMatchObject({
      content: 'Read note.md, then create out.md containing its content uppercased, then run `ls` in the shell. Be brief.',
      role: 'user',
    });
    expect(assistant).toMatchObject({ role: 'assistant', turnId: user.turnId });
    expect(assistant.content).toContain('Done. Created out.md');
    expect(assistant.durationSeconds).toEqual(expect.any(Number));
    expect(assistant.toolCalls?.map(call => [call.name, call.status, call.result])).toEqual([
      ['Read', 'completed', 'note.md'],
      ['Bash', 'completed', expect.stringContaining('note.md')],
      ['Read', 'completed', 'hello world\n'],
      ['Write', 'completed', 'Created file /vault/out.md with 12 characters'],
      ['Bash', 'completed', 'note.md'],
    ]);
    expect(assistant.toolCalls?.[3]).toMatchObject({
      diffData: expect.objectContaining({ filePath: '/vault/out.md' }),
      input: expect.objectContaining({ content: 'HELLO WORLD\n', file_path: '/vault/out.md' }),
    });
    // The shell trailer is Copilot bookkeeping, not command output.
    expect(assistant.toolCalls?.[1].result).not.toContain('shellId');
  });

  it('marks a stopped turn interrupted and keeps reasoning from the log', async () => {
    const copilotHome = path.join(home, 'custom-home');
    await installEvents(copilotHome, 'session-aborted', 'aborted-turn.jsonl');
    const hydrated = await service.hydrateConversationHistory(
      conversation({ sessionId: 'session-aborted' }),
      null,
      { environment: { COPILOT_HOME: copilotHome, HOME: home, USERPROFILE: home }, hostPlatform: process.platform },
    );
    const messages = hydrated.messages ?? [];

    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(messages[1].contentBlocks?.[0]).toMatchObject({ type: 'thinking' });
    // The essay prompt was stopped before Copilot recorded any output.
    expect(messages[2].content).toBe('Write a 600 word essay about the sea. No tools.');
    expect(messages[3]).toMatchObject({ content: '', isInterrupt: true });
    expect(messages[1].isInterrupt).toBeUndefined();
    expect(messages[5].isInterrupt).toBeUndefined();
  });

  it('marks native context established when the bound session already has a log', async () => {
    await installEvents(path.join(home, '.copilot'), 'session-live', 'tool-turn.jsonl');
    const hydrated = await service.hydrateConversationHistory(conversation({
      providerState: { nativeConversationContextEstablished: false },
      sessionId: 'session-live',
    }), null, homeContext());

    expect(hydrated.providerState).toMatchObject({ nativeConversationContextEstablished: true });
    await expect(service.readNativeHistoryRevision(conversation({ sessionId: 'session-live' }), null, homeContext()))
      .resolves.toEqual(expect.any(String));
  });

  it('leaves a conversation without a native log unchanged', async () => {
    const input = conversation({ messages: [{ content: 'kept', id: 'u', role: 'user', timestamp: 1 }], sessionId: 'session-none' });
    const hydrated = await service.hydrateConversationHistory(input, null, homeContext());
    expect(hydrated.messages).toEqual(input.messages);
    await expect(service.readNativeHistoryRevision(input, null, homeContext())).resolves.toBeNull();
  });
});
