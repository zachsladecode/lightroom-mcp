#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PluginSocket } from "./plugin-socket.js";
import { Dispatcher } from "./dispatcher.js";
import { readToken, tokenFilePath } from "./token.js";
import { requestPort, responsePort } from "./ports.js";
import { createMcpServer } from "./create-server.js";
import { parseCli, helpText } from "./cli.js";
import { VERSION } from "./version.js";
import { startHeartbeat } from "./heartbeat.js";
import { BridgeCoordinator, type PrimaryHandles } from "./bridge-coordinator.js";
import {
  ensurePluginInstalled,
  findBundledPlugin,
  installPlugin,
  lightroomModulesDir,
} from "./install-plugin.js";

const REQUEST_TIMEOUT_MS = 30_000;
// Batch export/import render files and can run for minutes; the default
// timeout would report a spurious failure mid-export. See issue #128.
const LONG_RUNNING_TIMEOUT_MS = 300_000;
// Keep this interval in sync with HEARTBEAT_INTERVAL_SECONDS in
// PluginInfoProvider.lua. See heartbeat.ts for what this drives.
const HEARTBEAT_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MS = 10_000;
const RESPONSE_CONNECT_SETTLE_MS = 200;
const ACTION_TIMEOUTS_MS: Record<string, number> = {
  export_photos: LONG_RUNNING_TIMEOUT_MS,
  import_photos: LONG_RUNNING_TIMEOUT_MS,
  ping: PING_TIMEOUT_MS,
};

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Wires the real TCP connection to the plugin's request/response ports.
 * Only ever invoked by BridgeCoordinator, and only once this process has
 * actually won the "primary" role for these ports -- the plugin accepts
 * exactly one client per port, so nothing else may call this. See
 * bridge-coordinator.ts for how every other lightroom-mcp process on this
 * machine instead attaches to whichever process did win, over local IPC.
 */
function startPrimaryHandles(requestPortNum: number, responsePortNum: number): PrimaryHandles {
  let requestSocket: PluginSocket;
  let responseSocket: PluginSocket | null = null;
  let responseConnectTimer: NodeJS.Timeout | null = null;

  const dispatcher = new Dispatcher({
    send: (line) => requestSocket.send(line),
    getToken: () => readToken(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    actionTimeoutsMs: ACTION_TIMEOUTS_MS,
  });

  const startResponseSocket = () => {
    if (responseSocket || !requestSocket.isConnected()) return;
    responseSocket = new PluginSocket({
      port: responsePortNum,
      label: "response",
      onLine: (line) => dispatcher.handleResponseLine(line),
    });
    responseSocket.connect();
  };
  const stopResponseSocket = () => {
    if (responseConnectTimer) {
      clearTimeout(responseConnectTimer);
      responseConnectTimer = null;
    }
    responseSocket?.stop();
    responseSocket = null;
  };

  requestSocket = new PluginSocket({
    port: requestPortNum,
    label: "request",
    onConnect: () => {
      if (responseConnectTimer) clearTimeout(responseConnectTimer);
      responseConnectTimer = setTimeout(() => {
        responseConnectTimer = null;
        startResponseSocket();
      }, RESPONSE_CONNECT_SETTLE_MS);
    },
    onDisconnect: () => {
      stopResponseSocket();
    },
  });

  requestSocket.connect();
  const heartbeatTimer = startHeartbeat(dispatcher, HEARTBEAT_INTERVAL_MS);

  return {
    dispatcher,
    isReady: () => requestSocket.isConnected() && (responseSocket?.isConnected() ?? false),
    stop: () => {
      clearInterval(heartbeatTimer);
      stopResponseSocket();
      requestSocket.stop();
    },
  };
}

async function main() {
  let cli;
  try {
    cli = parseCli(process.argv);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(2);
  }

  if (cli.command === "help") {
    process.stdout.write(helpText());
    return;
  }
  if (cli.command === "version") {
    process.stdout.write(VERSION + "\n");
    return;
  }
  if (cli.command === "install-plugin") {
    runInstallPlugin();
    return;
  }

  let REQUEST_PORT: number;
  let RESPONSE_PORT: number;
  try {
    REQUEST_PORT = requestPort();
    RESPONSE_PORT = responsePort();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  ensurePluginInstalled(here, (m) => console.error(m));

  // Do NOT block the MCP stdio handshake below on resolving a role: Claude
  // Code/Cowork's shared MCP pool spins up a disposable sibling process just
  // to negotiate protocol version before handing off to the real session; if
  // that sibling stalls here (e.g. waiting out an IPC handshake timeout
  // against a live primary) it can miss the pool's own handshake window even
  // though the "real" instance ends up running fine. So role resolution runs
  // in the background: the coordinator starts out not-ready with a generic
  // "starting" message, `server.connect(transport)` proceeds immediately
  // either way, and tool calls made before a role resolves see that message
  // via isReady()/notReadyMessage() -- same shape as the old hard lock
  // conflict, but no longer permanent: the coordinator keeps resolving (and,
  // if this process ends up primary or the primary it attaches to dies,
  // re-resolving) for the lifetime of the process instead of failing once
  // and staying dead.
  const coordinator = new BridgeCoordinator({
    requestPort: REQUEST_PORT,
    responsePort: RESPONSE_PORT,
    log: (m) => console.error(m),
    startPrimary: () => startPrimaryHandles(REQUEST_PORT, RESPONSE_PORT),
  });
  coordinator.start().catch((err: Error) => {
    console.error(`[bridge] failed to resolve a role: ${err.message}`);
  });

  const server = createMcpServer({
    dispatcher: coordinator.dispatcher,
    isReady: () => coordinator.isReady(),
    notReadyMessage: () => coordinator.notReadyMessage(),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Exit when the MCP client goes away. Signal handlers never fire when the
  // parent dies without signaling (typical on Windows), and a live primary's
  // plugin sockets, heartbeat, and IPC listener (or a live secondary's
  // status-poll timer) keep the event loop alive -- the orphaned bridge
  // would otherwise hold the plugin connection (if primary) or a stale IPC
  // attachment (if secondary) forever. Stdin EOF is the one reliable
  // cross-platform signal that the client is gone.
  const exitOnClientGone = (reason: string) => () => {
    console.error(`Shutting down: ${reason}`);
    coordinator.stop();
    process.exit(0);
  };
  process.stdin.once("end", exitOnClientGone("stdin ended (client exited)"));
  process.stdin.once("close", exitOnClientGone("stdin closed (client exited)"));
  process.once("exit", () => coordinator.stop());

  console.error(`Lightroom MCP server v${VERSION} running on stdio`);
  console.error(`Connecting to plugin: request :${REQUEST_PORT}, response :${RESPONSE_PORT}`);
  console.error(`Token file: ${tokenFilePath()}`);
}

function runInstallPlugin(): void {
  const source = findBundledPlugin(here);
  if (!source) {
    console.error("Could not locate bundled LightroomMCP.lrplugin folder near this binary.");
    console.error("If you cloned the repo, run from the repo root or pass a path explicitly.");
    process.exit(1);
  }
  const dest = lightroomModulesDir();
  try {
    const result = installPlugin({ source, destDir: dest });
    if (result.status === "installed") {
      console.error(`Installed plugin: ${result.destination}`);
      console.error(`Restart Lightroom Classic to load it.`);
    } else if (result.status === "already-present") {
      console.error(`Plugin already present at ${result.destination}`);
    } else {
      console.error(`Skipped: ${result.reason ?? "unknown reason"}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Install failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
