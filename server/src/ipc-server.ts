import net from "node:net";
import fs from "node:fs";
import { LineBuffer, encodeIpcMessage, type IpcClientMessage } from "./ipc-protocol.js";
import type { PluginResponse } from "./dispatcher.js";

export interface PrimaryIpcServerOptions {
  address: string;
  dispatcher: { call(action: string, params: unknown): Promise<PluginResponse> };
  isReady: () => boolean;
  notReadyMessage?: () => string | undefined;
  log?: (msg: string) => void;
}

/**
 * Local channel the primary bridge exposes so other lightroom-mcp processes
 * spawned on this machine (a second MCP host, a second Claude Code/Cowork
 * session, a stray disposable handshake sibling...) can share this process's
 * single plugin connection instead of each fighting to open their own -- the
 * plugin only ever accepts one client per port (see AGENTS.md). Counterpart
 * to `SecondaryIpcClient`, which speaks this same protocol from the other
 * end. Owned by bridge-coordinator.ts; not used directly by index.ts.
 */
export class PrimaryIpcServer {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly address: string;
  private readonly dispatcher: PrimaryIpcServerOptions["dispatcher"];
  private readonly isReady: () => boolean;
  private readonly notReadyMessage?: () => string | undefined;
  private readonly log: (msg: string) => void;

  constructor(opts: PrimaryIpcServerOptions) {
    this.address = opts.address;
    this.dispatcher = opts.dispatcher;
    this.isReady = opts.isReady;
    this.notReadyMessage = opts.notReadyMessage;
    this.log = opts.log ?? ((msg) => console.error(msg));
  }

  async start(): Promise<void> {
    await this.clearStaleAddress();
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer((socket) => this.handleConnection(socket));
      srv.once("error", reject);
      srv.listen(this.address, () => {
        srv.off("error", reject);
        srv.on("error", (err) => this.log(`[ipc-server] error: ${(err as Error).message}`));
        this.server = srv;
        resolve();
      });
    });
  }

  // A leftover Unix-domain-socket file from a process that crashed without
  // closing its listener blocks a fresh `.listen()` with EADDRINUSE even
  // though nothing is actually listening on it any more. Probe it with a
  // real connection attempt (the only reliable way to tell "stale file" from
  // "someone's already listening") before deciding to unlink it. Windows
  // named pipes have no filesystem entry to leak, so this is a no-op there.
  private async clearStaleAddress(): Promise<void> {
    if (process.platform === "win32") return;
    if (!fs.existsSync(this.address)) return;
    const stale = await new Promise<boolean>((resolve) => {
      const probe = net.createConnection(this.address);
      probe.once("connect", () => {
        probe.destroy();
        resolve(false);
      });
      probe.once("error", () => resolve(true));
    });
    if (!stale) return;
    try {
      fs.unlinkSync(this.address);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private handleConnection(socket: net.Socket): void {
    socket.setEncoding("utf8");
    this.sockets.add(socket);
    const buffer = new LineBuffer();
    socket.on("data", (chunk: string) => {
      for (const line of buffer.push(chunk)) {
        void this.handleLine(socket, line);
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
    });
    socket.on("error", () => {
      // A secondary that vanished mid-request; 'close' handles cleanup.
    });
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let msg: IpcClientMessage;
    try {
      msg = JSON.parse(line) as IpcClientMessage;
    } catch (err) {
      this.log(`[ipc-server] bad JSON from secondary: ${(err as Error).message}`);
      return;
    }

    if (msg.type === "status") {
      const ready = this.isReady();
      if (socket.writable) {
        socket.write(
          encodeIpcMessage({
            type: "status",
            id: msg.id,
            ready,
            message: ready ? undefined : this.notReadyMessage?.(),
          }),
        );
      }
      return;
    }

    if (msg.type === "call") {
      let resultMsg: { type: "result"; id: string; result?: unknown; error?: string };
      try {
        const resp = await this.dispatcher.call(msg.action, msg.params);
        resultMsg = { type: "result", id: msg.id, result: resp.result, error: resp.error };
      } catch (err) {
        resultMsg = { type: "result", id: msg.id, error: err instanceof Error ? err.message : String(err) };
      }
      if (socket.writable) socket.write(encodeIpcMessage(resultMsg));
    }
  }

  async stop(): Promise<void> {
    const srv = this.server;
    this.server = null;
    if (!srv) return;
    // Destroy connected secondaries too, not just the listener -- close()
    // alone only stops accepting *new* connections, and would otherwise
    // leave every attached secondary's pending calls hanging indefinitely
    // (until their own timeout) instead of failing fast so they can start
    // failing over. Mirrors an actual primary crash from a secondary's
    // point of view.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(this.address);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.log(`[ipc-server] cleanup failed: ${(err as Error).message}`);
      }
    }
  }
}
