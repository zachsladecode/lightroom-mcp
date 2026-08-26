import { describe, it, expect, afterEach } from '@jest/globals';
import os from 'node:os';
import path from 'node:path';
import { defaultBaseDir, lockFilePath, livenessFilePath, ipcAddress } from '../src/bridge-paths.js';

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('bridge-paths', () => {
  afterEach(() => {
    // withPlatform always restores itself, but be defensive in case an
    // assertion throws mid-callback.
  });

  it('defaultBaseDir() is under the user home config dir', () => {
    expect(defaultBaseDir()).toBe(path.join(os.homedir(), '.config', 'lightroom-mcp'));
  });

  it('lockFilePath() names the file after both ports', () => {
    expect(lockFilePath('/base', 1, 2)).toBe(path.join('/base', 'bridge-1-2.lock'));
  });

  it('livenessFilePath() names the file after both ports', () => {
    expect(livenessFilePath('/base', 1, 2)).toBe(path.join('/base', 'bridge-1-2.heartbeat'));
  });

  describe('ipcAddress()', () => {
    it('is a .sock file under baseDir on non-Windows platforms', () => {
      withPlatform('linux', () => {
        expect(ipcAddress('/base', 1, 2)).toBe(path.join('/base', 'bridge-1-2.sock'));
      });
    });

    it('is a named pipe address on Windows, independent of baseDir', () => {
      withPlatform('win32', () => {
        expect(ipcAddress('/base', 1, 2)).toBe('\\\\.\\pipe\\lightroom-mcp-bridge-1-2');
      });
    });
  });
});
