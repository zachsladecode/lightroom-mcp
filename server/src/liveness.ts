import fs from "node:fs";

export interface LivenessRecord {
  pid: number;
  updatedAt: number;
}

/**
 * Heartbeat file a primary bridge rewrites on an interval so a would-be
 * secondary/successor can tell "the owning process is alive and its event
 * loop is still ticking" apart from "the pid merely still exists" --
 * instance-lock's kill(pid, 0) check proves only the latter, and can't tell
 * a hung process, or a pid reused by an unrelated program after the real
 * bridge crashed, from a genuinely healthy one. Kept as its own file
 * (rather than folded into the .lock file) so the lock file's content/format
 * -- and the tests that pin it byte-for-byte -- stay untouched.
 */
export function writeLiveness(filePath: string, pid: number, now = Date.now()): void {
  const record: LivenessRecord = { pid, updatedAt: now };
  // Write to a temp file and rename over the target so a concurrent reader
  // never observes a half-written JSON body. Rename is atomic on both POSIX
  // and Windows.
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, filePath);
}

export function readLiveness(filePath: string): LivenessRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LivenessRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.updatedAt !== "number") return null;
    return { pid: parsed.pid, updatedAt: parsed.updatedAt };
  } catch {
    return null;
  }
}

/** No record at all counts as stale -- a missing heartbeat is exactly as
 * uninformative as a very old one when deciding whether to reclaim a lock. */
export function isLivenessStale(record: LivenessRecord | null, maxAgeMs: number, now = Date.now()): boolean {
  if (!record) return true;
  return now - record.updatedAt > maxAgeMs;
}

/**
 * Starts a fire-and-forget interval that rewrites the heartbeat file, and
 * writes the first one synchronously before returning so a secondary racing
 * to read it right after this process wins primary sees a fresh record
 * immediately. Returns the timer so callers can clearInterval() it on
 * shutdown. A failed write is logged, not thrown -- a transient fs hiccup
 * shouldn't take the bridge down.
 */
export function startLivenessHeartbeat(
  filePath: string,
  pid: number,
  intervalMs: number,
  onError: (err: Error) => void = (err) => console.error(`[liveness] write failed: ${err.message}`),
): NodeJS.Timeout {
  try {
    writeLiveness(filePath, pid);
  } catch (err) {
    onError(err as Error);
  }
  return setInterval(() => {
    try {
      writeLiveness(filePath, pid);
    } catch (err) {
      onError(err as Error);
    }
  }, intervalMs);
}
