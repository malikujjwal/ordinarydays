import type { Activity } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { CONFLICT_MESSAGE, droppedMessage, resolveConflict } from './conflict';

/**
 * The 409 merge (`activities.md` §6.1).
 *
 * Worth its own file because producing a real conflict by hand needs two clients editing the
 * same activity inside the same second, so this is the only place the rule is ever exercised.
 */

const base: Activity = {
  activityId: 'act_01J0000000000000000000000A',
  ownerId: 'usr_01J0000000000000000000000B',
  objectKind: 'plan',
  type: 'event',
  status: 'saved',
  title: 'Zahav',
  notes: 'book early',
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  details: { kind: 'event' },
  icsSequence: 0,
  createdAt: '2026-08-08T10:00:00.000Z',
  updatedAt: '2026-08-08T10:00:00.000Z',
  schemaVersion: 1,
};

/**
 * `Record<string, unknown>` rather than `Partial<Activity>`: under
 * `exactOptionalPropertyTypes`, `{ notes: undefined }` — "they cleared the notes", a case
 * this file needs — is not assignable to the latter.
 */
const fresh = (patch: Record<string, unknown>): Activity =>
  ({ ...base, updatedAt: '2026-08-08T11:00:00.000Z', ...patch }) as Activity;

describe('resolveConflict', () => {
  it('re-applies an edit to a field nobody else touched', () => {
    // They changed the notes; you changed the title. Nothing overlaps.
    const result = resolveConflict(base, fresh({ notes: 'they wrote this' }), {
      title: 'Zahav, 7pm',
    });

    expect(result.reapply).toEqual({ title: 'Zahav, 7pm' });
    expect(result.dropped).toEqual([]);
    expect(result.ifMatch).toBe('2026-08-08T11:00:00.000Z');
  });

  it('drops an edit to a field they changed, and names it by its label', () => {
    const result = resolveConflict(base, fresh({ title: 'Their title' }), {
      title: 'My title',
    });

    expect(result.reapply).toBeUndefined();
    // The user-facing label, never the stored path (`interaction-contract.md` §1a.1 rule 4).
    expect(result.dropped).toEqual(['Title']);
  });

  it('re-applies the safe half of a two-field edit and drops the other', () => {
    const result = resolveConflict(base, fresh({ title: 'Their title' }), {
      title: 'My title',
      notes: 'my notes',
    });

    expect(result.reapply).toEqual({ notes: 'my notes' });
    expect(result.dropped).toEqual(['Title']);
  });

  /**
   * The case a two-way comparison gets wrong. If the merge compared the pending edit against
   * the fresh value alone it would see a difference and drop the edit — even though nobody
   * else had touched that field and the user's change is perfectly safe to apply.
   */
  it('does not drop an edit merely because it differs from the server value', () => {
    // They changed only `notes`. `title` is untouched, so the local title edit must survive.
    const result = resolveConflict(base, fresh({ notes: 'theirs' }), {
      title: 'Something completely different',
    });

    expect(result.dropped).toEqual([]);
    expect(result.reapply).toEqual({ title: 'Something completely different' });
  });

  /**
   * Both people typed the same thing. There is nothing to drop, nothing to re-send, and
   * nothing worth interrupting the user about.
   */
  it('is silent when they made the same change you did', () => {
    const result = resolveConflict(base, fresh({ title: 'Agreed title' }), {
      title: 'Agreed title',
    });

    expect(result.reapply).toBeUndefined();
    expect(result.dropped).toEqual([]);
  });

  it('ignores fields the pending edit does not mention', () => {
    const result = resolveConflict(base, fresh({ title: 'Theirs' }), { notes: 'mine' });

    expect(result.reapply).toEqual({ notes: 'mine' });
    expect(result.dropped).toEqual([]);
  });

  /** An absent field and an empty one are the same to the user; `undefined` and `null` too. */
  it('treats absent and undefined as the same value', () => {
    const withoutNotes = { ...base, notes: undefined } as unknown as Activity;
    const result = resolveConflict(withoutNotes, fresh({ notes: undefined }), {
      notes: 'mine',
    });

    expect(result.dropped).toEqual([]);
    expect(result.reapply).toEqual({ notes: 'mine' });
  });

  it('always advances If-Match to the version it just fetched', () => {
    const result = resolveConflict(base, fresh({ title: 'Theirs' }), { title: 'Mine' });
    expect(result.ifMatch).toBe('2026-08-08T11:00:00.000Z');
    expect(result.ifMatch).not.toBe(base.updatedAt);
  });
});

describe('the messages', () => {
  it('uses §6.1 copy verbatim', () => {
    expect(CONFLICT_MESSAGE).toBe('This plan changed. Review the update.');
  });

  it('says nothing when nothing was dropped', () => {
    expect(droppedMessage([])).toBeUndefined();
  });

  it('names one dropped field', () => {
    expect(droppedMessage(['Title'])).toBe('Your change to Title was not applied.');
  });

  it('names two dropped fields with and, not a comma', () => {
    expect(droppedMessage(['Title', 'Notes'])).toBe(
      'Your change to Title and Notes was not applied.',
    );
  });
});
