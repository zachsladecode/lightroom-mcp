import { describe, it, expect } from '@jest/globals';
import { SwitchableDispatcher } from '../src/switchable-dispatcher.js';

describe('SwitchableDispatcher', () => {
  it('throws "not ready" when no target has been set', async () => {
    const d = new SwitchableDispatcher();
    await expect(d.call('list_collections', {})).rejects.toThrow(/not ready/i);
  });

  it('forwards call() to whatever target is set', async () => {
    const d = new SwitchableDispatcher();
    d.setTarget({ call: async (action, params) => ({ id: 'x', result: { action, params } }) });

    const resp = await d.call('search_photos', { rating: 5 });
    expect(resp.result).toEqual({ action: 'search_photos', params: { rating: 5 } });
  });

  it('switches targets and forwards to the new one', async () => {
    const d = new SwitchableDispatcher();
    d.setTarget({ call: async () => ({ id: 'x', result: 'first' }) });
    d.setTarget({ call: async () => ({ id: 'x', result: 'second' }) });

    const resp = await d.call('x', {});
    expect(resp.result).toBe('second');
  });

  it('goes back to throwing once the target is cleared', async () => {
    const d = new SwitchableDispatcher();
    d.setTarget({ call: async () => ({ id: 'x', result: 'ok' }) });
    d.setTarget(null);

    await expect(d.call('x', {})).rejects.toThrow(/not ready/i);
  });
});
