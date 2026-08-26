import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PrimaryIpcServer } from '../src/ipc-server.js';
import { SecondaryIpcClient } from '../src/ipc-client.js';
import type { PluginResponse } from '../src/dispatcher.js';

// Unix domain socket paths share the kernel's sockaddr_un length limit
// (~104 bytes on macOS/BSD, ~108 on Linux); keep this prefix short so the
// suite doesn't intermittently fail on a runner with a long TMPDIR the way
// the production default (~/.config/lightroom-mcp/...) never would.
function shortTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lripc-'));
}

describe('PrimaryIpcServer + SecondaryIpcClient', () => {
  let dir: string;
  let address: string;
  let server: PrimaryIpcServer | null = null;
  let client: SecondaryIpcClient | null = null;

  beforeEach(() => {
    dir = shortTmpDir();
    address = path.join(dir, 'b.sock');
  });

  afterEach(async () => {
    client?.stop();
    client = null;
    if (server) await server.stop();
    server = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function startServer(opts: {
    ready?: boolean;
    notReadyMessage?: () => string;
    call?: (action: string, params: unknown) => Promise<PluginResponse>;
  } = {}): Promise<PrimaryIpcServer> {
    const srv = new PrimaryIpcServer({
      address,
      isReady: () => opts.ready ?? true,
      notReadyMessage: opts.notReadyMessage,
      dispatcher: { call: opts.call ?? (async () => ({ id: 'x', result: null })) },
      log: () => {},
    });
    await srv.start();
    server = srv;
    return srv;
  }

  function newClient(timeoutMs = 2_000): SecondaryIpcClient {
    const c = new SecondaryIpcClient({ address, timeoutMs, log: () => {} });
    client = c;
    return c;
  }

  describe('status()', () => {
    it('reports ready:true with no message when the primary is ready', async () => {
      await startServer({ ready: true });
      const c = newClient();
      await c.connect();
      await expect(c.status()).resolves.toEqual({ ready: true, message: undefined });
    });

    it('reports ready:false with the notReadyMessage when the primary is not ready', async () => {
      await startServer({ ready: false, notReadyMessage: () => 'plugin not connected' });
      const c = newClient();
      await c.connect();
      await expect(c.status()).resolves.toEqual({ ready: false, message: 'plugin not connected' });
    });
  });

  describe('call()', () => {
    it('forwards action and params to the primary dispatcher and returns its result', async () => {
      let captured: { action: string; params: unknown } | null = null;
      await startServer({
        call: async (action, params) => {
          captured = { action, params };
          return { id: 'ignored', result: { ok: true } };
        },
      });
      const c = newClient();
      await c.connect();

      const resp = await c.call('search_photos', { rating: 5 });
      expect(captured).toEqual({ action: 'search_photos', params: { rating: 5 } });
      expect(resp.result).toEqual({ ok: true });
      expect(resp.error).toBeUndefined();
    });

    it('carries an error field from the primary dispatcher through untouched', async () => {
      await startServer({ call: async () => ({ id: 'x', error: 'No catalog open' }) });
      const c = newClient();
      await c.connect();

      const resp = await c.call('list_collections', {});
      expect(resp.error).toBe('No catalog open');
    });

    it('turns a thrown dispatcher error into a result error instead of dropping the request', async () => {
      await startServer({
        call: async () => {
          throw new Error('boom');
        },
      });
      const c = newClient();
      await c.connect();

      const resp = await c.call('set_rating', {});
      expect(resp.error).toBe('boom');
    });

    it('multiplexes multiple concurrent calls correctly by id', async () => {
      await startServer({
        call: async (action, params) => {
          const p = params as { n: number };
          await new Promise((r) => setTimeout(r, p.n % 2 === 0 ? 5 : 20));
          return { id: 'x', result: { action, n: p.n } };
        },
      });
      const c = newClient();
      await c.connect();

      const results = await Promise.all([
        c.call('a', { n: 1 }),
        c.call('a', { n: 2 }),
        c.call('a', { n: 3 }),
      ]);
      expect(results.map((r) => (r.result as { n: number }).n)).toEqual([1, 2, 3]);
    });
  });

  describe('connect()', () => {
    it('rejects when nothing is listening at the address', async () => {
      const c = newClient(500);
      await expect(c.connect()).rejects.toThrow();
    });

    it('rejects call() when never connected', async () => {
      const c = newClient();
      await expect(c.call('x', {})).rejects.toThrow(/not connected/i);
    });
  });

  describe('disconnect handling', () => {
    it('fires onDisconnect and rejects in-flight calls when the primary goes away mid-request', async () => {
      let resolveCall: (() => void) | null = null;
      await startServer({
        call: () =>
          new Promise((resolve) => {
            resolveCall = () => resolve({ id: 'x', result: null });
          }),
      });
      const onDisconnect = jest.fn();
      const c = new SecondaryIpcClient({ address, timeoutMs: 2_000, log: () => {}, onDisconnect });
      client = c;
      await c.connect();

      const pendingCall = c.call('slow', {});
      // Kill the primary out from under the still-open connection instead of
      // a graceful stop(), mirroring an actual crash.
      await server!.stop();
      server = null;

      await expect(pendingCall).rejects.toThrow(/lost connection/i);
      expect(onDisconnect).toHaveBeenCalledTimes(1);
      void resolveCall;
    });

    it('does not fire onDisconnect when the client stops itself deliberately', async () => {
      await startServer();
      const onDisconnect = jest.fn();
      const c = new SecondaryIpcClient({ address, timeoutMs: 2_000, log: () => {}, onDisconnect });
      client = c;
      await c.connect();

      c.stop();
      await new Promise((r) => setTimeout(r, 50));
      expect(onDisconnect).not.toHaveBeenCalled();
    });
  });

  describe('stale socket file recovery', () => {
    it('clears a leftover non-socket file at the address and binds successfully', async () => {
      fs.writeFileSync(address, 'not actually a socket');
      const srv = await startServer({ ready: true });
      void srv;

      const c = newClient();
      await c.connect();
      await expect(c.status()).resolves.toEqual({ ready: true, message: undefined });
    });
  });

  describe('isConnected()', () => {
    it('is false before connect and true after', async () => {
      await startServer();
      const c = newClient();
      expect(c.isConnected()).toBe(false);
      await c.connect();
      expect(c.isConnected()).toBe(true);
    });
  });

  describe('second listener on an address already bound', () => {
    it('fails to start, leaving the first server\'s clearStaleAddress "still listening" path exercised', async () => {
      await startServer({ ready: true });

      const second = new PrimaryIpcServer({
        address,
        isReady: () => true,
        dispatcher: { call: async () => ({ id: 'x', result: null }) },
        log: () => {},
      });
      await expect(second.start()).rejects.toThrow();

      // The first server is still the one actually listening.
      const c = newClient();
      await c.connect();
      await expect(c.status()).resolves.toEqual({ ready: true, message: undefined });
    });
  });

  describe('stale address cleanup failure', () => {
    it('propagates a non-ENOENT error clearing a stale address instead of silently starting anyway', async () => {
      fs.writeFileSync(address, 'stale, not a real socket');
      const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      });
      const srv = new PrimaryIpcServer({
        address,
        isReady: () => true,
        dispatcher: { call: async () => ({ id: 'x', result: null }) },
        log: () => {},
      });
      try {
        await expect(srv.start()).rejects.toThrow(/permission denied/);
      } finally {
        unlinkSpy.mockRestore();
      }
    });

    it('swallows an ENOENT clearing a stale address (already gone) and starts normally', async () => {
      fs.writeFileSync(address, 'stale, not a real socket');
      // The mock stands in for "something else removed it first": it both
      // reports ENOENT *and* actually removes the file, so the swallowed
      // error is honest and the subsequent listen() has a genuinely free
      // path to bind, matching what a real race would look like.
      const unlinkSpy = jest.spyOn(fs, 'unlinkSync').mockImplementationOnce((p: fs.PathLike) => {
        fs.rmSync(p, { force: true });
        throw Object.assign(new Error('already gone'), { code: 'ENOENT' });
      });
      const srv = new PrimaryIpcServer({
        address,
        isReady: () => true,
        dispatcher: { call: async () => ({ id: 'x', result: null }) },
        log: () => {},
      });
      try {
        await expect(srv.start()).resolves.toBeUndefined();
        server = srv;
      } finally {
        unlinkSpy.mockRestore();
      }
    });
  });

  describe('default options', () => {
    it('uses a console.error log when none is supplied', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const srv = new PrimaryIpcServer({
        address,
        isReady: () => true,
        dispatcher: { call: async () => ({ id: 'x', result: null }) },
      });
      await srv.start();
      server = srv;

      const raw = net.createConnection(address);
      await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
      raw.write('not json\n');
      await new Promise((r) => setTimeout(r, 50));
      raw.destroy();

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[ipc-server] bad JSON from secondary:'));
      consoleSpy.mockRestore();
    });
  });

  describe('platform-specific address cleanup (Windows has no filesystem entry to leak)', () => {
    function withPlatform(platform: NodeJS.Platform): () => void {
      const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
      return () => Object.defineProperty(process, 'platform', original);
    }

    it('skips the stale-address probe on start() when platform is win32', async () => {
      // A real, still-listening address on this (POSIX) test runner --
      // proves clearStaleAddress's win32 branch is what's taken, since the
      // non-Windows path would instead probe it, find it live, and (per the
      // "second listener" test above) fail to bind.
      await startServer({ ready: true });

      const restore = withPlatform('win32');
      const second = new PrimaryIpcServer({
        address,
        isReady: () => true,
        dispatcher: { call: async () => ({ id: 'x', result: null }) },
        log: () => {},
      });
      try {
        await expect(second.start()).rejects.toThrow(); // still fails to bind -- just skips the probe on the way there
      } finally {
        restore();
        await second.stop().catch(() => {});
      }
    });

    it('skips unlinking the address on stop() when platform is win32', async () => {
      await startServer({ ready: true });
      // Node's own server.close() already removes a Unix-domain-socket file
      // as part of a graceful close on this platform, independent of our
      // own guard -- so existence of the file afterwards isn't a reliable
      // signal. Assert directly that our own unlink call is skipped instead.
      const unlinkSpy = jest.spyOn(fs, 'unlinkSync');
      const restore = withPlatform('win32');
      try {
        await server!.stop();
        server = null;
      } finally {
        restore();
      }
      expect(unlinkSpy).not.toHaveBeenCalledWith(address);
      unlinkSpy.mockRestore();
    });
  });

  describe('malformed / unexpected wire traffic', () => {
    // These exercise paths a well-behaved SecondaryIpcClient/PrimaryIpcServer
    // pair never produces against each other -- a corrupt line, or a reply
    // whose `type` doesn't match what was asked for -- by talking to a raw
    // net socket standing in for a misbehaving/buggy peer instead.

    it('server logs and survives malformed JSON from a secondary', async () => {
      const logs: string[] = [];
      const srv = new PrimaryIpcServer({
        address,
        isReady: () => true,
        dispatcher: { call: async () => ({ id: 'x', result: null }) },
        log: (m) => logs.push(m),
      });
      await srv.start();
      server = srv;

      const raw = net.createConnection(address);
      await new Promise<void>((resolve) => raw.once('connect', () => resolve()));
      raw.write('not json at all\n');
      await new Promise((r) => setTimeout(r, 50));
      raw.destroy();

      expect(logs.some((m) => /bad JSON from secondary/i.test(m))).toBe(true);

      // The server is still healthy for a real client afterwards.
      const c = newClient();
      await c.connect();
      await expect(c.status()).resolves.toEqual({ ready: true, message: undefined });
    });

    it('client logs and survives malformed JSON from the primary', async () => {
      const raw = net.createServer((socket) => {
        socket.write('also not json\n');
      });
      await new Promise<void>((resolve) => raw.listen(address, () => resolve()));

      const logs: string[] = [];
      const c = new SecondaryIpcClient({ address, timeoutMs: 500, log: (m) => logs.push(m) });
      client = c;
      await c.connect();
      await new Promise((r) => setTimeout(r, 50));

      expect(logs.some((m) => /bad JSON from primary/i.test(m))).toBe(true);
      // server.close()'s callback only fires once every connection has
      // ended, not merely once new ones are refused -- close the client
      // side first or this hangs until the test's own timeout.
      c.stop();
      raw.close(); // fire-and-forget: close()'s callback only fires once every accepted connection also ends, which the client-side destroy() above doesn't reliably guarantee happens before this line runs
    });

    it('call() rejects when the primary replies with a status message instead of a result', async () => {
      const raw = net.createServer((socket) => {
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          const id = (JSON.parse(chunk) as { id: string }).id;
          socket.write(JSON.stringify({ type: 'status', id, ready: true }) + '\n');
        });
      });
      await new Promise<void>((resolve) => raw.listen(address, () => resolve()));

      const c = new SecondaryIpcClient({ address, timeoutMs: 500, log: () => {} });
      client = c;
      await c.connect();

      await expect(c.call('x', {})).rejects.toThrow(/unexpected reply type/i);
      c.stop();
      raw.close(); // fire-and-forget: close()'s callback only fires once every accepted connection also ends, which the client-side destroy() above doesn't reliably guarantee happens before this line runs
    });

    it('status() rejects when the primary replies with a result message instead of a status', async () => {
      const raw = net.createServer((socket) => {
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          const id = (JSON.parse(chunk) as { id: string }).id;
          socket.write(JSON.stringify({ type: 'result', id, result: null }) + '\n');
        });
      });
      await new Promise<void>((resolve) => raw.listen(address, () => resolve()));

      const c = new SecondaryIpcClient({ address, timeoutMs: 500, log: () => {} });
      client = c;
      await c.connect();

      await expect(c.status()).rejects.toThrow(/unexpected reply type/i);
      c.stop();
      raw.close(); // fire-and-forget: close()'s callback only fires once every accepted connection also ends, which the client-side destroy() above doesn't reliably guarantee happens before this line runs
    });

    it('roundTrip times out when the primary accepts the connection but never replies', async () => {
      const raw = net.createServer(() => {
        // Accept and go silent -- never write anything back.
      });
      await new Promise<void>((resolve) => raw.listen(address, () => resolve()));

      const c = new SecondaryIpcClient({ address, timeoutMs: 100, log: () => {} });
      client = c;
      await c.connect();

      await expect(c.call('x', {})).rejects.toThrow(/did not respond within/i);
      c.stop();
      raw.close(); // fire-and-forget: close()'s callback only fires once every accepted connection also ends, which the client-side destroy() above doesn't reliably guarantee happens before this line runs
    });

    it('connect() times out if neither "connect" nor "error" ever fires', async () => {
      jest.useFakeTimers();
      const fakeSocket = {
        once: jest.fn(),
        destroy: jest.fn(),
        setEncoding: jest.fn(),
        on: jest.fn(),
        write: jest.fn(),
      };
      const createConnectionSpy = jest
        .spyOn(net, 'createConnection')
        .mockReturnValue(fakeSocket as unknown as net.Socket);

      try {
        const c = new SecondaryIpcClient({ address, timeoutMs: 1_000, log: () => {} });
        const connectPromise = c.connect();
        const assertion = expect(connectPromise).rejects.toThrow(/timed out connecting/i);
        jest.advanceTimersByTime(1_000);
        await assertion;
        expect(fakeSocket.destroy).toHaveBeenCalled();
      } finally {
        createConnectionSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    it('ignores a reply whose id has no matching pending call instead of crashing', async () => {
      const raw = net.createServer((socket) => {
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          // Reply to an id nobody asked about first, then answer the real
          // request normally -- the orphan reply must be silently dropped,
          // not misdelivered to the real pending call.
          socket.write(JSON.stringify({ type: 'result', id: 'nobody-asked-for-this', result: 'orphan' }) + '\n');
          const req = JSON.parse(chunk) as { id: string };
          socket.write(JSON.stringify({ type: 'result', id: req.id, result: 'real-answer' }) + '\n');
        });
      });
      await new Promise<void>((resolve) => raw.listen(address, () => resolve()));

      const c = new SecondaryIpcClient({ address, timeoutMs: 500, log: () => {} });
      client = c;
      await c.connect();

      const resp = await c.call('x', {});
      expect(resp.result).toBe('real-answer');

      c.stop();
      raw.close();
    });

    it('uses default timeoutMs and a console.error log when neither is supplied', async () => {
      const raw = net.createServer((socket) => {
        socket.write('this is not json\n');
      });
      await new Promise<void>((resolve) => raw.listen(address, () => resolve()));

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      // No timeoutMs, no log -- exercises both `??` defaults in the constructor.
      const c = new SecondaryIpcClient({ address });
      client = c;
      await c.connect();
      await new Promise((r) => setTimeout(r, 50));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[ipc-client] bad JSON from primary:'));
      consoleSpy.mockRestore();
      c.stop();
      raw.close();
    });
  });
});
