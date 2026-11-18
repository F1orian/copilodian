import * as fs from 'node:fs/promises';

import { resolveToolDiffData } from '@/core/tools/toolDiff';
import { isWriteEditTool } from '@/core/tools/toolNames';
import type { ChatMessage, ContentBlock, ToolCallInfo } from '@/core/types';
import { readFileRevision } from '@/utils/fileRevision';
import { forEachJSONLLine } from '@/utils/jsonlFile';

import {
  buildCopilotToolProviderPayload,
  normalizeCopilotToolInput,
  normalizeCopilotToolName,
  normalizeCopilotToolResult,
} from '../normalization/copilotToolNormalization';
import { resolveCopilotEventsPath } from './CopilotHistoryPaths';

/** One record of Copilot's `events.jsonl`; only the fields history uses are typed. */
export interface CopilotSessionEvent {
  data?: Record<string, unknown>;
  id?: string;
  timestamp?: string;
  type?: string;
}

interface TurnBuilder {
  readonly assistant: ChatMessage;
  readonly blocks: ContentBlock[];
  readonly interactionId: string | undefined;
  readonly pending: Map<string, { readonly call: ToolCallInfo; readonly rawName: string; readonly rawInput: Record<string, unknown> }>;
  readonly requestedAt?: number;
  readonly toolCalls: ToolCallInfo[];
  completedAt?: number;
  interrupted: boolean;
}

/** Reads a session's event log; a missing log yields no events. */
export async function readCopilotEvents(copilotHome: string, sessionId: string): Promise<CopilotSessionEvent[] | null> {
  const eventsPath = resolveCopilotEventsPath(copilotHome, sessionId);
  if (!eventsPath) return null;
  try {
    await fs.access(eventsPath);
  } catch {
    return null;
  }
  const events: CopilotSessionEvent[] = [];
  await forEachJSONLLine(eventsPath, line => {
    try {
      const event: unknown = JSON.parse(line);
      if (event && typeof event === 'object' && !Array.isArray(event)) events.push(event);
    } catch {
      // A partially written last line is skipped; the next read sees it complete.
    }
  });
  return events;
}

export async function loadCopilotHistory(copilotHome: string, sessionId: string): Promise<ChatMessage[]> {
  const events = await readCopilotEvents(copilotHome, sessionId);
  return events ? parseCopilotEvents(events, sessionId) : [];
}

export async function readCopilotHistoryRevision(copilotHome: string, sessionId: string): Promise<string | null> {
  const eventsPath = resolveCopilotEventsPath(copilotHome, sessionId);
  return eventsPath ? readFileRevision(eventsPath) : null;
}

/**
 * Builds chat messages from Copilot's session events. A user message opens a turn (Copilot's `interactionId`);
 * assistant messages add text, reasoning and tool requests, whose results arrive as `tool.execution_complete` by
 * tool call id. An `abort` marks the turn interrupted. Subagent messages (with a parent tool call) stay inside the
 * subagent and are not shown.
 */
export function parseCopilotEvents(events: readonly CopilotSessionEvent[], sessionId: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let turn: TurnBuilder | null = null;

  const finishTurn = (endOfLog = false): void => {
    if (!turn) return;
    const { assistant, blocks, completedAt, interrupted, pending, requestedAt, toolCalls } = turn;
    // Calls without a result were stopped with the turn, or are still running at the end of the log.
    for (const { call } of pending.values()) {
      if (!endOfLog || interrupted) call.status = 'error';
    }
    if (interrupted) assistant.isInterrupt = true;
    else if (completedAt && requestedAt && completedAt >= requestedAt) {
      assistant.completedAt = completedAt;
      assistant.durationSeconds = Math.floor((completedAt - requestedAt) / 1_000);
    }
    // A turn stopped before any output still shows that it was interrupted.
    if (assistant.content || blocks.length > 0 || toolCalls.length > 0 || interrupted) {
      if (blocks.length > 0) assistant.contentBlocks = blocks;
      if (toolCalls.length > 0) assistant.toolCalls = toolCalls;
      messages.push(assistant);
    }
    turn = null;
  };

  const startTurn = (key: string, timestamp: number, interactionId: string | undefined, automatic: boolean): TurnBuilder => {
    finishTurn();
    const id = `${sessionId}:${key}:assistant`;
    turn = {
      assistant: {
        assistantMessageId: id,
        content: '',
        id,
        role: 'assistant',
        timestamp,
        turnId: interactionId ?? id,
        ...(automatic ? { isAutomaticResponse: true } : {}),
      },
      blocks: [],
      interactionId,
      interrupted: false,
      pending: new Map(),
      ...(automatic ? {} : { requestedAt: timestamp }),
      toolCalls: [],
    };
    return turn;
  };

  for (const [index, event] of events.entries()) {
    const data = event.data ?? {};
    const key = typeof event.id === 'string' && event.id ? event.id : String(index);
    const timestamp = parseTimestamp(event.timestamp);
    const interactionId = readString(data.interactionId);
    switch (event.type) {
      case 'user.message': {
        finishTurn();
        const content = readString(data.content) ?? '';
        const id = `${sessionId}:${key}:user`;
        messages.push({
          content,
          id,
          role: 'user',
          timestamp,
          ...(interactionId ? { turnId: interactionId } : {}),
          userMessageId: readString(data.messageId) ?? id,
        });
        startTurn(key, timestamp, interactionId, false);
        break;
      }
      case 'assistant.message': {
        if (readString(data.parentToolCallId)) break;
        const open = turn as TurnBuilder | null;
        // A reply Copilot starts on its own (another interaction) opens a response without a user request.
        const current: TurnBuilder = open && (!interactionId || !open.interactionId || open.interactionId === interactionId)
          ? open
          : startTurn(key, timestamp, interactionId, true);
        const reasoning = readString(data.reasoningText);
        if (reasoning) appendBlock(current.blocks, 'thinking', reasoning);
        const content = readString(data.content);
        if (content) {
          appendBlock(current.blocks, 'text', content);
          current.assistant.content += current.assistant.content ? `\n\n${content}` : content;
        }
        const requests = Array.isArray(data.toolRequests) ? data.toolRequests : [];
        for (const request of requests) {
          if (!isRecord(request)) continue;
          const toolCallId = readString(request.toolCallId);
          if (!toolCallId) continue;
          const rawName = readString(request.name) ?? 'tool';
          const rawInput = isRecord(request.arguments) ? { ...request.arguments } : {};
          const call: ToolCallInfo = {
            id: toolCallId,
            input: normalizeCopilotToolInput(rawName, rawInput),
            name: normalizeCopilotToolName(rawName),
            providerPayload: buildCopilotToolProviderPayload(rawName, rawInput, undefined),
            status: 'running',
          };
          current.toolCalls.push(call);
          current.blocks.push({ toolId: call.id, type: 'tool_use' });
          current.pending.set(toolCallId, { call, rawInput, rawName });
        }
        break;
      }
      case 'tool.execution_complete': {
        const toolCallId = readString(data.toolCallId);
        const pending = toolCallId ? (turn as TurnBuilder | null)?.pending.get(toolCallId) : undefined;
        if (!pending || !toolCallId) break;
        (turn as TurnBuilder | null)?.pending.delete(toolCallId);
        completeTool(pending.call, pending.rawName, pending.rawInput, data);
        break;
      }
      case 'assistant.turn_end': {
        const current = turn as TurnBuilder | null;
        if (current) current.completedAt = timestamp || current.completedAt;
        break;
      }
      case 'abort': {
        const current = turn as TurnBuilder | null;
        if (current) current.interrupted = true;
        break;
      }
      default:
        break;
    }
  }
  finishTurn(true);
  return messages;
}

function completeTool(
  call: ToolCallInfo,
  rawName: string,
  rawInput: Record<string, unknown>,
  data: Record<string, unknown>,
): void {
  const success = data.success !== false;
  const result = isRecord(data.result) ? data.result : undefined;
  const errorText = isRecord(data.error) ? readString(data.error.message) : readString(data.error);
  const content = readString(result?.content) ?? errorText ?? '';
  const exitCode = isRecord(data.shellExecution) && typeof data.shellExecution.exitCode === 'number'
    ? data.shellExecution.exitCode
    : undefined;
  const rawOutput = exitCode === undefined ? result : { ...result, contents: [{ exitCode, type: 'shell_exit' }] };
  const normalized = normalizeCopilotToolResult(rawName, content, rawOutput);
  if (normalized.content) call.result = normalized.content;
  call.status = !success || normalized.isError ? 'error' : 'completed';
  call.providerPayload = buildCopilotToolProviderPayload(rawName, rawInput, result);
  if (call.name === 'Read') call.resultFormat = 'plain';
  if (call.status === 'completed' && isWriteEditTool(call.name)) {
    const diffData = resolveToolDiffData(undefined, call);
    if (diffData) call.diffData = diffData;
  }
}

function appendBlock(blocks: ContentBlock[], type: 'text' | 'thinking', content: string): void {
  const previous = blocks[blocks.length - 1];
  if (previous?.type === type) previous.content += `\n\n${content}`;
  else blocks.push({ content, type });
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function parseTimestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
