import type { PluginResponse } from "./dispatcher.js";

export interface CallableDispatcher {
  call(action: string, params: unknown): Promise<PluginResponse>;
}

/**
 * Dispatcher handed to createMcpServer exactly once at startup. Its target
 * swaps underneath -- from nothing yet, to a SecondaryIpcClient forwarding to
 * another process, to a real plugin-connected Dispatcher, and back -- as
 * bridge-coordinator resolves and re-resolves this process's role, without
 * ever needing to tear down and recreate the MCP server or its transport.
 */
export class SwitchableDispatcher implements CallableDispatcher {
  private target: CallableDispatcher | null = null;

  setTarget(target: CallableDispatcher | null): void {
    this.target = target;
  }

  async call(action: string, params: unknown): Promise<PluginResponse> {
    if (!this.target) {
      throw new Error("Lightroom MCP bridge is not ready yet");
    }
    return this.target.call(action, params);
  }
}
