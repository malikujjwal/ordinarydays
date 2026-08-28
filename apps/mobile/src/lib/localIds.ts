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

/**
 * A client-minted prefixed ULID, from the device's CSPRNG.
 *
 * Both prefixes name something the client must be able to identify **before** the server has
 * seen it: a `rem_` reminder queued offline and armed locally under the same id it will
 * eventually be stored under (P2-57), and an `ing_` ingredient row an add-to-list action
 * names after the array has been reordered (P3-17, `data-model.md` §8). Neither is an entity
 * id the client may invent authority with — they are identities, and the server still decides
 * what may be done with them.
 *
 * The union is closed on purpose: a new prefix is a decision about what a client may name,
 * so it is made here rather than by passing a different string at a call site.
 */
export function newLocalId(prefix: 'rem' | 'ing' | 'sub'): string {
  return `${prefix}_${encodeTime(Date.now())}${encodeRandom(getRandomBytes(10))}`;
}
