import { describe, it, expect, afterEach, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireInstanceLock, isPidAlive, readLockPid, type InstanceLock } from "../src/instance-lock.js";

describe("instance lock", () => {
  let tmpDir: string | null = null;
  const locks: InstanceLock[] = [];

  afterEach(() => {
    while (locks.length > 0) {
      locks.pop()?.release();
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  function baseDir(): string {
    tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "lightroom-mcp-lock-test-"));
    return tmpDir;
  }

  it("rejects a second live bridge for the same ports", () => {
    locks.push(acquireInstanceLock(58763, 58764, baseDir()));

    expect(() => acquireInstanceLock(58763, 58764, baseDir())).toThrow(
      /Another Lightroom MCP bridge is already running/,
    );
  });

  it("allows different port pairs to run independently", () => {
    locks.push(acquireInstanceLock(58763, 58764, baseDir()));
    locks.push(acquireInstanceLock(58765, 58766, baseDir()));
  });

  it("replaces a stale lock with a fully written live lock", () => {
    const dir = baseDir();
    const lockFile = path.join(dir, "bridge-58763-58764.lock");
    fs.writeFileSync(lockFile, "999999999\n");

    locks.push(acquireInstanceLock(58763, 58764, dir));

    expect(fs.readFileSync(lockFile, "utf8")).toBe(`${process.pid}\n`);
  });

  it("replaces a malformed stale lock", () => {
    const dir = baseDir();
    const lockFile = path.join(dir, "bridge-58763-58764.lock");
    fs.writeFileSync(lockFile, "not-a-pid\n");

    locks.push(acquireInstanceLock(58763, 58764, dir));

    expect(fs.readFileSync(lockFile, "utf8")).toBe(`${process.pid}\n`);
  });

  it("allows release after the lock file is already gone", () => {
    const dir = baseDir();
    const lockFile = path.join(dir, "bridge-58763-58764.lock");
    const lock = acquireInstanceLock(58763, 58764, dir);
    fs.unlinkSync(lockFile);

    lock.release();
    lock.release();

    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it("removes process handlers when released", () => {
    const beforeExit = process.listenerCount("exit");
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");

    const lock = acquireInstanceLock(58763, 58764, baseDir());
    expect(process.listenerCount("exit")).toBe(beforeExit + 1);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint + 1);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm + 1);

    lock.release();

    expect(process.listenerCount("exit")).toBe(beforeExit);
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("releases and exits when SIGINT is received", () => {
    const dir = baseDir();
    const lockFile = path.join(dir, "bridge-58763-58764.lock");
    acquireInstanceLock(58763, 58764, dir); // not pushed to `locks`: SIGINT releases it below

    const exitSpy = jest.spyOn(process, "exit").mockImplementation(((): never => undefined as never));
    try {
      process.emit("SIGINT");
      expect(fs.existsSync(lockFile)).toBe(false);
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      exitSpy.mockRestore();
    }
  });

  describe("isPidAlive", () => {
    it("is true for this process's own pid", () => {
      expect(isPidAlive(process.pid)).toBe(true);
    });

    it("is false for a pid that does not exist", () => {
      expect(isPidAlive(999999999)).toBe(false);
    });
  });

  describe("readLockPid", () => {
    it("returns null when the file does not exist", () => {
      expect(readLockPid(path.join(baseDir(), "missing.lock"))).toBeNull();
    });

    it("returns null for non-numeric content", () => {
      const dir = baseDir();
      const file = path.join(dir, "bad.lock");
      fs.writeFileSync(file, "not-a-pid\n");
      expect(readLockPid(file)).toBeNull();
    });
  });

  describe("error propagation", () => {
    it("rethrows a non-EEXIST error opening the lock file instead of retrying forever", () => {
      const openSpy = jest.spyOn(fs, "openSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      });
      try {
        expect(() => acquireInstanceLock(58763, 58764, baseDir())).toThrow(/permission denied/);
      } finally {
        openSpy.mockRestore();
      }
    });

    it("rethrows a non-ENOENT error unlinking a stale lock instead of swallowing it", () => {
      const dir = baseDir();
      fs.writeFileSync(path.join(dir, "bridge-58763-58764.lock"), "999999999\n"); // dead pid -> stale

      const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      });
      try {
        expect(() => acquireInstanceLock(58763, 58764, dir)).toThrow(/permission denied/);
      } finally {
        unlinkSpy.mockRestore();
      }
    });

    it("swallows an ENOENT unlinking a stale lock (already gone) and retries instead of throwing", () => {
      const dir = baseDir();
      const lockFile = path.join(dir, "bridge-58763-58764.lock");
      fs.writeFileSync(lockFile, "999999999\n"); // dead pid -> stale

      const unlinkSpy = jest.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("already gone"), { code: "ENOENT" });
      });
      try {
        // The mocked call above pretends the unlink raced and lost (ENOENT),
        // without actually removing the file -- the retry loop's next
        // openSync("wx") should hit EEXIST again, read the same dead pid
        // again, and this time really unlink it via the un-mocked fs call
        // (mockImplementationOnce reverts after its single invocation).
        locks.push(acquireInstanceLock(58763, 58764, dir));
        expect(fs.readFileSync(lockFile, "utf8")).toBe(`${process.pid}\n`);
      } finally {
        unlinkSpy.mockRestore();
      }
    });
  });

  describe("default baseDir", () => {
    // The only test that exercises the real ~/.config/lightroom-mcp
    // directory instead of a throwaway tmp one -- uses a port pair no real
    // bridge would ever use, and always releases what it acquires.
    it("falls back to ~/.config/lightroom-mcp when baseDir is omitted", () => {
      const lock = acquireInstanceLock(1, 2);
      const lockFile = path.join(os.homedir(), ".config", "lightroom-mcp", "bridge-1-2.lock");
      try {
        expect(fs.readFileSync(lockFile, "utf8")).toBe(`${process.pid}\n`);
      } finally {
        lock.release();
      }
      expect(fs.existsSync(lockFile)).toBe(false);
    });
  });
});
