import os from "node:os";
import path from "node:path";

/**
 * Filesystem/IPC addresses for the multi-process bridge coordination scheme
 * (see bridge-coordinator.ts). Centralized here so the lock file, the
 * liveness heartbeat file, and the local IPC channel all agree on the same
 * `bridge-<requestPort>-<responsePort>` naming for a given port pair --
 * instance-lock.ts, liveness.ts, ipc-server.ts and ipc-client.ts all import
 * these instead of hand-rolling the join.
 */

export function defaultBaseDir(): string {
  return path.join(os.homedir(), ".config", "lightroom-mcp");
}

export function lockFilePath(baseDir: string, requestPort: number, responsePort: number): string {
  return path.join(baseDir, `bridge-${requestPort}-${responsePort}.lock`);
}

export function livenessFilePath(baseDir: string, requestPort: number, responsePort: number): string {
  return path.join(baseDir, `bridge-${requestPort}-${responsePort}.heartbeat`);
}

/**
 * Local channel other lightroom-mcp processes on this machine use to reach
 * the primary instead of each opening their own connection to the plugin's
 * single-client TCP ports. Unix domain socket path on POSIX. Windows has no
 * filesystem-namespaced domain sockets for `net` to bind, so it gets a named
 * pipe address instead -- see https://nodejs.org/api/net.html#ipc-support.
 */
export function ipcAddress(baseDir: string, requestPort: number, responsePort: number): string {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\lightroom-mcp-bridge-${requestPort}-${responsePort}`;
  }
  return path.join(baseDir, `bridge-${requestPort}-${responsePort}.sock`);
}
