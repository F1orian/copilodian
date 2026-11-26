import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Copilot reads every `*.instructions.md` under the directories listed here, in addition to native ones. */
export const COPILOT_CUSTOM_INSTRUCTIONS_DIRS_ENV = 'COPILOT_CUSTOM_INSTRUCTIONS_DIRS';
const COPILOT_INSTRUCTIONS_FILE_NAME = 'copilodian.instructions.md';

/**
 * One process's Claudian instructions. Copilot has no ACP field for a system prompt and reads custom instruction
 * files once when its process starts, so the text is delivered as a file in a directory owned by that process and
 * removed with it. Native instruction files (AGENTS.md, CLAUDE.md, Copilot instructions) still apply.
 */
export interface CopilotInstructionsDirectory {
  readonly directory: string;
  readonly environment: Readonly<Record<string, string>>;
  dispose(): Promise<void>;
}

export async function createCopilotInstructionsDirectory(
  instructions: string,
  inheritedDirectories: string | undefined,
): Promise<CopilotInstructionsDirectory> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claudian-copilot-'));
  try {
    await writeFile(path.join(directory, COPILOT_INSTRUCTIONS_FILE_NAME), instructions, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
  const inherited = inheritedDirectories?.trim();
  let disposal: Promise<void> | null = null;
  return {
    directory,
    environment: {
      [COPILOT_CUSTOM_INSTRUCTIONS_DIRS_ENV]: inherited ? `${inherited},${directory}` : directory,
    },
    dispose() {
      disposal ??= rm(directory, { force: true, recursive: true }).catch(() => undefined);
      return disposal;
    },
  };
}
