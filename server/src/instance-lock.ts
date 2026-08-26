import fs from "node:fs";
import { defaultBaseDir, lockFilePath } from "./bridge-paths.js";

export interface InstanceLock {
  release: () => void;
}

/**
 * True if `pid` names a live process. EPERM (no permission to signal it, but
 * it exists) counts as alive. This is a weaker check than it looks: it only
 * proves *some* process holds that pid right now, not that it's the same
 * process that created the lock (pids get reused) or that it's actually
 * responsive (a wedged process still answers kill(pid, 0)). Exported so
 * bridge-coordinator.ts can layer a real liveness check (a heartbeat file
 * plus an IPC handshake) on top instead of trusting this alone -- see its
 * module doc comment for why that matters.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Reads the pid recorded in a lock file, or null if it's missing/malformed. */
export function readLockPid(lockFile: string): number | null {
  try {
    const raw = fs.readFileSync(lockFile, "utf8").trim();
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function acquireInstanceLock(
  requestPort: number,
  responsePort: number,
  baseDir = defaultBaseDir(),
): InstanceLock {
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const lockFile = lockFilePath(baseDir, requestPort, responsePort);

  while (true) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(fd, `${process.pid}\n`, { encoding: "utf8" });
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        throw err;
      }

      const existingPid = readLockPid(lockFile);
      if (existingPid && isPidAlive(existingPid)) {
        throw new Error(
          `Another Lightroom MCP bridge is already running for ports ${requestPort}/${responsePort} (pid ${existingPid})`,
        );
      }

      try {
        fs.unlinkSync(lockFile);
      } catch (unlinkErr) {
        if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkErr;
      }
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  let released = false;
  const exitHandler = () => release();
  const signalHandler = () => {
    release();
    process.exit(0);
  };
  const release = () => {
    if (released) return;
    released = true;
    process.off("exit", exitHandler);
    process.off("SIGINT", signalHandler);
    process.off("SIGTERM", signalHandler);
    if (readLockPid(lockFile) === process.pid) {
      fs.unlinkSync(lockFile);
    }
  };

  process.once("exit", exitHandler);
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);

  return { release };
}
