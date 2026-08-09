import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { newUserId, patchProfile } from './userRepository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

const sentUpdate = () => ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input;

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(UpdateCommand).resolves({ Attributes: { userId: 'usr_x' } });
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
