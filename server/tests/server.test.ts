import { describe, it, expect, afterEach } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/create-server.js';
import { acquireInstanceLock, type InstanceLock } from '../src/instance-lock.js';
import type { PluginResponse } from '../src/dispatcher.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function asToolResult(r: unknown): ToolResult {
  return r as ToolResult;
}

type CallFn = (action: string, params: unknown) => Promise<PluginResponse>;

interface Pair {
  server: ReturnType<typeof createMcpServer>;
  client: Client;
}

async function connect(
  opts: { ready?: boolean; notReadyMessage?: () => string; call?: CallFn } = {},
): Promise<Pair> {
  const server = createMcpServer({
    isReady: () => opts.ready ?? true,
    notReadyMessage: opts.notReadyMessage,
    dispatcher: {
      call: opts.call ?? (async () => ({ id: 'x', result: null })),
    },
  });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe('createMcpServer', () => {
  let pair: Pair | null = null;

  afterEach(async () => {
    if (pair) {
      await pair.client.close();
      await pair.server.close();
      pair = null;
    }
  });

  describe('ListTools', () => {
    it('returns all 18 tools', async () => {
      pair = await connect();
      const { tools } = await pair.client.listTools();
      expect(tools).toHaveLength(18);
    });

    it('includes search_photos and set_develop_settings', async () => {
      pair = await connect();
      const { tools } = await pair.client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('search_photos');
      expect(names).toContain('set_develop_settings');
    });

    it('each tool has a non-empty description and object inputSchema', async () => {
      pair = await connect();
      const { tools } = await pair.client.listTools();
      for (const tool of tools) {
        expect(tool.description!.length).toBeGreaterThan(0);
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  describe('CallTool — connection gate', () => {
    it('returns isError when plugin sockets not ready', async () => {
      pair = await connect({ ready: false });
      const result = asToolResult(await pair.client.callTool({ name: 'list_collections', arguments: {} }));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not connected/i);
    });

    it('does not call dispatcher when not ready', async () => {
      let called = false;
      pair = await connect({
        ready: false,
        call: async () => { called = true; return { id: '1', result: null }; },
      });
      await pair.client.callTool({ name: 'list_collections', arguments: {} });
      expect(called).toBe(false);
    });
  });

  describe('CallTool — happy path', () => {
    it('forwards tool name and args to dispatcher', async () => {
      let captured: { action: string; params: unknown } | null = null;
      pair = await connect({
        call: async (action, params) => {
          captured = { action, params };
          return { id: '1', result: [] };
        },
      });
      await pair.client.callTool({ name: 'search_photos', arguments: { rating: 5 } });
      expect(captured).toEqual({ action: 'search_photos', params: { rating: 5 } });
    });

    it('returns pretty-printed JSON text on success', async () => {
      const data = { count: 2, items: ['a', 'b'] };
      pair = await connect({ call: async () => ({ id: '1', result: data }) });
      const result = asToolResult(await pair.client.callTool({ name: 'get_selected_photos', arguments: {} }));
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(result.content[0].text)).toEqual(data);
    });

    it('passes undefined args as empty object to dispatcher', async () => {
      let capturedParams: unknown = 'not-set';
      pair = await connect({
        call: async (_action, params) => {
          capturedParams = params;
          return { id: '1', result: null };
        },
      });
      await pair.client.callTool({ name: 'list_develop_presets' });
      expect(capturedParams).toEqual({});
    });
  });

  describe('CallTool — error paths', () => {
    it('returns isError with prefixed message on plugin error response', async () => {
      pair = await connect({ call: async () => ({ id: '1', error: 'No catalog open' }) });
      const result = asToolResult(await pair.client.callTool({ name: 'list_collections', arguments: {} }));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error: No catalog open');
    });

    it('returns isError when dispatcher throws timeout', async () => {
      pair = await connect({
        call: async () => { throw new Error('Plugin response timeout (30s)'); },
      });
      const result = asToolResult(await pair.client.callTool({ name: 'search_photos', arguments: {} }));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Plugin response timeout (30s)');
    });

    it('returns isError when dispatcher throws socket-dropped error', async () => {
      pair = await connect({
        call: async () => { throw new Error('Failed to send request to plugin (socket dropped)'); },
      });
      const result = asToolResult(await pair.client.callTool({ name: 'set_rating', arguments: {} }));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/socket dropped/);
    });

    it('stringifies non-Error throws', async () => {
      pair = await connect({
        call: async () => { throw 'raw string error'; },
      });
      const result = asToolResult(await pair.client.callTool({ name: 'list_collections', arguments: {} }));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('raw string error');
    });
  });

  describe('CallTool — instance lock conflict', () => {
    // Regression for the version-negotiation failure this server hits inside
    // Claude Code/Cowork's shared MCP pool: a disposable sibling process is
    // spun up to complete the MCP handshake while a live instance already
    // holds the plugin-socket lock. The handshake (list_tools/call_tool) must
    // still succeed here even though the lock itself could not be acquired.
    let tmpDir: string | null = null;
    let heldLock: InstanceLock | null = null;

    afterEach(() => {
      heldLock?.release();
      heldLock = null;
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        tmpDir = null;
      }
    });

    it('completes the handshake and reports the lock conflict instead of crashing', async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightroom-mcp-server-lock-test-'));
      heldLock = acquireInstanceLock(58763, 58764, tmpDir);

      let conflictMessage: string;
      try {
        acquireInstanceLock(58763, 58764, tmpDir);
        throw new Error('expected acquireInstanceLock to throw on conflict');
      } catch (err) {
        conflictMessage = (err as Error).message;
      }
      expect(conflictMessage).toMatch(/Another Lightroom MCP bridge is already running/);

      pair = await connect({ ready: false, notReadyMessage: () => conflictMessage });

      const { tools } = await pair.client.listTools();
      expect(tools.length).toBeGreaterThan(0);

      const result = asToolResult(await pair.client.callTool({ name: 'list_collections', arguments: {} }));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(conflictMessage);
      expect(result.content[0].text).not.toMatch(/not connected/i);
    });
  });
});
