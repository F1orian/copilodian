import {
  deriveCopilotNativeToolName,
  isCopilotNotice,
  normalizeCopilotToolInput,
  normalizeCopilotToolName,
  normalizeCopilotToolResult,
} from '@/providers/copilot/normalization/copilotToolNormalization';

describe('Copilot tool normalization', () => {
  // Kinds, titles and raw inputs as copilot 1.0.114 streams them.
  it.each([
    ['read', 'Viewing /vault/note.md', { path: '/vault/note.md' }, 'view', 'Read'],
    ['execute', 'List directory contents', { command: 'ls -la', description: 'List directory contents' }, 'bash', 'Bash'],
    ['edit', 'Creating /vault/out.md', { file_text: 'HELLO\n', path: '/vault/out.md' }, 'create', 'Write'],
    ['edit', 'Editing /vault/out.md', { new_str: 'b', old_str: 'a', path: '/vault/out.md' }, 'edit', 'Edit'],
    ['fetch', 'Fetching https://example.com', { url: 'https://example.com' }, 'web_fetch', 'WebFetch'],
    ['read', 'copilodian_sessions-copilodian_list_destinations', {}, 'copilodian_sessions-copilodian_list_destinations', 'copilodian_list_destinations'],
    ['read', 'github-mcp-server-get_me', {}, 'github-mcp-server-get_me', 'github-mcp-server-get_me'],
    ['search', 'Searching for TODO', { pattern: 'TODO' }, 'Searching for TODO', 'Searching for TODO'],
  ])('derives %s "%s" as %s and presents it as %s', (kind, title, rawInput, nativeName, claudianName) => {
    const derived = deriveCopilotNativeToolName(kind, title, rawInput);
    expect(derived).toBe(nativeName);
    expect(normalizeCopilotToolName(derived!)).toBe(claudianName);
  });

  it('maps native history names and aliases their arguments', () => {
    expect(['view', 'bash', 'create', 'edit', 'glob', 'grep', 'web_fetch', 'task'].map(normalizeCopilotToolName))
      .toEqual(['Read', 'Bash', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'task']);
    expect(normalizeCopilotToolInput('edit', { new_str: 'b', old_str: 'a', path: '/v/a.md' }))
      .toEqual({ file_path: '/v/a.md', new_str: 'b', new_string: 'b', old_str: 'a', old_string: 'a', path: '/v/a.md' });
    expect(normalizeCopilotToolInput('create', { file_text: 'x', path: '/v/a.md' }))
      .toMatchObject({ content: 'x', file_path: '/v/a.md' });
  });

  it('strips the shell trailer and fails on a nonzero exit', () => {
    expect(normalizeCopilotToolResult('bash', 'note.md\n<shellId: 1 completed with exit code 0>', undefined))
      .toEqual({ content: 'note.md', isError: false });
    expect(normalizeCopilotToolResult('bash', '', { content: 'boom\n<shellId: 2 completed with exit code 2>', contents: [{ exitCode: 2, type: 'shell_exit' }] }))
      .toEqual({ content: 'exit: 2\nboom', isError: true });
    // A read reports its text in rawOutput.content; the ACP fallback would be the whole object as JSON.
    expect(normalizeCopilotToolResult('view', '{"content":"hi"}', { content: 'hi', detailedContent: 'diff' }))
      .toEqual({ content: 'hi', isError: false });
  });

  it('recognises CLI notices only when they carry no message id', () => {
    const notice = { content: { text: 'Info: Disabled tools: bash', type: 'text' as const }, sessionUpdate: 'agent_message_chunk' as const };
    expect(isCopilotNotice(notice)).toBe(true);
    expect(isCopilotNotice({ ...notice, messageId: 'm1' })).toBe(false);
    expect(isCopilotNotice({ ...notice, content: { text: 'Error: Model not found', type: 'text' } })).toBe(false);
  });
});
