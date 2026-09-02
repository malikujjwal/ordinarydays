import { describe, expect, it } from 'vitest';
import { decodeBase64 } from './base64';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('decodeBase64', () => {
  it('decodes padded, unpadded and URL-safe input to the same bytes', () => {
    expect(text(decodeBase64('aGVsbG8='))).toBe('hello');
    expect(text(decodeBase64('aGVsbG8'))).toBe('hello');
    expect(text(decodeBase64('aGVsbG8gd29ybGQ='))).toBe('hello world');
    // `+/` and `-_` alphabets agree.
    expect(decodeBase64('+/8=')).toEqual(decodeBase64('-_8'));
  });

  it('tolerates a data-URL prefix and whitespace, as web pickers produce', () => {
    expect(text(decodeBase64('data:image/png;base64,aGVs\nbG8='))).toBe('hello');
  });

  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array(257).map((_, i) => i % 256);
    const encoded = btoa(String.fromCharCode(...bytes));
    expect(decodeBase64(encoded)).toEqual(bytes);
  });

  it('refuses characters outside the alphabet rather than guessing', () => {
    expect(() => decodeBase64('aGV$sbG8=')).toThrow(/Not base64/);
  });
});
