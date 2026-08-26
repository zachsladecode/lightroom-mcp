import fs from "node:fs";
import { acquireInstanceLock, type InstanceLock } from "./instance-lock.js";
import { defaultBaseDir, lockFilePath, livenessFilePath, ipcAddress } from "./bridge-paths.js";
import { readLiveness, isLivenessStale, startLivenessHeartbeat } from "./liveness.js";
import { PrimaryIpcServer } from "./ipc-server.js";
import { SecondaryIpcClient } from "./ipc-client.js";
import { SwitchableDispatcher, type CallableDispatcher } from "./switchable-dispatcher.js";

// This module is the fix for the "every MCP client on this Mac wants its own
// spawned bridge process, but the plugin only ever accepts one client per
// port" problem (see AGENTS.md and README for the plugin's single-client
// constraint). Exactly one lightroom-mcp process per port pair may hold the
// real plugin TCP connections ("primary"); every other process attaches to
// that primary over a local IPC channel ("secondary") and forwards its
// MCP-driven calls through it instead of contending for the plugin sockets
// directly. See PrimaryIpcServer / SecondaryIpcClient for the channel
// itself, and instance-lock.ts for the low-level single-process-per-pid
// exclusion primitive this builds on.
//
// index.ts owns exactly one BridgeCoordinator and hands its `.dispatcher` to
// createMcpServer once at startup; the coordinator resolves (and, if the
// primary it attached to disappears, re-resolves) this process's role in the
// background without ever needing the MCP server or transport rebuilt.

export interface PrimaryHandles {
  dispatcher: CallableDispatcher;
  isReady: () => boolean;
  stop: () => void;
}

export interface BridgeCoordinatorOptions {
  requestPort: number;
  responsePort: number;
  baseDir?: string;
  pid?: number;
  now?: () => number;
  /** How long a would-be secondary waits for the primary to answer an IPC handshake before giving up on it for this attempt. */
  handshakeTimeoutMs?: number;
  /** How stale the primary's heartbeat file must be before we treat it as dead rather than merely busy/starting. */
  staleLivenessMs?: number;
  /** A lock file younger than this is never reclaimed, no matter what -- it might just be mid-startup and hasn't opened its IPC listener yet. */
  startupGraceMs?: number;
  /** Liveness heartbeat rewrite interval once this process becomes primary. */
  livenessIntervalMs?: number;
  /** Base delay between background retries while degraded/reconnecting; backs off (capped) on repeated failure. */
  retryDelayMs?: number;
  log?: (msg: string) => void;
  /** Called at most once per role-resolution, only once this process has actually won the primary role. Wires the real plugin TCP sockets. */
  startPrimary: () => PrimaryHandles;
}

type Role =
  | { kind: "unresolved" }
  | { kind: "primary"; lock: InstanceLock; handles: PrimaryHandles; ipcServer: PrimaryIpcServer }
  | { kind: "secondary"; client: SecondaryIpcClient; ready: boolean; message?: string }
  | { kind: "degraded"; message: string };

type Outcome =
  | { kind: "primary"; lock: InstanceLock }
  | { kind: "secondary"; client: SecondaryIpcClient; status: { ready: boolean; message?: string } }
  | { kind: "busy"; reason: string };

const DEFAULTS = {
  handshakeTimeoutMs: 3_000,
  staleLivenessMs: 45_000,
  startupGraceMs: 8_000,
  livenessIntervalMs: 10_000,
  retryDelayMs: 4_000,
};

const MAX_BACKOFF_MULTIPLIER = 5;

export class BridgeCoordinator {
  readonly dispatcher = new SwitchableDispatcher();

  private readonly requestPort: number;
  private readonly responsePort: number;
  private readonly baseDir: string;
  private readonly pid: number;
  private readonly now: () => number;
  private readonly handshakeTimeoutMs: number;
  private readonly staleLivenessMs: number;
  private readonly startupGraceMs: number;
  private readonly livenessIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly log: (msg: string) => void;
  private readonly startPrimaryFn: () => PrimaryHandles;

  private role: Role = { kind: "unresolved" };
  private livenessTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private statusPollTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private degradedStreak = 0;
  // Bumped on every fresh acquisition attempt so a stray async callback from
  // an attempt we've since abandoned (a status poll, a delayed retry, a
  // disconnect racing a newer attempt) can't clobber a newer role.
  private generation = 0;

  constructor(opts: BridgeCoordinatorOptions) {
    this.requestPort = opts.requestPort;
    this.responsePort = opts.responsePort;
    this.baseDir = opts.baseDir ?? defaultBaseDir();
    this.pid = opts.pid ?? process.pid;
    this.now = opts.now ?? (() => Date.now());
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs;
    this.staleLivenessMs = opts.staleLivenessMs ?? DEFAULTS.staleLivenessMs;
    this.startupGraceMs = opts.startupGraceMs ?? DEFAULTS.startupGraceMs;
    this.livenessIntervalMs = opts.livenessIntervalMs ?? DEFAULTS.livenessIntervalMs;
    this.retryDelayMs = opts.retryDelayMs ?? DEFAULTS.retryDelayMs;
    this.log = opts.log ?? ((msg) => console.error(msg));
    this.startPrimaryFn = opts.startPrimary;
  }

  isReady(): boolean {
    if (this.role.kind === "primary") return this.role.handles.isReady();
    if (this.role.kind === "secondary") return this.role.ready;
    return false;
  }

  notReadyMessage(): string {
    if (this.role.kind === "secondary") {
      return this.role.message ?? "Waiting for the primary Lightroom MCP bridge to become ready.";
    }
    if (this.role.kind === "degraded") return this.role.message;
    if (this.role.kind === "primary") {
      return "Lightroom plugin not connected. Open Lightroom and click 'Start Server' in Plug-in Manager.";
    }
    return "Starting Lightroom MCP bridge…";
  }

  /** Current role, for logging/diagnostics only -- not used for control flow by callers. */
  currentRole(): "unresolved" | "primary" | "secondary" | "degraded" {
    return this.role.kind;
  }

  async start(): Promise<void> {
    await this.attempt();
  }

  /** Best-effort synchronous-ish teardown. Safe to call from a process 'exit' handler and from normal shutdown alike; idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.statusPollTimer) clearInterval(this.statusPollTimer);
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.retryTimer = null;
    this.statusPollTimer = null;
    this.livenessTimer = null;

    if (this.role.kind === "primary") {
      this.role.handles.stop();
      void this.role.ipcServer.stop();
      this.role.lock.release();
    } else if (this.role.kind === "secondary") {
      this.role.client.stop();
    }
  }

  private paths() {
    return {
      lockFile: lockFilePath(this.baseDir, this.requestPort, this.responsePort),
      livenessFile: livenessFilePath(this.baseDir, this.requestPort, this.responsePort),
      address: ipcAddress(this.baseDir, this.requestPort, this.responsePort),
    };
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    const myGeneration = ++this.generation;
    const outcome = await this.tryAcquire();

    if (this.stopped || myGeneration !== this.generation) {
      // Superseded (a newer attempt already resolved, or we were stopped)
      // while this one was in flight -- discard whatever we just won/opened
      // rather than let it leak or clobber whatever is now active.
      if (outcome.kind === "primary") outcome.lock.release();
      if (outcome.kind === "secondary") outcome.client.stop();
      return;
    }

    if (outcome.kind === "primary") {
      this.becomePrimary(outcome.lock);
      return;
    }
    if (outcome.kind === "secondary") {
      this.becomeSecondary(outcome.client, outcome.status, myGeneration);
      return;
    }
    this.becomeDegraded(outcome.reason, myGeneration);
  }

  private async tryAcquire(): Promise<Outcome> {
    const { lockFile, livenessFile, address } = this.paths();

    try {
      const lock = acquireInstanceLock(this.requestPort, this.responsePort, this.baseDir);
      return { kind: "primary", lock };
    } catch {
      // Contended by a pid acquireInstanceLock itself believes is alive --
      // it already self-heals the "owning pid is dead" case internally
      // before ever throwing, so by the time we're here the pid is alive as
      // far as kill(pid, 0) can tell. Verify that ourselves instead of
      // taking its word for it: fall through to the IPC handshake below. A
      // pid that dies in the TOCTOU sliver between that check and this one
      // is still handled correctly, just one step later -- the handshake
      // naturally fails against a dead process, and the grace/staleness
      // check below reclaims it once its heartbeat goes stale. See the
      // module doc comment.
    }

    const client = new SecondaryIpcClient({
      address,
      timeoutMs: this.handshakeTimeoutMs,
      log: this.log,
      onDisconnect: () => this.handleSecondaryLost(client),
    });
    try {
      await client.connect();
      const status = await client.status();
      // A successful round trip proves the owning process's event loop is
      // alive and answering *right now* -- the one thing kill(pid, 0) can
      // never tell us, and the one thing that actually matters here.
      return { kind: "secondary", client, status };
    } catch {
      client.stop();
    }

    // pid exists but didn't answer the handshake in time. Could be a
    // brand-new primary that hasn't opened its IPC listener yet, a hung
    // process, or an unrelated process that inherited this pid after the
    // real bridge died without cleaning up (classic PID reuse). Use the lock
    // file's age and the heartbeat file to tell those apart before ever
    // reclaiming -- reclaiming a legitimately-starting primary out from
    // under it would recreate the exact thrash this exists to prevent.
    const lockAgeMs = this.lockAgeMs(lockFile);
    if (lockAgeMs === null || lockAgeMs < this.startupGraceMs) {
      return { kind: "busy", reason: "another bridge instance appears to be starting up" };
    }

    const liveness = readLiveness(livenessFile);
    if (!isLivenessStale(liveness, this.staleLivenessMs, this.now())) {
      return { kind: "busy", reason: "another bridge instance is running but not answering yet" };
    }

    this.reclaim(lockFile, livenessFile, address, "owning pid is unresponsive and its heartbeat is stale");
    return this.tryBecomePrimaryOnce();
  }

  private tryBecomePrimaryOnce(): Outcome {
    try {
      const lock = acquireInstanceLock(this.requestPort, this.responsePort, this.baseDir);
      return { kind: "primary", lock };
    } catch {
      // Lost the race to reclaim to another process that got there first.
      return { kind: "busy", reason: "lost the race to reclaim a stale bridge lock" };
    }
  }

  private lockAgeMs(lockFile: string): number | null {
    try {
      return this.now() - fs.statSync(lockFile).mtimeMs;
    } catch {
      return null;
    }
  }

  private reclaim(lockFile: string, livenessFile: string, address: string, reason: string): void {
    this.log(
      `[bridge] reclaiming lock for ports ${this.requestPort}/${this.responsePort}: ${reason}`,
    );
    for (const f of [lockFile, livenessFile, address]) {
      try {
        fs.unlinkSync(f);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.log(`[bridge] cleanup of ${f} failed: ${(err as Error).message}`);
        }
      }
    }
  }

  private becomePrimary(lock: InstanceLock): void {
    this.degradedStreak = 0;
    const handles = this.startPrimaryFn();
    const { livenessFile, address } = this.paths();
    const ipcServer = new PrimaryIpcServer({
      address,
      dispatcher: handles.dispatcher,
      isReady: handles.isReady,
      log: this.log,
    });
    this.role = { kind: "primary", lock, handles, ipcServer };
    this.dispatcher.setTarget(handles.dispatcher);
    this.livenessTimer = startLivenessHeartbeat(livenessFile, this.pid, this.livenessIntervalMs, (err) =>
      this.log(`[bridge] liveness write failed: ${err.message}`),
    );
    ipcServer.start().catch((err: Error) => {
      // Still work standalone even if the IPC listener fails to bind (e.g.
      // an address we couldn't clear, or a path too long for AF_UNIX) --
      // other processes just won't be able to attach as secondaries, the
      // same as before this feature existed. Don't take the whole bridge
      // down over it.
      this.log(`[bridge] IPC listener failed to start: ${err.message}`);
    });
    this.log(`[bridge] primary for ports ${this.requestPort}/${this.responsePort} (pid ${this.pid})`);
  }

  private becomeSecondary(
    client: SecondaryIpcClient,
    initialStatus: { ready: boolean; message?: string },
    myGeneration: number,
  ): void {
    this.degradedStreak = 0;
    this.role = { kind: "secondary", client, ready: initialStatus.ready, message: initialStatus.message };
    this.dispatcher.setTarget(client);

    const pollStatus = () => {
      client
        .status()
        .then((status) => {
          if (this.generation !== myGeneration || this.role.kind !== "secondary") return;
          this.role = { ...this.role, ready: status.ready, message: status.message };
        })
        .catch((err: Error) => {
          if (this.generation !== myGeneration || this.role.kind !== "secondary") return;
          this.role = { ...this.role, ready: false, message: err.message };
        });
    };
    this.statusPollTimer = setInterval(pollStatus, Math.max(1_000, Math.floor(this.livenessIntervalMs / 2)));
    this.log(`[bridge] secondary for ports ${this.requestPort}/${this.responsePort}, attached to primary`);
  }

  private becomeDegraded(reason: string, myGeneration: number): void {
    this.role = {
      kind: "degraded",
      message: `Lightroom MCP bridge unavailable right now (${reason}). Retrying automatically in the background.`,
    };
    this.dispatcher.setTarget(null);
    this.scheduleRetry(myGeneration);
  }

  // Self-healing takeover: if the primary this secondary was attached to
  // goes away (crash, force-quit, machine sleep/wake weirdness), don't leave
  // the user stuck with a dead bridge until they restart something --
  // immediately try to resolve a role again. We might win primary
  // ourselves now, or find a newer primary someone else already stood up.
  private handleSecondaryLost(client: SecondaryIpcClient): void {
    if (this.stopped) return;
    if (this.role.kind !== "secondary" || this.role.client !== client) return; // stale/superseded already
    this.log("[bridge] lost connection to primary bridge; attempting failover");
    if (this.statusPollTimer) {
      clearInterval(this.statusPollTimer);
      this.statusPollTimer = null;
    }
    this.role = { kind: "degraded", message: "Lost connection to the primary Lightroom MCP bridge. Reconnecting…" };
    this.dispatcher.setTarget(null);
    void this.attempt();
  }

  private scheduleRetry(myGeneration: number): void {
    const multiplier = Math.min(this.degradedStreak + 1, MAX_BACKOFF_MULTIPLIER);
    this.degradedStreak++;
    const delay = this.retryDelayMs * multiplier;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped || this.generation !== myGeneration) return;
      void this.attempt();
    }, delay);
  }
}
