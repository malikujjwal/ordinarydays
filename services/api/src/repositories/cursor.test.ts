import { describe, expect, it } from 'vitest';
import { AppError } from '../lib/errors.js';
import {
  decodeCursor,
  decodeFencedCursor,
  encodeCursor,
  encodeFencedCursor,
} from './cursor.js';

const TABLE_KEY = ['pk', 'sk'] as const;
const INDEX_KEY = ['pk', 'sk', 'gsi1pk', 'gsi1sk'] as const;

const lastKey = { pk: 'USER#usr_a', sk: 'IDX#act_1' };

describe('round trip', () => {
  it('encodes and decodes a table key unchanged', () => {
    const cursor = encodeCursor(lastKey);
    expect(decodeCursor(cursor, TABLE_KEY)).toEqual(lastKey);
  });

  it('encodes and decodes a GSI1 key unchanged', () => {
    const key = { ...lastKey, gsi1pk: 'U#usr_a#S', gsi1sk: '2026-08-08T19:30#act_1' };
    expect(decodeCursor(encodeCursor(key), INDEX_KEY)).toEqual(key);
  });

  /**
   * Absent, not empty. `meta.nextCursor` is present only when there is another page, so a
   * client branches on presence rather than on emptiness.
   */
  it('encodes no cursor when there is no next page', () => {
    expect(encodeCursor(undefined)).toBeUndefined();
  });

  it('decodes an absent cursor as the first page', () => {
    expect(decodeCursor(undefined, TABLE_KEY)).toBeUndefined();
    expect(decodeCursor('', TABLE_KEY)).toBeUndefined();
  });

  it('binds a list-item cursor to its rank version', () => {
    const cursor = encodeFencedCursor(lastKey, 12);

    expect(decodeFencedCursor(cursor, TABLE_KEY)).toEqual({
      lastEvaluatedKey: lastKey,
      rankVersion: 12,
    });
  });

  it('omits a fenced cursor when there is no next page', () => {
    expect(encodeFencedCursor(undefined, 12)).toBeUndefined();
    expect(decodeFencedCursor(undefined, TABLE_KEY)).toBeUndefined();
  });

  /** Opaque by contract: base64url, so it survives a query string without escaping. */
  it('emits a URL-safe token with no padding', () => {
    const cursor = encodeCursor({ pk: 'USER#usr_a??', sk: 'IDX#>>>' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

/**
 * A cursor is attacker-controlled input handed almost directly to the database, so every
 * malformed shape is `validation_failed` and none of them reaches DynamoDB.
 */
describe('a tampered cursor is rejected, never passed through', () => {
  it.each([
    ['not base64 at all', '!!!not-base64!!!'],
    ['base64 of something that is not JSON', Buffer.from('hello').toString('base64url')],
    ['JSON that is not an object', Buffer.from('"a string"').toString('base64url')],
    ['an array', Buffer.from('["pk","sk"]').toString('base64url')],
    ['null', Buffer.from('null').toString('base64url')],
    [
      'a nested object where a key attribute belongs',
      Buffer.from(JSON.stringify({ pk: { S: 'x' }, sk: 'y' })).toString('base64url'),
    ],
    [
      'a number where a key attribute belongs',
      Buffer.from(JSON.stringify({ pk: 'x', sk: 42 })).toString('base64url'),
    ],
    [
      'a missing attribute',
      Buffer.from(JSON.stringify({ pk: 'USER#usr_a' })).toString('base64url'),
    ],
    ['something absurdly long', 'A'.repeat(3000)],
  ])('rejects %s', (_why, raw) => {
    expect(() => decodeCursor(raw, TABLE_KEY)).toThrow(AppError);
  });

  it('throws validation_failed, so it surfaces as a 400 and not a 500', () => {
    try {
      decodeCursor('!!!', TABLE_KEY);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('validation_failed');
    }
  });

  /**
   * The half that matters most: **extra** attributes are rejected, not ignored. A cursor
   * minted for a GSI1 query carries `gsi1pk`/`gsi1sk`, and replaying it against a table
   * query is exactly the confusion this check exists to prevent.
   */
  it('rejects a GSI1 cursor replayed against a table query', () => {
    const indexCursor = encodeCursor({
      pk: 'USER#usr_a',
      sk: 'IDX#act_1',
      gsi1pk: 'U#usr_a#S',
      gsi1sk: '2026-08-08T19:30#act_1',
    });

    expect(() => decodeCursor(indexCursor, TABLE_KEY)).toThrow(AppError);
  });

  it('rejects a table cursor replayed against a GSI1 query', () => {
    expect(() => decodeCursor(encodeCursor(lastKey), INDEX_KEY)).toThrow(AppError);
  });

  it.each([
    ['an ordinary cursor', encodeCursor(lastKey)],
    [
      'a negative rank version',
      Buffer.from(
        JSON.stringify({ lastEvaluatedKey: lastKey, rankVersion: -1 }),
      ).toString('base64url'),
    ],
    [
      'an unexpected outer attribute',
      Buffer.from(
        JSON.stringify({ lastEvaluatedKey: lastKey, rankVersion: 1, extra: true }),
      ).toString('base64url'),
    ],
    [
      'a malformed nested key',
      Buffer.from(
        JSON.stringify({ lastEvaluatedKey: { pk: lastKey.pk }, rankVersion: 1 }),
      ).toString('base64url'),
    ],
  ])('rejects fenced cursor with %s', (_why, raw) => {
    expect(() => decodeFencedCursor(raw, TABLE_KEY)).toThrow(AppError);
  });

  /**
   * The message says nothing about which check failed. A cursor is opaque, so there is
   * nothing useful to tell a client about the internals of a value they must not look
   * inside — and a message that distinguished "bad base64" from "wrong attributes" would
   * describe them.
   */
  it('says the same thing however it failed', () => {
    const messages = ['!!!', 'A'.repeat(3000), encodeCursor(lastKey)].map((raw) => {
      try {
        decodeCursor(raw, INDEX_KEY);
        return 'no throw';
      } catch (error) {
        return (error as AppError).message;
      }
    });

    expect(new Set(messages).size).toBe(1);
  });
});
