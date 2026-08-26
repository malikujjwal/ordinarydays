import { describe, expect, it } from 'vitest';
import { MAX_UPDATE_BODY_LEN } from '../constants.js';
import {
  activityUpdate,
  postActivityUpdateInput,
  postActivityUpdateResult,
} from './activityUpdate.js';

const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const UPD = 'upd_01J8XKQ2M4N5P6R7S8T9V0W1X3';

const entry = (overrides: Record<string, unknown> = {}) => ({
  updateId: UPD,
  activityId: ACT,
  kind: 'user',
  authorUserId: 'usr_local_dev',
  body: 'Moved the booking to 8.',
  createdAt: '2026-08-26T18:00:00.000Z',
  schemaVersion: 1,
  ...overrides,
});

describe('activityUpdate', () => {
  it('accepts a user entry and a system entry with no author', () => {
    expect(activityUpdate.safeParse(entry()).success).toBe(true);
    const system = entry({ kind: 'system' });
    delete (system as Record<string, unknown>).authorUserId;
    expect(activityUpdate.safeParse(system).success).toBe(true);
  });

  it.each([
    ['an unknown kind', { kind: 'rsvp' }],
    ['an empty body', { body: '' }],
    ['a body past the cap', { body: 'x'.repeat(MAX_UPDATE_BODY_LEN + 1) }],
    ['a non-timestamp createdAt', { createdAt: '2026-08-26' }],
    ['a mis-prefixed id', { updateId: ACT }],
  ])('rejects %s', (_why, overrides) => {
    expect(activityUpdate.safeParse(entry(overrides)).success).toBe(false);
  });

  /**
   * The author rule is a shape, not a comment (P3-19 review). Both of these parsed before it
   * became a discriminated union: a system row with an author would have rendered a name on a
   * record nobody wrote, and a user row without one is an entry no delete could authorise.
   */
  it('refuses a system entry that carries an author', () => {
    expect(
      activityUpdate.safeParse(entry({ kind: 'system', authorUserId: 'usr_local_dev' }))
        .success,
    ).toBe(false);
  });

  it('refuses a user entry with no author', () => {
    const orphan = entry();
    delete (orphan as Record<string, unknown>).authorUserId;
    expect(activityUpdate.safeParse(orphan).success).toBe(false);
  });

  it('accepts a body exactly at the cap', () => {
    expect(
      activityUpdate.safeParse(entry({ body: 'x'.repeat(MAX_UPDATE_BODY_LEN) })).success,
    ).toBe(true);
  });
});

/**
 * The strictness is the point: each of these is a field the server authors, and a permissive
 * object would drop them silently instead of telling the caller they are not theirs to send.
 */
describe('postActivityUpdateInput', () => {
  it('accepts a lone body', () => {
    expect(postActivityUpdateInput.safeParse({ body: 'Booked it.' }).success).toBe(true);
  });

  it.each([
    ['kind', { kind: 'system' }],
    ['authorUserId', { authorUserId: 'usr_someone_else' }],
    ['createdAt', { createdAt: '2020-01-01T00:00:00.000Z' }],
    ['updateId', { updateId: UPD }],
    ['activityId', { activityId: ACT }],
  ])('refuses a client-supplied %s', (_field, extra) => {
    expect(postActivityUpdateInput.safeParse({ body: 'Hi', ...extra }).success).toBe(
      false,
    );
  });

  it.each([
    ['an empty body', ''],
    ['a body past the cap', 'x'.repeat(MAX_UPDATE_BODY_LEN + 1)],
  ])('refuses %s', (_why, body) => {
    expect(postActivityUpdateInput.safeParse({ body }).success).toBe(false);
  });
});

describe('postActivityUpdateResult', () => {
  /** The timestamp is the client's ordering signal while GSI1 converges; it is required. */
  it('requires lastActivityAt beside the entry', () => {
    expect(
      postActivityUpdateResult.safeParse({
        update: entry(),
        lastActivityAt: '2026-08-26T18:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(postActivityUpdateResult.safeParse({ update: entry() }).success).toBe(false);
  });
});
