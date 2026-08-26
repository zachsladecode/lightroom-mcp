import net from "node:net";
import { LineBuffer, encodeIpcMessage, type IpcClientMessage, type IpcServerMessage } from "./ipc-protocol.js";
import type { PluginResponse } from "./dispatcher.js";

export interface SecondaryIpcClientOptions {
  address: string;
  /** Timeout for connect() and for each individual call()/status() round trip. */
  timeoutMs?: number;
  /**
   * Fired at most once, only when the connection is lost unexpectedly (the
   * primary process died, was killed, or its listener otherwise dropped us)
   * -- never when this side called stop() itself. bridge-coordinator uses
   * this as the trigger for self-healing failover: try to resolve a role
   * again immediately instead of leaving the bridge dead until a human
   * restarts something.
   */
  onDisconnect?: () => void;
  log?: (msg: string) => void;
}

interface Pending {
  resolve: (msg: IpcServerMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Client half of the local primary<->secondary IPC channel (see
 * ipc-server.ts). `.call()` matches Dispatcher's public signature exactly
 * (`Pick<Dispatcher, "call">`), so this is a drop-in dispatcher: when this
 * process is a secondary, bridge-coordinator hands one of these straight to
 * createMcpServer / tool-handler in place of a real plugin-connected
 * Dispatcher. Single-use: connect() once, use it, then stop() and construct
 * a fresh instance for any later reconnect attempt -- keeps this class free
 * of internal reconnect-state-machine bugs.
 */
export class SecondaryIpcClient {
  private socket: net.Socket | null = null;
  private readonly buffer = new LineBuffer();
  private readonly pending = new Map<string, Pending>();
  private idCounter = 0;
  private stopped = false;

  private readonly address: string;
  private readonly timeoutMs: number;
  private readonly onDisconnectCb?: () => void;
  private readonly log: (msg: string) => void;

  constructor(opts: SecondaryIpcClientOptions) {
    this.address = opts.address;
    this.timeoutMs = opts.timeoutMs ?? 3_000;
    this.onDisconnectCb = opts.onDisconnect;
    this.log = opts.log ?? ((msg) => console.error(msg));
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.address);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`Timed out connecting to primary bridge at ${this.address}`));
      }, this.timeoutMs);

      sock.once("connect", () => {
        clearTimeout(timer);
        sock.setEncoding("utf8");
        this.socket = sock;
        this.wire(sock);
        resolve();
      });
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private wire(sock: net.Socket): void {
    sock.on("data", (chunk: string) => {
      for (const line of this.buffer.push(chunk)) {
        this.handleLine(line);
      }
    });
    sock.on("close", () => {
      if (this.stopped) return;
      this.stopped = true;
      this.socket = null;
      this.failAllPending(new Error("Lost connection to primary Lightroom MCP bridge"));
      this.onDisconnectCb?.();
    });
    sock.on("error", (err) => {
      this.log(`[ipc-client] socket error: ${err.message}`);
    });
  }

  private handleLine(line: string): void {
    let msg: IpcServerMessage;
    try {
      msg = JSON.parse(line) as IpcServerMessage;
    } catch (err) {
      this.log(`[ipc-client] bad JSON from primary: ${(err as Error).message}`);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(msg.id);
    p.resolve(msg);
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  async call(action: string, params: unknown): Promise<PluginResponse> {
    const id = `ipc_${Date.now()}_${this.idCounter++}`;
    const reply = await this.roundTrip({ type: "call", id, action, params });
    if (reply.type !== "result") {
      throw new Error(`Unexpected reply type "${reply.type}" from primary bridge`);
    }
    return { id, result: reply.result, error: reply.error };
  }

  async status(): Promise<{ ready: boolean; message?: string }> {
    const id = `ipc_${Date.now()}_${this.idCounter++}`;
    const reply = await this.roundTrip({ type: "status", id });
    if (reply.type !== "status") {
      throw new Error(`Unexpected reply type "${reply.type}" from primary bridge`);
    }
    return { ready: reply.ready, message: reply.message };
  }

  private roundTrip(msg: IpcClientMessage): Promise<IpcServerMessage> {
    if (!this.socket) return Promise.reject(new Error("Not connected to primary bridge"));
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new Error(`Primary bridge did not respond within ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(msg.id, { resolve, reject, timer });
      socket.write(encodeIpcMessage(msg));
    });
  }

  isConnected(): boolean {
    return this.socket !== null;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.failAllPending(new Error("Secondary IPC client stopped"));
    this.socket?.destroy();
    this.socket = null;
  }
}
