import { describe, it, expect } from '@jest/globals';
import { LineBuffer, encodeIpcMessage } from '../src/ipc-protocol.js';

describe('encodeIpcMessage', () => {
  it('JSON-encodes the message with a trailing newline', () => {
    const encoded = encodeIpcMessage({ type: 'status', id: '1' });
    expect(encoded).toBe(JSON.stringify({ type: 'status', id: '1' }) + '\n');
  });
});

describe('LineBuffer', () => {
  it('returns nothing until a newline arrives', () => {
    const b = new LineBuffer();
    expect(b.push('no newline yet')).toEqual([]);
  });

  it('splits a single chunk containing multiple lines', () => {
    const b = new LineBuffer();
    expect(b.push('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
  });

  it('carries a partial line across chunks', () => {
    const b = new LineBuffer();
    expect(b.push('hel')).toEqual([]);
    expect(b.push('lo\n')).toEqual(['hello']);
  });

  it('drops blank lines instead of emitting empty strings', () => {
    const b = new LineBuffer();
    expect(b.push('a\n\n\nb\n')).toEqual(['a', 'b']);
  });

  it('trims whitespace around each line', () => {
    const b = new LineBuffer();
    expect(b.push('  a  \n')).toEqual(['a']);
  });
});
