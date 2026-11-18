import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import type { SlashCommand } from '@/core/types';

/**
 * Built-in Copilot commands that conflict with what Claudian controls: the model and permission mode are chosen in
 * Claudian, plan and autopilot are modes Claudian cannot represent, the working directory is the vault, and
 * scheduled or remote work is not streamed back to the chat.
 */
export const COPILOT_HIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  'add-dir',
  'after',
  'allow-all',
  'autopilot',
  'cwd',
  'every',
  'fleet',
  'list-dirs',
  'model',
  'permissions',
  'plan',
  'remote',
  'reset-allowed-tools',
  'yolo',
]);

export function filterCopilotCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return commands.filter(command => !COPILOT_HIDDEN_COMMANDS.has(command.name.toLowerCase()));
}

function slashCommandToEntry(command: SlashCommand): ProviderCommandEntry {
  return {
    agent: command.agent,
    allowedTools: command.allowedTools,
    argumentHint: command.argumentHint,
    content: command.content,
    context: command.context,
    description: command.description,
    disableModelInvocation: command.disableModelInvocation,
    displayPrefix: '/',
    hooks: command.hooks,
    id: command.id,
    insertPrefix: '/',
    isDeletable: false,
    isEditable: false,
    kind: command.kind ?? 'command',
    model: command.model,
    name: command.name,
    providerId: 'copilot',
    scope: 'runtime',
    source: command.source ?? 'sdk',
    userInvocable: command.userInvocable,
  };
}

export class CopilotCommandCatalog extends RuntimeCommandCatalog {
  constructor() {
    super({
      dropdownConfig: {
        builtInPrefix: '/',
        commandPrefix: '/',
        providerId: 'copilot',
        skillPrefix: '/',
        triggerChars: ['/'],
      },
      projectEntry: slashCommandToEntry,
    });
  }
}
