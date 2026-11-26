import type { TargetLaunchSpec } from '@/core/process/execution-target/types';
import {
  type ACPClientConnection,
  type ACPLoadSessionRequest,
  type ACPLoadSessionResponse,
  ACPNativeProcess,
  type ACPNewSessionRequest,
  type ACPNewSessionResponse,
  type ACPPromptRequest,
  type ACPPromptResponse,
  type ACPRequestPermissionRequest,
  type ACPRequestPermissionResponse,
  type ACPSessionNotification,
  type ACPSetSessionConfigOptionRequest,
  type ACPSetSessionConfigOptionResponse,
} from '@/providers/acp';

export const COPILOT_ACP_ARGS = ['--acp', '--stdio'] as const;
/**
 * Copilot applies tool filters to every session its process opens. Listing only a tool that does not exist leaves
 * no tools; Copilot reports the unknown name as an `Info:` notice, which is not shown.
 */
export const COPILOT_NO_TOOLS_ARGS = ['--available-tools=copilodian_no_tools'] as const;

export interface CopilotNativeConnectionOptions {
  readonly launch: TargetLaunchSpec;
  readonly version: string;
  readonly requestPermission: (request: ACPRequestPermissionRequest) => Promise<ACPRequestPermissionResponse>;
}

/** One `copilot --acp --stdio` process and its ACP client. */
export class CopilotNativeConnection {
  readonly launch: TargetLaunchSpec;
  private readonly listeners = new Set<(notification: ACPSessionNotification) => void>();
  private readonly native: ACPNativeProcess;

  constructor(options: CopilotNativeConnectionOptions) {
    this.launch = options.launch;
    this.native = new ACPNativeProcess({
      launch: {
        args: options.launch.args,
        command: options.launch.command,
        cwd: options.launch.spawnCwd,
        env: options.launch.env,
        windowsVerbatimArguments: options.launch.windowsVerbatimArguments,
      },
      version: options.version,
      delegate: {
        onSessionNotification: notification => {
          for (const listener of this.listeners) listener(notification);
        },
        requestPermission: options.requestPermission,
      },
    });
  }

  private get client(): ACPClientConnection {
    return this.native.client;
  }

  async initialize(): Promise<void> {
    await this.client.initialize();
  }

  newSession(request: ACPNewSessionRequest): Promise<ACPNewSessionResponse> {
    return this.client.newSession(request);
  }

  loadSession(request: ACPLoadSessionRequest): Promise<ACPLoadSessionResponse> {
    return this.client.loadSession(request);
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.client.closeSession({ sessionId });
  }

  setConfigOption(request: ACPSetSessionConfigOptionRequest): Promise<ACPSetSessionConfigOptionResponse> {
    return this.client.setConfigOption(request);
  }

  prompt(request: ACPPromptRequest): Promise<ACPPromptResponse> {
    return this.client.prompt(request);
  }

  cancel(sessionId: string): void {
    this.client.cancel({ sessionId });
  }

  isAlive(): boolean {
    return this.native.isAlive();
  }

  onClose(listener: (error?: Error) => void): () => void {
    return this.native.onClose(listener);
  }

  onNotification(listener: (notification: ACPSessionNotification) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  shutdown(): Promise<void> {
    return this.native.shutdown(() => this.listeners.clear());
  }
}
