import { AppError } from '../lib/errors.js';

/**
 * Opaque pagination cursors (`api-contract.md` §1).
 *
 * A cursor is a base64url encoding of DynamoDB's `LastEvaluatedKey`. It is **opaque by
 * contract**: the client stores it and hands it back, and nothing outside this file decodes
 * one.
 *
 * ## Why it is validated rather than trusted
 *
 * A cursor arrives from the client, so it is attacker-controlled input that is handed almost
 * directly to the database. Two things follow, and both are enforced here:
 *
 * - **A decoded cursor whose shape does not match the expected key attributes is
 *   `validation_failed`, never passed to DynamoDB.** An `ExclusiveStartKey` naming attributes
 *   the query does not key on is at best an error from the SDK and at worst a query against
 *   a partition the caller did not ask for.
 * - **The caller states which attributes it expects.** `decodeCursor(raw, ['pk', 'sk'])`
 *   rejects anything else, so a cursor minted for a GSI1 query cannot be replayed against a
 *   table query — and a cursor from another user's page fails the caller's own key scoping
 *   one layer up, in the repository that supplies the partition.
 */

/** The maximum encoded length, matching the shared `cursor` schema's bound. */
const MAX_CURSOR_LENGTH = 2048;

/** A DynamoDB key: string attributes only, which is every key in this table. */
export type PageKey = Record<string, string>;

/** A list-item page position bound to the META rank generation that minted it. */
export interface FencedCursor {
  readonly lastEvaluatedKey: PageKey;
  readonly rankVersion: number;
}

const toBase64Url = (value: string) =>
  Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const fromBase64Url = (value: string) =>
  Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/**
 * Encodes a `LastEvaluatedKey` for the client, or `undefined` when there is no next page.
 *
 * Returning `undefined` rather than an empty string matters: `meta.nextCursor` is present
 * **only when there is another page**, so a client can branch on presence instead of on
 * emptiness.
 */
export function encodeCursor(lastEvaluatedKey: PageKey | undefined): string | undefined {
  if (lastEvaluatedKey === undefined) return undefined;
  return toBase64Url(JSON.stringify(lastEvaluatedKey));
}

/** Encodes a list-item cursor together with the rank fence that issued it. */
export function encodeFencedCursor(
  lastEvaluatedKey: PageKey | undefined,
  rankVersion: number,
): string | undefined {
  if (lastEvaluatedKey === undefined) return undefined;
  return toBase64Url(JSON.stringify({ lastEvaluatedKey, rankVersion }));
}

/**
 * Decodes a client-supplied cursor, or `undefined` when none was supplied.
 *
 * @param expectedAttributes the exact key attributes this query pages on, e.g.
 *   `['pk', 'sk']` for a table query or `['pk', 'sk', 'gsi1pk', 'gsi1sk']` for GSI1.
 * @throws AppError `validation_failed` for anything that is not a cursor this API minted.
 */
export function decodeCursor(
  raw: string | undefined,
  expectedAttributes: readonly string[],
): PageKey | undefined {
  const parsed = parseCursor(raw);
  return parsed === undefined ? undefined : validatePageKey(parsed, expectedAttributes);
}

/** Decodes and validates a rank-version-bound list-item cursor. */
export function decodeFencedCursor(
  raw: string | undefined,
  expectedAttributes: readonly string[],
): FencedCursor | undefined {
  const parsed = parseCursor(raw);
  if (parsed === undefined) return undefined;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw malformed();
  }

  const entries = Object.entries(parsed);
  const actual = entries.map(([key]) => key).sort();
  if (
    actual.length !== 2 ||
    actual[0] !== 'lastEvaluatedKey' ||
    actual[1] !== 'rankVersion'
  ) {
    throw malformed();
  }

  const rankVersion = Reflect.get(parsed, 'rankVersion');
  const lastEvaluatedKey = Reflect.get(parsed, 'lastEvaluatedKey');
  if (
    typeof rankVersion !== 'number' ||
    !Number.isSafeInteger(rankVersion) ||
    rankVersion < 0
  ) {
    throw malformed();
  }

  return {
    lastEvaluatedKey: validatePageKey(lastEvaluatedKey, expectedAttributes),
    rankVersion,
  };
}

function parseCursor(raw: string | undefined): unknown | undefined {
  if (raw === undefined || raw === '') return undefined;

  // Bounded before decoding, so a hostile value cannot force an expensive parse.
  if (raw.length > MAX_CURSOR_LENGTH) throw malformed();

  try {
    return JSON.parse(fromBase64Url(raw));
  } catch {
    throw malformed();
  }
}

function validatePageKey(
  parsed: unknown,
  expectedAttributes: readonly string[],
): PageKey {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw malformed();
  }

  const entries = Object.entries(parsed);

  // Every value must be a string: this table's keys are all `S`, and a nested object or a
  // number here would be a cursor this API did not mint.
  if (!entries.every(([, value]) => typeof value === 'string')) throw malformed();

  // Exactly the expected attributes — no more, no fewer. "No more" is the half that
  // matters: extra attributes are how a cursor for one index gets replayed against another.
  const actual = entries.map(([key]) => key).sort();
  const expected = [...expectedAttributes].sort();
  if (actual.length !== expected.length) throw malformed();
  if (!actual.every((key, index) => key === expected[index])) throw malformed();

  return Object.fromEntries(entries) as PageKey;
}

/**
 * One message for every failure mode.
 *
 * A cursor is opaque, so there is nothing useful to tell the client about *why* theirs did
 * not decode — and distinguishing "bad base64" from "wrong attributes" would describe the
 * internals of a value the contract says they must not look inside.
 */
function malformed(): AppError {
  return new AppError('validation_failed', 'Malformed cursor.', [
    { path: 'cursor', message: 'Malformed cursor.' },
  ]);
}
