import * as os from 'node:os';
import * as path from 'node:path';

const SESSION_ID_PATTERN = /^[\w-]+$/;

/** Copilot's state root: `$COPILOT_HOME`, else `~/.copilot`. */
export function resolveCopilotHome(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const configured = environment.COPILOT_HOME?.trim();
  if (configured) return configured;
  const home = platform === 'win32'
    ? environment.USERPROFILE || os.homedir()
    : environment.HOME || os.homedir();
  return home ? path.join(home, '.copilot') : null;
}

/** The event log Copilot keeps for one session. */
export function resolveCopilotEventsPath(copilotHome: string, sessionId: string): string | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  return path.join(copilotHome, 'session-state', sessionId, 'events.jsonl');
}
