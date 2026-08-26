import { describe, expect, it } from 'vitest';
import { keyFor, newUpdateId, updateKeyRoundTrips } from './activityUpdateRepository.js';

/**
 * The id/key invariant the whole delete path rests on (P3-19 review).
 *
 * A feed row is addressed by `UPD#<createdAt>#<updateId>`, and a `DELETE` arrives with only
 * the id — so the id has to encode its own `createdAt`. When it does not, the failure is
 * silent and permanent: the entry commits, renders in the feed, and can never be deleted.
 */

const iso = (ms: number) => new Date(ms).toISOString();
const BASE = Date.parse('2026-08-26T18:00:00.000Z');

describe('newUpdateId', () => {
  it('encodes its own createdAt', () => {
    const createdAt = iso(BASE);
    expect(updateKeyRoundTrips(createdAt, newUpdateId(createdAt))).toBe(true);
  });

  /**
   * **The defect this test exists for.** A single shared `monotonicFactory` clamps a
   * *decreasing* seed to the last one it issued, so an id minted for an earlier timestamp
   * encoded a later one. Two requests capturing `now` and then pausing — for authorisation,
   * for a retry — commit out of order routinely, so this was not a theoretical ordering.
   */
  it('encodes it even when timestamps go backwards', () => {
    const later = iso(BASE + 5_000);
    const earlier = iso(BASE);

    newUpdateId(later);
    const earlierId = newUpdateId(earlier);

    expect(updateKeyRoundTrips(earlier, earlierId)).toBe(true);
    expect(keyFor('act_x', earlierId)?.sk).toBe(`UPD#${earlier}#${earlierId}`);
  });

  it('round-trips across an interleaved sequence', () => {
    for (const offset of [0, 5_000, 1_000, 9_000, 1_000, 0]) {
      const createdAt = iso(BASE + offset);
      expect(updateKeyRoundTrips(createdAt, newUpdateId(createdAt))).toBe(true);
    }
  });

  /** Same millisecond: ordered by the id, which is the sort key's only tie-break. */
  it('increments within one millisecond rather than ordering on random bits', () => {
    const createdAt = iso(BASE);
    const ids = [newUpdateId(createdAt), newUpdateId(createdAt), newUpdateId(createdAt)];

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('keyFor', () => {
  it('answers undefined for an id that cannot name a row', () => {
    expect(keyFor('act_x', 'nonsense')).toBeUndefined();
    expect(keyFor('act_x', 'upd_not-a-ulid')).toBeUndefined();
  });
});

/**
 * Consistency is a property of the **command**, not of the answer DynamoDB Local happens to
 * give: a local single-node database returns fresh data whether or not you ask for it, so an
 * integration test cannot tell a strongly consistent read from a lucky one. Asserted here
 * instead, where the flag is visible.
 */
describe('the feed read asks for its own writes', () => {
  it('sets ConsistentRead on the page Query', async () => {
    const { DynamoDBDocumentClient, QueryCommand } = await import(
      '@aws-sdk/lib-dynamodb'
    );
    const { mockClient } = await import('aws-sdk-client-mock');
    const ddbMock = mockClient(DynamoDBDocumentClient);
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const { listActivityUpdates } = await import('./activityUpdateRepository.js');
    await listActivityUpdates('act_01J8XKQ2M4N5P6R7S8T9V0W1X2');

    const input = ddbMock.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.ConsistentRead).toBe(true);
    expect(input?.ScanIndexForward).toBe(false);
    expect(input?.Limit).toBe(50);
    ddbMock.restore();
  });
});
