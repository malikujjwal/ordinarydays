import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The opaque Undo token, and the one place its shape is decided (P3-10).
 *
 * ## Why it is addressed, not just random
 *
 * `POST /v1/lists/:id/undo` receives a token and nothing else. The operation it names lives
 * at `UNDO#<operationId>` in the list's partition, so the server has to get from one to the
 * other — and there is exactly one index in this table (`data-model.md` §2), which this is
 * not worth a second one. The alternatives were both worse than embedding the id: querying
 * every retained operation on the list and comparing hashes is a read that grows with 30 days
 * of the user's activity, and a lookup partition is a second write on every reversible
 * mutation to save a read on the few that are ever undone.
 *
 * So the token is `<operationId>.<secret>`: the first half addresses one `GetItem`, the second
 * half is 32 random bytes and is what actually authorises. Only the hash of the whole token
 * enters the retained `UNDO#` authority. Resumable work and the user-scoped exact-response
 * receipt may hold bounded plaintext copies so an interrupted operation or lost success can
 * still return the token it originally promised.
 *
 * **It stays opaque to the client.** Nothing outside this module parses it, the API never
 * documents its shape, and a client that split it would gain an operation id that authorises
 * nothing on its own.
 *
 * ## Why the comparison is constant-time
 *
 * The stored hash is compared against a hash of the presented token, so a timing oracle would
 * leak digest bytes rather than token bytes — but the tokens are long-lived by design
 * (`MAX_AUTOMATIC_INTENT_AGE_DAYS`, so an accepted offline inverse cannot expire in transit),
 * and a long-lived bearer credential is exactly the kind worth not leaking a byte at a time.
 * The cost is one comparison per Undo.
 */

/** Separates the addressable half from the secret half. Not valid inside either. */
const SEPARATOR = '.';

export interface MintedUndoToken {
  /**
   * Handed to the client. The retained `UNDO#` record stores only its hash; bounded
   * operation work and exact-response receipts may hold the token so a lost response can
   * still be replayed byte-for-byte.
   */
  readonly token: string;
  /** What the `UNDO#` record holds instead. */
  readonly tokenHash: string;
}

export function hashUndoToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

/** Mints one token; callers persist only `tokenHash` as the retained Undo authority. */
export function mintUndoToken(operationId: string): MintedUndoToken {
  const token = `${operationId}${SEPARATOR}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashUndoToken(token) };
}

/**
 * The operation a token addresses, or `undefined` when it addresses nothing.
 *
 * Shape only — this says which record to read, never that the caller may use it. The hash
 * comparison below is the authorisation, and it happens against what that record actually
 * stores.
 */
export function undoTokenOperationId(token: string): string | undefined {
  const at = token.indexOf(SEPARATOR);
  if (at <= 0 || at === token.length - 1) return undefined;
  return token.slice(0, at);
}

/** Whether a presented token is the one an operation recorded, compared in constant time. */
export function undoTokenMatches(token: string, storedHash: string): boolean {
  const presented = Buffer.from(hashUndoToken(token));
  const stored = Buffer.from(storedHash);
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}
