import { getRandomBytes } from 'expo-crypto';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastActivityIdTime = -1;
let lastActivityIdRandom = '';

function encodeUlidTime(timestamp: number): string {
  let remaining = timestamp;
  let encoded = '';
  for (let index = 0; index < 10; index += 1) {
    encoded = ULID_ALPHABET[remaining % 32] + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

/** Encodes 80 native-random bits as the ULID's exact 16 Crockford-base32 characters. */
function encodeUlidRandom(bytes: Uint8Array): string {
  let buffer = 0;
  let bitCount = 0;
  let encoded = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      encoded += ULID_ALPHABET[(buffer >>> bitCount) & 31];
      buffer &= (1 << bitCount) - 1;
    }
  }
  return encoded;
}

function incrementUlidRandom(value: string): string {
  const characters = [...value];
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    const position = character === undefined ? -1 : ULID_ALPHABET.indexOf(character);
    if (position < ULID_ALPHABET.length - 1) {
      characters[index] = ULID_ALPHABET[position + 1] ?? '0';
      return characters.join('');
    }
    characters[index] = '0';
  }
  throw new Error('Activity identity space exhausted for this millisecond.');
}

/** Mints a monotonic client Activity identity using Expo's Hermes-safe native CSPRNG. */
export function nextActivityId(): string {
  const now = Date.now();
  if (now <= lastActivityIdTime) {
    lastActivityIdRandom = incrementUlidRandom(lastActivityIdRandom);
    return `act_${encodeUlidTime(lastActivityIdTime)}${lastActivityIdRandom}`;
  }
  lastActivityIdTime = now;
  lastActivityIdRandom = encodeUlidRandom(getRandomBytes(10));
  return `act_${encodeUlidTime(now)}${lastActivityIdRandom}`;
}
