import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeLiveness,
  readLiveness,
  isLivenessStale,
  startLivenessHeartbeat,
} from '../src/liveness.js';

describe('liveness', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrmcp-live-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('writeLiveness / readLiveness', () => {
    it('round-trips pid and timestamp', () => {
      const file = path.join(dir, 'x.heartbeat');
      writeLiveness(file, 4242, 1_000);
      expect(readLiveness(file)).toEqual({ pid: 4242, updatedAt: 1_000 });
    });

    it('defaults the timestamp to now when omitted', () => {
      const file = path.join(dir, 'x.heartbeat');
      const before = Date.now();
      writeLiveness(file, 1);
      const after = Date.now();
      const record = readLiveness(file);
      expect(record).not.toBeNull();
      expect(record!.updatedAt).toBeGreaterThanOrEqual(before);
      expect(record!.updatedAt).toBeLessThanOrEqual(after);
    });

    it('leaves no leftover temp file behind', () => {
      const file = path.join(dir, 'x.heartbeat');
      writeLiveness(file, 1, 1_000);
      expect(fs.readdirSync(dir)).toEqual(['x.heartbeat']);
    });
  });

  describe('readLiveness', () => {
    it('returns null when the file does not exist', () => {
      expect(readLiveness(path.join(dir, 'missing.heartbeat'))).toBeNull();
    });

    it('returns null for malformed JSON', () => {
      const file = path.join(dir, 'bad.heartbeat');
      fs.writeFileSync(file, 'not json');
      expect(readLiveness(file)).toBeNull();
    });

    it('returns null when required fields are missing or wrong-typed', () => {
      const file = path.join(dir, 'partial.heartbeat');
      fs.writeFileSync(file, JSON.stringify({ pid: 'not-a-number', updatedAt: 1 }));
      expect(readLiveness(file)).toBeNull();

      fs.writeFileSync(file, JSON.stringify({ pid: 1 }));
      expect(readLiveness(file)).toBeNull();
    });
  });

  describe('isLivenessStale', () => {
    it('treats a missing record as stale', () => {
      expect(isLivenessStale(null, 10_000, 100_000)).toBe(true);
    });

    it('is not stale within the max age window', () => {
      expect(isLivenessStale({ pid: 1, updatedAt: 90_000 }, 10_000, 95_000)).toBe(false);
    });

    it('is stale once older than the max age window', () => {
      expect(isLivenessStale({ pid: 1, updatedAt: 80_000 }, 10_000, 95_000)).toBe(true);
    });

    it('defaults `now` to Date.now() when omitted', () => {
      expect(isLivenessStale({ pid: 1, updatedAt: Date.now() }, 10_000)).toBe(false);
    });
  });

  describe('startLivenessHeartbeat', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('writes a record immediately, then rewrites it on each interval', () => {
      const file = path.join(dir, 'hb.heartbeat');
      const timer = startLivenessHeartbeat(file, 777, 10_000);

      const first = readLiveness(file);
      expect(first?.pid).toBe(777);

      jest.advanceTimersByTime(10_000);
      const second = readLiveness(file);
      expect(second?.pid).toBe(777);
      expect(second!.updatedAt).toBeGreaterThanOrEqual(first!.updatedAt);

      clearInterval(timer);
    });

    it('stops rewriting once the returned timer is cleared', () => {
      const file = path.join(dir, 'hb.heartbeat');
      const timer = startLivenessHeartbeat(file, 1, 10_000);
      clearInterval(timer);
      const afterFirstWrite = fs.statSync(file).mtimeMs;

      jest.advanceTimersByTime(50_000);
      expect(fs.statSync(file).mtimeMs).toBe(afterFirstWrite);
    });

    it('reports write failures via onError instead of throwing', () => {
      const file = path.join(dir, 'nested', 'does-not-exist', 'hb.heartbeat');
      const onError = jest.fn();

      expect(() => startLivenessHeartbeat(file, 1, 10_000, onError)).not.toThrow();
      expect(onError).toHaveBeenCalledTimes(1);
      const err = onError.mock.calls[0][0] as Error;
      expect(typeof err.message).toBe('string');
      expect(err.message.length).toBeGreaterThan(0);
    });

    it('logs a failure to console.error when onError is not supplied', () => {
      const file = path.join(dir, 'nested', 'does-not-exist', 'hb.heartbeat');
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      startLivenessHeartbeat(file, 1, 10_000);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[liveness] write failed:'));
      consoleSpy.mockRestore();
    });

    it('reports a failure on a later interval tick too, not just the first write', () => {
      const file = path.join(dir, 'hb.heartbeat');
      const onError = jest.fn();
      const timer = startLivenessHeartbeat(file, 1, 10_000, onError);
      expect(onError).not.toHaveBeenCalled();

      // Remove the whole directory out from under the writer so the next
      // tick's write fails, without touching the (already-succeeded) first
      // write we just asserted on.
      fs.rmSync(dir, { recursive: true, force: true });

      jest.advanceTimersByTime(10_000);
      expect(onError).toHaveBeenCalledTimes(1);

      clearInterval(timer);
      fs.mkdirSync(dir, { recursive: true }); // afterEach expects this to exist
    });
  });
});
