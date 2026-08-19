import { getRandomBytes } from 'expo-crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(time: number): string {
  let value = time;
  let encoded = '';
  for (let index = 0; index < 10; index += 1) {
    encoded = `${ALPHABET[value % 32]}${encoded}`;
    value = Math.floor(value / 32);
  }
  return encoded;
}

function encodeRandom(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let encoded = '';
  for (const byte of bytes) {
    buffer = buffer * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += ALPHABET[Math.floor(buffer / 2 ** bits) % 32];
      buffer %= 2 ** bits;
    }
  }
  if (bits > 0) encoded += ALPHABET[(buffer * 2 ** (5 - bits)) % 32];
  return encoded.slice(0, 16).padEnd(16, '0');
}

export function newLocalId(prefix: 'rem'): string {
  return `${prefix}_${encodeTime(Date.now())}${encodeRandom(getRandomBytes(10))}`;
}
