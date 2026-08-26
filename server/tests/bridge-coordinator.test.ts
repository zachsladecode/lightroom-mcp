import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BridgeCoordinator, type PrimaryHandles } from '../src/bridge-coordinator.js';
import { lockFilePath, livenessFilePath, ipcAddress } from '../src/bridge-paths.js';
import { writeLiveness } from '../src/liveness.js';
import { PrimaryIpcServer } from '../src/ipc-server.js';
import type { PluginResponse } from '../src/dispatcher.js';

// See tests/ipc.test.ts for why this prefix is kept short (AF_UNIX path
// length limits).
function shortTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lrbc-'));
}

async function waitUntil(pred: () => boolean, timeoutMs = 3_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (!pred()) throw new Error('waitUntil: condition not met in time');
}

function fakePrimaryHandles(overrides: Partial<PrimaryHandles> = {}): {
  handles: PrimaryHandles;
  calls: Array<{ action: string; params: unknown }>;
  setReady: (v: boolean) => void;
  stopped: () => boolean;
} {
  const calls: Array<{ action: string; params: unknown }> = [];
  let ready = true;
  let didStop = false;
  const handles: PrimaryHandles = {
    dispatcher: {
      call: async (action: string, params: unknown): Promise<PluginResponse> => {
        calls.push({ action, params });
        return { id: 'x', result: { action, params } };
      },
    },
    isReady: () => ready,
    stop: () => {
      didStop = true;
    },
    ...overrides,
  };
  return { handles, calls, setReady: (v) => (ready = v), stopped: () => didStop };
}

describe('BridgeCoordinator', () => {
  let dir: string;
  const requestPort = 58763;
  const responsePort = 58764;
  const coordinators: BridgeCoordinator[] = [];
  const ipcServers: PrimaryIpcServer[] = [];

  beforeEach(() => {
    dir = shortTmpDir();
  });

  afterEach(async () => {
    for (const c of coordinators) c.stop();
    coordinators.length = 0;
    for (const s of ipcServers) await s.stop();
    ipcServers.length = 0;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeCoordinator(
    startPrimary: () => PrimaryHandles,
    overrides: Partial<{
      handshakeTimeoutMs: number;
      staleLivenessMs: number;
      startupGraceMs: number;
      livenessIntervalMs: number;
      retryDelayMs: number;
      log: (msg: string) => void;
    }> = {},
  ): BridgeCoordinator {
    const c = new BridgeCoordinator({
      requestPort,
      responsePort,
      baseDir: dir,
      log: () => {},
      handshakeTimeoutMs: 300,
      staleLivenessMs: 200,
      startupGraceMs: 100,
      livenessIntervalMs: 200,
      retryDelayMs: 60,
      ...overrides,
      startPrimary,
    });
    coordinators.push(c);
    return c;
  }

  it('becomes primary when no lock is held', async () => {
    const { handles, calls } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles);
    await c.start();

    expect(c.currentRole()).toBe('primary');
    expect(c.isReady()).toBe(true);
    await c.dispatcher.call('search_photos', { rating: 5 });
    expect(calls).toEqual([{ action: 'search_photos', params: { rating: 5 } }]);
  });

  it('writes the lock file with its own pid on becoming primary', async () => {
    const { handles } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles);
    await c.start();

    const lockFile = lockFilePath(dir, requestPort, responsePort);
    expect(fs.readFileSync(lockFile, 'utf8').trim()).toBe(String(process.pid));
  });

  it('reflects the primary handles isReady() dynamically', async () => {
    const { handles, setReady } = fakePrimaryHandles();
    setReady(false);
    const c = makeCoordinator(() => handles);
    await c.start();

    expect(c.isReady()).toBe(false);
    expect(c.notReadyMessage()).toMatch(/plugin not connected/i);
    setReady(true);
    expect(c.isReady()).toBe(true);
  });

  it('reports a generic starting message before any role has resolved', () => {
    const { handles } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles);
    // start() not awaited/called yet.
    expect(c.isReady()).toBe(false);
    expect(c.notReadyMessage()).toMatch(/starting/i);
  });

  it('reclaims a lock left by a dead pid and becomes primary', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFilePath(dir, requestPort, responsePort), '999999999\n');

    const { handles } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles);
    await c.start();

    expect(c.currentRole()).toBe('primary');
  });

  it('becomes secondary and forwards calls when a healthy primary already owns the ports', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFilePath(dir, requestPort, responsePort), `${process.pid}\n`);
    writeLiveness(livenessFilePath(dir, requestPort, responsePort), process.pid);

    const calls: Array<{ action: string; params: unknown }> = [];
    const ipcServer = new PrimaryIpcServer({
      address: ipcAddress(dir, requestPort, responsePort),
      isReady: () => true,
      dispatcher: {
        call: async (action, params) => {
          calls.push({ action, params });
          return { id: 'x', result: 'ok-from-real-primary' };
        },
      },
      log: () => {},
    });
    await ipcServer.start();
    ipcServers.push(ipcServer);

    const startPrimary = jest.fn(() => fakePrimaryHandles().handles);
    const c = makeCoordinator(startPrimary);
    await c.start();

    expect(c.currentRole()).toBe('secondary');
    expect(startPrimary).not.toHaveBeenCalled();
    // With no notReadyMessage configured on the fake primary and ready:true,
    // there's no per-attach message -- notReadyMessage() falls back to the
    // generic "waiting for the primary" text.
    expect(c.notReadyMessage()).toMatch(/waiting for the primary/i);

    const resp = await c.dispatcher.call('list_collections', {});
    expect(resp.result).toBe('ok-from-real-primary');
    expect(calls).toEqual([{ action: 'list_collections', params: {} }]);
  });

  it('picks up a readiness change from the primary on the next status poll', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFilePath(dir, requestPort, responsePort), `${process.pid}\n`);
    writeLiveness(livenessFilePath(dir, requestPort, responsePort), process.pid);

    let primaryReady = true;
    const ipcServer = new PrimaryIpcServer({
      address: ipcAddress(dir, requestPort, responsePort),
      isReady: () => primaryReady,
      notReadyMessage: () => 'primary went unready',
      dispatcher: { call: async () => ({ id: 'x', result: null }) },
      log: () => {},
    });
    await ipcServer.start();
    ipcServers.push(ipcServer);

    const { handles } = fakePrimaryHandles();
    // livenessIntervalMs floors the status-poll interval at 1s regardless of
    // this value; kept small anyway to document intent.
    const c = makeCoordinator(() => handles, { livenessIntervalMs: 100 });
    await c.start();
    expect(c.isReady()).toBe(true);

    primaryReady = false;
    await waitUntil(() => c.isReady() === false, 3_000);
    expect(c.notReadyMessage()).toBe('primary went unready');
  });

  it('does not reclaim a lock that is merely young, even with no IPC listener yet', async () => {
    fs.mkdirSync(dir, { recursive: true });
    // pid is alive (it's this test process) and the lock file is brand new,
    // but nothing is listening on the IPC address -- must be treated as
    // "still starting up", not stale.
    fs.writeFileSync(lockFilePath(dir, requestPort, responsePort), `${process.pid}\n`);

    const { handles } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles, { startupGraceMs: 100_000 });
    await c.start();

    expect(c.currentRole()).toBe('degraded');
    expect(c.isReady()).toBe(false);
    expect(fs.existsSync(lockFilePath(dir, requestPort, responsePort))).toBe(true);
  });

  it('does not reclaim a lock that is old but whose heartbeat is still fresh', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFilePath(dir, requestPort, responsePort), `${process.pid}\n`);
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(lockFilePath(dir, requestPort, responsePort), old, old);
    // Fresh heartbeat, but nothing is listening on the IPC address -- the
    // handshake still fails, yet a fresh heartbeat means "busy", not "dead".
    writeLiveness(livenessFilePath(dir, requestPort, responsePort), process.pid);

    const { handles } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles, { startupGraceMs: 10, staleLivenessMs: 60_000 });
    await c.start();

    expect(c.currentRole()).toBe('degraded');
    expect(fs.existsSync(lockFilePath(dir, requestPort, responsePort))).toBe(true);
  });

  it('reclaims a lock whose pid is alive but unresponsive once it is old and its heartbeat is stale', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFilePath(dir, requestPort, responsePort), `${process.pid}\n`);
    // Backdate the lock file past startupGraceMs so it reads as no longer "just starting".
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(lockFilePath(dir, requestPort, responsePort), old, old);
    // No liveness file at all -- readLiveness() returns null, which counts as stale.

    const { handles } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles, { startupGraceMs: 10, staleLivenessMs: 10 });
    await c.start();

    expect(c.currentRole()).toBe('primary');
  });

  it('recovers automatically once a young, non-reclaimable lock is released by whatever held it', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFilePath(dir, requestPort, responsePort), `${process.pid}\n`);

    const { handles } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles, { startupGraceMs: 100_000, retryDelayMs: 30 });
    await c.start();
    expect(c.currentRole()).toBe('degraded');

    fs.unlinkSync(lockFilePath(dir, requestPort, responsePort));
    await waitUntil(() => c.currentRole() === 'primary', 3_000);
  });

  it('fails over to primary when the attached primary disappears', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFilePath(dir, requestPort, responsePort), `${process.pid}\n`);
    writeLiveness(livenessFilePath(dir, requestPort, responsePort), process.pid);

    const ipcServer = new PrimaryIpcServer({
      address: ipcAddress(dir, requestPort, responsePort),
      isReady: () => true,
      dispatcher: { call: async () => ({ id: 'x', result: null }) },
      log: () => {},
    });
    await ipcServer.start();
    ipcServers.push(ipcServer);

    const { handles } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles, { startupGraceMs: 10, staleLivenessMs: 10 });
    await c.start();
    expect(c.currentRole()).toBe('secondary');

    // Simulate the primary crashing: drop its connections and its lock file
    // stays behind (a real crash wouldn't get to run instance-lock's own
    // exit-handler cleanup either).
    await ipcServer.stop();

    await waitUntil(() => c.currentRole() === 'primary', 3_000);
  });

  it('releases the lock and stops the IPC listener on stop(), so a fresh acquire succeeds right after', async () => {
    const { handles } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles);
    await c.start();
    expect(c.currentRole()).toBe('primary');

    c.stop();
    expect(fs.existsSync(lockFilePath(dir, requestPort, responsePort))).toBe(false);

    // A brand-new coordinator for the same ports should now win primary
    // immediately, with nothing left over to trip up on.
    const { handles: handles2 } = fakePrimaryHandles();
    const c2 = makeCoordinator(() => handles2);
    await c2.start();
    expect(c2.currentRole()).toBe('primary');
  });

  it('calls the fake primary handles stop() on coordinator stop()', async () => {
    const { handles, stopped } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles);
    await c.start();
    c.stop();
    expect(stopped()).toBe(true);
  });

  it('discards a role won after stop() was called mid-attempt, leaving no lock behind', async () => {
    const { handles } = fakePrimaryHandles();
    const c = makeCoordinator(() => handles);

    const startPromise = c.start();
    c.stop(); // fires before tryAcquire's async work has a chance to resolve
    await startPromise;

    // Whatever role tryAcquire actually won gets released/stopped again
    // immediately as "superseded" rather than left dangling.
    expect(c.currentRole()).toBe('unresolved');
    expect(fs.existsSync(lockFilePath(dir, requestPort, responsePort))).toBe(false);
  });

  it('only one of two coordinators racing for the same stale lock ends up primary', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFilePath(dir, requestPort, responsePort), `${process.pid}\n`);
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(lockFilePath(dir, requestPort, responsePort), old, old);
    // No liveness file -- reads as stale immediately, so both coordinators
    // race to reclaim+re-acquire at essentially the same moment.

    const { handles: h1 } = fakePrimaryHandles();
    const { handles: h2 } = fakePrimaryHandles();
    const c1 = makeCoordinator(() => h1, { startupGraceMs: 10, staleLivenessMs: 10 });
    const c2 = makeCoordinator(() => h2, { startupGraceMs: 10, staleLivenessMs: 10 });

    await Promise.all([c1.start(), c2.start()]);

    const roles = [c1.currentRole(), c2.currentRole()].sort();
    // Exactly one wins primary; the other attaches as its secondary (if it
    // lost the reclaim race but the winner's IPC listener was already up by
    // the time it retried) or is left waiting to retry (if not) -- but never
    // both primary, which would mean two live plugin connections fighting
    // over the same single-client TCP ports.
    expect(roles.filter((r) => r === 'primary')).toHaveLength(1);
  });

  it('logs but still reclaims when cleanup fails to remove one of the stale files', async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockFilePath(dir, requestPort, responsePort), `${process.pid}\n`);
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(lockFilePath(dir, requestPort, responsePort), old, old);
    // No liveness file -- reads as stale immediately.

    // Let the lock file and address unlink for real; only the heartbeat
    // file's removal fails, so reclaim() logs that one failure and still
    // goes on to successfully re-acquire the lock.
    const originalUnlink = fs.unlinkSync;
    const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementation((p: fs.PathLike) => {
      if (String(p).endsWith('.heartbeat')) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      originalUnlink(p);
    });

    const logs: string[] = [];
    const { handles } = fakePrimaryHandles();
    try {
      const c = makeCoordinator(() => handles, {
        startupGraceMs: 10,
        staleLivenessMs: 10,
        log: (m) => logs.push(m),
      });
      await c.start();

      expect(c.currentRole()).toBe('primary');
      expect(logs.some((m) => /cleanup of .*\.heartbeat failed/i.test(m))).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  it('logs but stays primary if its own IPC listener fails to bind', async () => {
    const blockerAddress = ipcAddress(dir, requestPort, responsePort);
    fs.mkdirSync(dir, { recursive: true });
    const blocker = net.createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(blockerAddress, () => resolve()));

    const logs: string[] = [];
    const { handles } = fakePrimaryHandles();
    try {
      const c = makeCoordinator(() => handles, { log: (m) => logs.push(m) });
      await c.start();

      expect(c.currentRole()).toBe('primary');
      expect(c.isReady()).toBe(true); // plugin-side readiness is unaffected by the IPC listener failing
      await waitUntil(() => logs.some((m) => /IPC listener failed to start/i.test(m)), 2_000);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
