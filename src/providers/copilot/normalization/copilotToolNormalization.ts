import { SESSION_TOOL_MCP_SERVER_NAME } from '@/core/session-tools/sessionToolMCP';
import {
  isSessionTool,
  TOOL_BASH,
  TOOL_EDIT,
  TOOL_GLOB,
  TOOL_GREP,
  TOOL_READ,
  TOOL_WEB_FETCH,
  TOOL_WRITE,
} from '@/core/tools/toolNames';
import type { ToolProviderPayload } from '@/core/types';
import {
  type ACPResolvedToolRawName,
  type ACPSessionNotification,
  ACPToolStreamAdapter,
} from '@/providers/acp';

/** Copilot's native tool names, as its session history records them. */
const COPILOT_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  bash: TOOL_BASH,
  create: TOOL_WRITE,
  edit: TOOL_EDIT,
  glob: TOOL_GLOB,
  grep: TOOL_GREP,
  view: TOOL_READ,
  web_fetch: TOOL_WEB_FETCH,
};

/** Copilot titles MCP tool calls `<server>-<tool>`; only Claudian's own server name is known. */
const SESSION_TOOL_PREFIX = `${SESSION_TOOL_MCP_SERVER_NAME}-`;

/** Copilot appends the shell's outcome to command output. */
const SHELL_TRAILER_PATTERN = /\n?<shellId: [^>]*? completed with exit code (-?\d+)>\s*$/;

/**
 * Copilot's live ACP tool updates carry display titles ("Viewing /path") rather than native tool names, so the
 * native name is derived from the ACP kind and raw input, matching the names its history records. Unrecognised
 * calls keep their title.
 */
export function deriveCopilotNativeToolName(
  kind: string | null | undefined,
  title: string | null | undefined,
  rawInput: unknown,
): string | undefined {
  const text = title?.trim() ?? '';
  const input = isRecord(rawInput) ? rawInput : {};
  switch (kind) {
    case 'execute':
      return 'bash';
    case 'fetch':
      return 'web_fetch';
    case 'edit':
      if (typeof input.file_text === 'string') return 'create';
      if (typeof input.path === 'string') return 'edit';
      break;
    default:
      break;
  }
  // MCP calls (reported as `read` or `other`) are titled with the bare `<server>-<tool>` name.
  if (text && !/\s/.test(text) && text.includes('-')) return text;
  if (kind === 'read' && typeof input.path === 'string') return 'view';
  return text || undefined;
}

export function normalizeCopilotToolName(rawName: string): string {
  const name = rawName.trim();
  if (name.startsWith(SESSION_TOOL_PREFIX)) {
    const sessionTool = name.slice(SESSION_TOOL_PREFIX.length);
    if (isSessionTool(sessionTool)) return sessionTool;
  }
  return Object.hasOwn(COPILOT_TOOL_NAME_MAP, name) ? COPILOT_TOOL_NAME_MAP[name] : (name || 'tool');
}

/** Projects Copilot's argument names onto the shared tool inputs; native keys stay alongside. */
export function normalizeCopilotToolInput(rawName: string, input: Record<string, unknown>): Record<string, unknown> {
  switch (rawName.trim()) {
    case 'view':
      return withAliases(input, { file_path: input.path });
    case 'create':
      return withAliases(input, { content: input.file_text, file_path: input.path });
    case 'edit':
      return withAliases(input, { file_path: input.path, new_string: input.new_str, old_string: input.old_str });
    default:
      return input;
  }
}

/**
 * Copilot reports a file read's text, a creation's confirmation and other results in `rawOutput.content`, and ends
 * command output with a `<shellId: … completed with exit code N>` trailer; a nonzero exit is the failure signal.
 */
export function normalizeCopilotToolResult(
  rawName: string,
  content: string,
  rawOutput: unknown,
): { content: string; isError: boolean } {
  const nativeText = isRecord(rawOutput) && typeof rawOutput.content === 'string' ? rawOutput.content : undefined;
  const text = nativeText ?? content;
  if (rawName.trim() === 'bash') {
    const exitCode = readShellExitCode(rawOutput) ?? readTrailerExitCode(text);
    const output = text.replace(SHELL_TRAILER_PATTERN, '').replace(/\n+$/, '');
    const failed = exitCode !== undefined && exitCode !== 0;
    return { content: failed ? [`exit: ${exitCode}`, output].filter(Boolean).join('\n') : output, isError: failed };
  }
  return { content: text, isError: false };
}

export function buildCopilotToolProviderPayload(
  rawName: string,
  rawInput: unknown,
  rawOutput: unknown,
): ToolProviderPayload {
  return {
    ...(rawInput !== undefined ? { rawInput } : {}),
    rawName,
    ...(rawOutput !== undefined ? { rawOutput } : {}),
  };
}

/**
 * A session update as one turn presents it: a tool update's title is replaced by the native tool name derived from
 * its kind and raw input, so tool presentation follows the same names as history.
 */
export function presentCopilotUpdate<T extends ACPSessionNotification['update']>(update: T): T {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return update;
  if (update.sessionUpdate === 'tool_call_update' && !update.kind && !update.title) return update;
  const name = deriveCopilotNativeToolName(update.kind, update.title, update.rawInput);
  return name ? { ...update, title: name } : update;
}

/** Copilot CLI notices (for example "Info: Disabled tools: …") stream as message text without a message id. */
export function isCopilotNotice(update: ACPSessionNotification['update']): boolean {
  return update.sessionUpdate === 'agent_message_chunk'
    && !update.messageId
    && update.content.type === 'text'
    && update.content.text.startsWith('Info: ');
}

export function createCopilotToolStreamAdapter(): ACPToolStreamAdapter {
  return new ACPToolStreamAdapter({
    buildToolProviderPayload: (rawName, rawInput, rawOutput) => buildCopilotToolProviderPayload(rawName ?? 'tool', rawInput, rawOutput),
    normalizeToolInput: (rawName, input) => normalizeCopilotToolInput(rawName ?? 'tool', input),
    normalizeToolName: rawName => normalizeCopilotToolName(rawName ?? 'tool'),
    normalizeToolResult: (rawName, content, rawOutput) => normalizeCopilotToolResult(rawName ?? 'tool', content, rawOutput),
    normalizeToolResultDetails: () => undefined,
    resolveRawToolName: (current, update) => resolveCopilotRawToolName(current, update),
  });
}

function resolveCopilotRawToolName(
  current: ACPResolvedToolRawName | undefined,
  update: { kind?: string | null; title?: string | null },
): ACPResolvedToolRawName {
  if (current?.provenance === 'title') return current;
  const title = update.title?.trim();
  if (title) return { provenance: 'title', rawName: title };
  if (current) return current;
  const kind = update.kind?.trim();
  return kind ? { provenance: 'kind', rawName: kind } : { provenance: 'fallback', rawName: 'tool' };
}

function readShellExitCode(rawOutput: unknown): number | undefined {
  if (!isRecord(rawOutput) || !Array.isArray(rawOutput.contents)) return undefined;
  for (const entry of rawOutput.contents) {
    if (isRecord(entry) && entry.type === 'shell_exit' && typeof entry.exitCode === 'number') return entry.exitCode;
  }
  return undefined;
}

function readTrailerExitCode(text: string): number | undefined {
  const match = SHELL_TRAILER_PATTERN.exec(text);
  return match ? Number(match[1]) : undefined;
}

function withAliases(input: Record<string, unknown>, aliases: Record<string, unknown>): Record<string, unknown> {
  const next = { ...input };
  for (const [key, value] of Object.entries(aliases)) {
    if (next[key] === undefined && value !== undefined) next[key] = value;
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
