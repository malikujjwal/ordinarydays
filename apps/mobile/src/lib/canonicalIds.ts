import { getRandomBytes } from 'expo-crypto';

/**
 * The client-minted canonical identities, from the device's native CSPRNG (ADR-055).
 *
 * A **prefixed, monotonic ULID factory** — one implementation, one source of randomness, one
 * per-millisecond ordering rule. It was `activityIds.ts` and minted `act_` only; P3-05 needs
 * the same identity for a `lst_` a device names before the server has seen it, and says so in
 * as many words: "do not add a weaker second random or clock-only generator". Generalising the
 * one that already exists is the whole of that instruction.
 *
 * ## Why these ids may be minted at all
 *
 * A durable create is accepted into SQLite before it reaches the network, so the row has to be
 * nameable while offline. ULIDs make that safe without coordination (`data-model.md` §8): the
 * server validates the shape, still derives owner and timestamps itself, and answers a
 * collision with the metadata-free error both create paths share.
 *
 * ## The union is closed, and the state is per prefix
 *
 * `CanonicalIdPrefix` lists what a client is allowed to name, so adding a third is a decision
 * made here rather than by passing a different string at a call site — the rule `localIds.ts`
 * states for the two identities that are *not* canonical entity ids.
 *
 * Each prefix keeps its **own** last-millisecond witness. Sharing one would make minting a
 * list perturb the next activity's random component, which is a behaviour change to `act_`
 * for no benefit; separate witnesses keep each sequence byte-identical to what a caller of
 * the previous single-prefix generator would have received.
 */
export type CanonicalIdPrefix = 'act' | 'lst';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

interface MonotonicWitness {
  time: number;
  random: string;
}

const WITNESSES = new Map<CanonicalIdPrefix, MonotonicWitness>();

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

function incrementUlidRandom(prefix: CanonicalIdPrefix, value: string): string {
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
  throw new Error(`The ${prefix}_ identity space is exhausted for this millisecond.`);
}

/**
 * Mints one monotonic client identity for `prefix`.
 *
 * Within a millisecond the random component is incremented rather than redrawn, so two ids
 * minted back to back still sort in the order they were created — which is what lets a
 * dependent write name its predecessor without a clock the client cannot trust.
 */
export function nextCanonicalId(prefix: CanonicalIdPrefix): string {
  const now = Date.now();
  const witness = WITNESSES.get(prefix);
  if (witness !== undefined && now <= witness.time) {
    witness.random = incrementUlidRandom(prefix, witness.random);
    return `${prefix}_${encodeUlidTime(witness.time)}${witness.random}`;
  }
  const random = encodeUlidRandom(getRandomBytes(10));
  WITNESSES.set(prefix, { time: now, random });
  return `${prefix}_${encodeUlidTime(now)}${random}`;
}
