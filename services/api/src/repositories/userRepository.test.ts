import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { getProfile, newUserId, patchProfile } from './userRepository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const sentUpdate = (n = 0) => ddbMock.commandCalls(UpdateCommand)[n]?.args[0].input;

const updateCount = () => ddbMock.commandCalls(UpdateCommand).length;

/** The failure DynamoDB raises when a `ConditionExpression` does not hold. */
const conditionFailed = () => {
  const error = new Error('The conditional request failed');
  error.name = 'ConditionalCheckFailedException';
  return error;
};

const TRADER_JOES = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const CORNER_SHOP = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X3';

const sentGet = () => ddbMock.commandCalls(GetCommand)[0]?.args[0].input;

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(UpdateCommand).resolves({ Attributes: { userId: 'usr_x' } });
  ddbMock.on(GetCommand).resolves({ Item: { userId: 'usr_a' } });
});

describe('getProfile', () => {
  /**
   * Rendering a settings screen a fraction of a second behind costs nothing, and this read
   * happens on every `GET /v1/me`.
   */
  it('reads eventually consistently by default', async () => {
    await getProfile('usr_a');

    expect(sentGet()?.ConsistentRead).toBeUndefined();
  });

  /**
   * Slot resolution asks for strong. It reads the profile immediately after the `PATCH
   * /v1/me` that stored the user's answer to "which list should these go to?", and a stale
   * map there sends the items to the destination they just replaced (P3-12).
   */
  it('reads strongly when the caller asks', async () => {
    await getProfile('usr_a', { consistentRead: true });

    expect(sentGet()?.ConsistentRead).toBe(true);
  });
});

describe('newUserId', () => {
  /**
   * Unused in Phase 1 and tested anyway: Phase 4's post-confirmation trigger is the first
   * caller, and if it does not find a generator it will write a second one that eventually
   * disagrees with the shared validator.
   */
  it('is usr_ plus a 26-character ULID', () => {
    expect(newUserId()).toMatch(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('passes the shared userId schema', async () => {
    const { userId } = await import('@od/shared/schemas');
    expect(userId.safeParse(newUserId()).success).toBe(true);
  });

  it('is unique across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, newUserId));
    expect(ids.size).toBe(50);
  });

  /** ULIDs are time-sortable, which is the reason for choosing them (`data-model.md` §8). */
  it('sorts by creation time as a plain string', () => {
    const first = newUserId();
    const second = newUserId();
    expect([second, first].sort()).toEqual([first, second]);
  });
});

describe('patchProfile', () => {
  it('writes to USER#<id> / PROFILE', async () => {
    await patchProfile('usr_a', { displayName: 'Ada' }, '2026-08-09T12:00:00.000Z');

    expect(sentUpdate()?.Key).toEqual({ pk: 'USER#usr_a', sk: 'PROFILE' });
  });

  it('sets the patched fields and bumps updatedAt', async () => {
    await patchProfile(
      'usr_a',
      { displayName: 'Ada', weekStartsOn: 1 },
      '2026-08-09T12:00:00.000Z',
    );

    const input = sentUpdate();
    expect(input?.UpdateExpression).toContain('#displayName = :displayName');
    expect(input?.UpdateExpression).toContain('#weekStartsOn = :weekStartsOn');
    expect(input?.ExpressionAttributeValues?.[':updatedAt']).toBe(
      '2026-08-09T12:00:00.000Z',
    );
  });

  /**
   * `0` is a real *At the time* reminder and `null` is Off (ADR-047). A `REMOVE` clears the
   * attribute; writing a literal null would store a third state that reads back as neither.
   */
  it('clears defaultReminderOffset with REMOVE when it is null', async () => {
    await patchProfile(
      'usr_a',
      { defaultReminderOffset: null },
      '2026-08-09T12:00:00.000Z',
    );

    const input = sentUpdate();
    expect(input?.UpdateExpression).toContain('REMOVE #defaultReminderOffset');
    expect(input?.ExpressionAttributeValues).not.toHaveProperty(':defaultReminderOffset');
  });

  it('stores a zero offset as a value, not as a clear', async () => {
    await patchProfile('usr_a', { defaultReminderOffset: 0 }, '2026-08-09T12:00:00.000Z');

    const input = sentUpdate();
    expect(input?.UpdateExpression).toContain('#defaultReminderOffset = ');
    expect(input?.UpdateExpression).not.toContain('REMOVE');
    expect(input?.ExpressionAttributeValues?.[':defaultReminderOffset']).toBe(0);
  });

  it('combines a set and a clear in one expression', async () => {
    await patchProfile(
      'usr_a',
      { displayName: 'Ada', defaultReminderOffset: null },
      '2026-08-09T12:00:00.000Z',
    );

    const expression = String(sentUpdate()?.UpdateExpression);
    expect(expression).toMatch(/^SET .*REMOVE #defaultReminderOffset$/);
  });

  /**
   * Without this, a patch against a missing profile would conjure a tenant record carrying
   * three fields, no `createdAt` and no `schemaVersion`, silently, for every later reader to
   * cope with.
   */
  it('requires the profile to already exist', async () => {
    await patchProfile('usr_a', { displayName: 'Ada' }, '2026-08-09T12:00:00.000Z');

    expect(sentUpdate()?.ConditionExpression).toBe('attribute_exists(pk)');
  });

  it('returns the stored row the update produced', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { userId: 'usr_a', displayName: 'Ada', schemaVersion: 1 },
    });

    const updated = await patchProfile(
      'usr_a',
      { displayName: 'Ada' },
      '2026-08-09T12:00:00.000Z',
    );

    expect(updated?.displayName).toBe('Ada');
  });
});

/**
 * The nested per-slot patch (`api-contract.md` §2.1, `phase-03` §P3-12).
 *
 * The property under test throughout is that **an omitted slot is never named in the
 * expression**. A whole-map assignment would carry the caller's stale siblings and quietly
 * undo a choice another device made in between, and it is the one thing this path must never
 * emit against a profile that already has a map.
 */
describe('patchProfile — defaultLists is a nested patch, not a replacement map', () => {
  it('sets one slot through its own document path', async () => {
    await patchProfile(
      'usr_a',
      { defaultLists: { groceries: TRADER_JOES } },
      '2026-08-24T12:00:00.000Z',
    );

    const input = sentUpdate();
    expect(input?.UpdateExpression).toContain('#defaultLists.#slot_groceries = ');
    expect(input?.ExpressionAttributeNames?.['#slot_groceries']).toBe('groceries');
    expect(input?.ExpressionAttributeValues?.[':slot_groceries']).toBe(TRADER_JOES);
  });

  it('clears one slot with a nested REMOVE, not a stored null', async () => {
    await patchProfile(
      'usr_a',
      { defaultLists: { watch: null } },
      '2026-08-24T12:00:00.000Z',
    );

    const input = sentUpdate();
    expect(input?.UpdateExpression).toContain('REMOVE #defaultLists.#slot_watch');
    expect(input?.ExpressionAttributeValues).not.toHaveProperty(':slot_watch');
  });

  it('never assigns the whole map when one already exists', async () => {
    await patchProfile(
      'usr_a',
      { defaultLists: { groceries: TRADER_JOES, watch: null } },
      '2026-08-24T12:00:00.000Z',
    );

    const expression = String(sentUpdate()?.UpdateExpression);
    expect(expression).not.toMatch(/#defaultLists\s*=/);
    expect(expression).toContain('#defaultLists.#slot_groceries = ');
    expect(expression).toContain('REMOVE #defaultLists.#slot_watch');
  });

  /** The omitted slot must not appear anywhere — not as a path, a name, or a value. */
  it('names no slot the patch omitted', async () => {
    await patchProfile(
      'usr_a',
      { defaultLists: { groceries: TRADER_JOES } },
      '2026-08-24T12:00:00.000Z',
    );

    const input = sentUpdate();
    expect(String(input?.UpdateExpression)).not.toContain('meals');
    expect(input?.ExpressionAttributeNames).not.toHaveProperty('#slot_meals');
    expect(input?.ExpressionAttributeNames).not.toHaveProperty('#slot_watch');
  });

  it('applies slots and ordinary fields in one update', async () => {
    await patchProfile(
      'usr_a',
      { displayName: 'Ada', defaultLists: { groceries: TRADER_JOES } },
      '2026-08-24T12:00:00.000Z',
    );

    const expression = String(sentUpdate()?.UpdateExpression);
    expect(expression).toContain('#displayName = :displayName');
    expect(expression).toContain('#defaultLists.#slot_groceries = ');
    expect(updateCount()).toBe(1);
  });

  /**
   * A document path cannot be written into an attribute that is not there, so the parent map
   * is required up front. Failing that condition is what routes a legacy profile to the
   * create below, rather than a second behaviour that has to agree with this one.
   */
  it('requires both the profile and the parent map', async () => {
    await patchProfile(
      'usr_a',
      { defaultLists: { groceries: TRADER_JOES } },
      '2026-08-24T12:00:00.000Z',
    );

    expect(sentUpdate()?.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_exists(#defaultLists)',
    );
  });

  it('requires only the profile when no slot is in play', async () => {
    await patchProfile('usr_a', { displayName: 'Ada' }, '2026-08-24T12:00:00.000Z');

    expect(sentUpdate()?.ConditionExpression).toBe('attribute_exists(pk)');
    expect(sentUpdate()?.ExpressionAttributeNames).not.toHaveProperty('#defaultLists');
  });
});

describe('patchProfile — a legacy profile with no slot map', () => {
  /** First attempt fails the parent-map condition; the second creates the map. */
  const noMapThenCreated = () => {
    ddbMock
      .on(UpdateCommand)
      .rejectsOnce(conditionFailed())
      .resolves({ Attributes: { userId: 'usr_a' } });
  };

  it('creates the map holding exactly the slots this patch sets', async () => {
    noMapThenCreated();

    await patchProfile(
      'usr_a',
      { defaultLists: { groceries: TRADER_JOES } },
      '2026-08-24T12:00:00.000Z',
    );

    const create = sentUpdate(1);
    expect(create?.UpdateExpression).toContain('#defaultLists = :defaultLists');
    expect(create?.ExpressionAttributeValues?.[':defaultLists']).toEqual({
      groceries: TRADER_JOES,
    });
  });

  /**
   * The one place a whole-map `SET` is correct, and this condition is why: there are no
   * sibling slots to lose, because there is no map.
   */
  it('creates conditionally, so it can only ever be a create', async () => {
    noMapThenCreated();

    await patchProfile(
      'usr_a',
      { defaultLists: { groceries: TRADER_JOES } },
      '2026-08-24T12:00:00.000Z',
    );

    expect(sentUpdate(1)?.ConditionExpression).toBe(
      'attribute_exists(pk) AND attribute_not_exists(#defaultLists)',
    );
  });

  /** Clearing a slot that was never set creates nothing; the other fields still land. */
  it('creates no map for a patch that only clears', async () => {
    noMapThenCreated();

    await patchProfile(
      'usr_a',
      { displayName: 'Ada', defaultLists: { watch: null } },
      '2026-08-24T12:00:00.000Z',
    );

    const create = sentUpdate(1);
    expect(create?.UpdateExpression).toContain('#displayName = :displayName');
    expect(create?.UpdateExpression).not.toContain('#defaultLists = ');
    expect(create?.ExpressionAttributeValues).not.toHaveProperty(':defaultLists');
  });

  /**
   * Another device created the map in between. The nested operation is retried, so this
   * patch's slot lands and the concurrent creator's other slots survive — which is the whole
   * reason the retry is a nested write rather than a second create.
   */
  it('retries the nested write after losing the create race', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejectsOnce(conditionFailed())
      .rejectsOnce(conditionFailed())
      .resolves({
        Attributes: { userId: 'usr_a', defaultLists: { watch: CORNER_SHOP } },
      });

    const updated = await patchProfile(
      'usr_a',
      { defaultLists: { groceries: TRADER_JOES } },
      '2026-08-24T12:00:00.000Z',
    );

    expect(updateCount()).toBe(3);
    expect(sentUpdate(2)?.UpdateExpression).toContain('#defaultLists.#slot_groceries = ');
    expect(sentUpdate(2)?.UpdateExpression).not.toMatch(/#defaultLists\s*=\s*:/);
    expect(updated?.defaultLists).toEqual({ watch: CORNER_SHOP });
  });

  /**
   * All three conditions can only have failed on `attribute_exists(pk)`, which is a profile
   * that is not there — the `404` `userService` maps this to.
   */
  it('gives up after three attempts, so a missing profile still surfaces', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());

    await expect(
      patchProfile(
        'usr_a',
        { defaultLists: { groceries: TRADER_JOES } },
        '2026-08-24T12:00:00.000Z',
      ),
    ).rejects.toThrow('The conditional request failed');
    expect(updateCount()).toBe(3);
  });

  it('does not retry a patch that names no slot', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());

    await expect(
      patchProfile('usr_a', { displayName: 'Ada' }, '2026-08-24T12:00:00.000Z'),
    ).rejects.toThrow('The conditional request failed');
    expect(updateCount()).toBe(1);
  });

  /** A real storage failure is not a condition failure and must not be retried away. */
  it('propagates any other failure without a second attempt', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('ProvisionedThroughputExceeded'));

    await expect(
      patchProfile(
        'usr_a',
        { defaultLists: { groceries: TRADER_JOES } },
        '2026-08-24T12:00:00.000Z',
      ),
    ).rejects.toThrow('ProvisionedThroughputExceeded');
    expect(updateCount()).toBe(1);
  });
});
