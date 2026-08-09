import type { User } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { toUser } from './toUser.js';

/**
 * The projection that keeps storage out of responses (`agent-playbook.md` §6.11,
 * `data-model.md` §8: "Never expose raw DynamoDB `pk`/`sk` over the API").
 */

/** A stored row as it comes back from DynamoDB — domain fields plus storage attributes. */
const stored = {
  pk: 'USER#usr_local_dev',
  sk: 'PROFILE',
  entity: 'User',
  userId: 'usr_local_dev',
  displayName: 'Dev',
  timezone: 'America/New_York',
  currency: 'USD',
  weekStartsOn: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  schemaVersion: 1,
} as unknown as User;

describe('toUser', () => {
  it('carries the profile fields a client needs', () => {
    expect(toUser(stored)).toMatchObject({
      userId: 'usr_local_dev',
      displayName: 'Dev',
      timezone: 'America/New_York',
      currency: 'USD',
      weekStartsOn: 0,
    });
  });

  /** The assertion `agent-playbook.md` §6.11 asks every endpoint test to carry. */
  it.each(['pk', 'sk', 'entity'])('does not leak %s', (attribute) => {
    expect(toUser(stored)).not.toHaveProperty(attribute);
  });

  /**
   * A field added to the stored shape must not appear in a response until somebody adds a
   * line to the projection. This proves the default points that way — a spread would let it
   * straight through.
   */
  it('drops a storage attribute it has never heard of', () => {
    const withFutureField = {
      ...stored,
      gsi1pk: 'U#usr_local_dev#S',
      someLaterInternalField: 'secret',
    } as unknown as User;

    expect(toUser(withFutureField)).not.toHaveProperty('gsi1pk');
    expect(toUser(withFutureField)).not.toHaveProperty('someLaterInternalField');
  });

  /** Phase 4's internal join key to the user pool. Nothing on the client has a use for it. */
  it('never projects cognitoSub', () => {
    const withSub = { ...stored, cognitoSub: 'abc-123' } as User;
    expect(toUser(withSub)).not.toHaveProperty('cognitoSub');
  });

  it('omits optional fields rather than sending them as null', () => {
    const result = toUser(stored);
    expect(result).not.toHaveProperty('defaultReminderOffset');
    expect(result).not.toHaveProperty('quietHours');
    expect(result).not.toHaveProperty('email');
  });

  /**
   * `0` is a real *At the time* reminder and must survive the projection. An `if (value)`
   * guard would drop it and turn it into Off (ADR-047).
   */
  it('projects a zero reminder offset, which is At the time and not Off', () => {
    const withZero = { ...stored, defaultReminderOffset: 0 } as User;
    expect(toUser(withZero).defaultReminderOffset).toBe(0);
  });

  it('projects an explicit null offset, which is Off', () => {
    const withNull = { ...stored, defaultReminderOffset: null } as User;
    expect(toUser(withNull).defaultReminderOffset).toBeNull();
  });

  /** The response must satisfy the shared schema both sides are written against. */
  it('produces something the shared user schema accepts', async () => {
    const { user } = await import('@od/shared/schemas');
    expect(user.safeParse(toUser(stored)).success).toBe(true);
  });
});
