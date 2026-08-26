// Wire protocol for the local primary<->secondary IPC channel (see
// bridge-coordinator.ts, ipc-server.ts, ipc-client.ts). Line-delimited JSON,
// mirroring the framing the plugin's own TCP protocol uses in
// plugin-socket.ts -- one JSON object per line, "\n" terminated.

export interface IpcCallMessage {
  type: "call";
  id: string;
  action: string;
  params: unknown;
}

export interface IpcStatusRequestMessage {
  type: "status";
  id: string;
}

export type IpcClientMessage = IpcCallMessage | IpcStatusRequestMessage;

export interface IpcResultMessage {
  type: "result";
  id: string;
  result?: unknown;
  error?: string;
}

export interface IpcStatusReplyMessage {
  type: "status";
  id: string;
  ready: boolean;
  message?: string;
}

export type IpcServerMessage = IpcResultMessage | IpcStatusReplyMessage;

export function encodeIpcMessage(msg: IpcClientMessage | IpcServerMessage): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Incremental newline-delimited-JSON line splitter. PluginSocket and the
 * fake-plugin test helper each hand-roll an identical buffer-until-"\n" loop
 * for the plugin's own TCP framing; pulled out here once rather than adding
 * a third hand-rolled copy for the IPC channel.
 */
export class LineBuffer {
  private buf = "";

  /** Feed a chunk in, get back zero or more complete (trimmed, non-empty) lines. */
  push(chunk: string): string[] {
    this.buf += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) lines.push(line);
    }
    return lines;
  }
}
