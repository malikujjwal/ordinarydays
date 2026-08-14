import type { Activity } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import { deleteConfirmation, kindChangeConfirmation, kindLabel } from './confirmations';

/**
 * What the two destructive dialogs say (P1-27).
 *
 * `interaction-contract.md` §1a.1 calls a dialog reading `Are you sure?` or
 * `This can't be undone.` alone **a defect, not a style choice** — so these assert the copy
 * literally. A test that only checked "some confirmation appeared" would pass for exactly the
 * dialog that section forbids.
 */
const plan = (patch: Record<string, unknown> = {}): Activity =>
  ({
    activityId: 'act_01J0000000000000000000000A',
    ownerId: 'usr_01J0000000000000000000000B',
    objectKind: 'plan',
    type: 'watch',
    status: 'scheduled',
    title: 'Severance',
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'watch', mediaTitle: 'Severance', season: 2, episode: 4 },
    icsSequence: 0,
    createdAt: '2026-08-08T10:00:00.000Z',
    lastActivityAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
    schemaVersion: 1,
    ...patch,
  }) as Activity;

const task = (patch: Record<string, unknown> = {}): Activity =>
  plan({
    objectKind: 'task',
    type: 'task',
    title: 'Call the dentist',
    details: { kind: 'task' },
    ...patch,
  });

describe('deleteConfirmation', () => {
  /** §6.4: "A bare `Delete "<title>"?` with no `This removes:` line is a §1a.1 defect." */
  it('names the object and what goes with it', () => {
    const confirmation = deleteConfirmation(plan({ notes: 'Bring cash' }), 2);

    expect(confirmation.heading).toBe('Delete "Severance"?');
    expect(confirmation.removesLead).toBe('This removes:');
    expect(confirmation.removes).toEqual(['the plan, its notes and 2 reminders.']);
    expect(confirmation.confirmLabel).toBe('Delete plan');
  });

  /** Deletions always confirm, even with nothing else to name (§1a.1 rule 3). */
  it('still names the object when there is nothing else to lose', () => {
    expect(deleteConfirmation(plan(), 0).removes).toEqual(['the plan.']);
  });

  it('counts one reminder as one', () => {
    expect(deleteConfirmation(plan(), 1).removes).toEqual(['the plan and 1 reminder.']);
  });

  it('repeats the right verb for a task', () => {
    const confirmation = deleteConfirmation(task(), 0);
    expect(confirmation.heading).toBe('Delete "Call the dentist"?');
    expect(confirmation.confirmLabel).toBe('Delete task');
  });

  /**
   * Prep children survive the cascade with `parentActivityId` cleared (P1-14), so the dialog
   * says so — a user deleting a trip is entitled to know its prep tasks stay on their Today.
   */
  it('names surviving prep tasks on the Keeps line', () => {
    expect(deleteConfirmation(plan({ childCount: 2 }), 0).keeps).toBe(
      'its 2 prep tasks, which become ordinary tasks.',
    );
    // The verb agrees with the count. "its 1 prep task, which become" is copy nobody wrote
    // on purpose, and a dialog that reads as a bug is one users trust less.
    expect(deleteConfirmation(plan({ childCount: 1 }), 0).keeps).toBe(
      'its 1 prep task, which becomes an ordinary task.',
    );
  });

  it('omits the Keeps line when nothing survives', () => {
    expect(deleteConfirmation(plan(), 0).keeps).toBeUndefined();
  });

  it('names the entire recurring series and its real stored completion count', () => {
    const confirmation = deleteConfirmation(
      task({
        schedule: { date: '2026-08-01', timezone: 'America/New_York' },
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
        },
      }),
      0,
      40,
    );

    expect(confirmation.removes).toEqual(['the series and its 40 past completions.']);
    expect(confirmation.confirmLabel).toBe('Delete series');
  });
});

describe('kindChangeConfirmation', () => {
  /** The example in `activities.md` §6.3 rule 6, reproduced. */
  it('lists the dropped fields with their values, and what is kept', () => {
    const confirmation = kindChangeConfirmation(
      plan({
        schedule: { date: '2026-08-14', time: '19:00', timezone: 'America/New_York' },
        details: {
          kind: 'watch',
          mediaTitle: 'Severance',
          season: 2,
          episode: 4,
          service: 'Apple TV',
        },
      }),
      { objectKind: 'plan', type: 'event' },
      1,
    );

    expect(confirmation?.heading).toBe('Change Watch → Event?');
    expect(confirmation?.removesLead).toBe('This will remove:');
    expect(confirmation?.removes).toContain('Season and episode (S2 E4)');
    expect(confirmation?.removes).toContain('Streaming service (Apple TV)');
    expect(confirmation?.keeps).toBe('title, date, time and reminders.');
    expect(confirmation?.confirmLabel).toBe('Change to Event');
  });

  /**
   * §1a.1 rule 3: a conditional confirmation that can appear with nothing to name is a bug.
   * Task → Plan carries every common field, so it is additive and shows no dialog at all.
   */
  it('is absent for an additive change', () => {
    expect(
      kindChangeConfirmation(task(), { objectKind: 'plan', type: 'custom' }, 0),
    ).toBeUndefined();
  });

  /** A kind changed to itself is a no-op (P1-17), so it must not offer to remove anything. */
  it('is absent for a change to the same kind', () => {
    expect(
      kindChangeConfirmation(plan(), { objectKind: 'plan', type: 'watch' }, 0),
    ).toBeUndefined();
  });

  /** The Keeps line names what this activity actually has, not the doc example verbatim. */
  it('does not promise a date an undated plan has not got', () => {
    const confirmation = kindChangeConfirmation(
      plan(),
      { objectKind: 'task', type: 'task' },
      0,
    );

    expect(confirmation?.keeps).toBe('title.');
    expect(confirmation?.confirmLabel).toBe('Change to Task');
  });
});

describe('kindLabel', () => {
  it('uses the labels the choosers show, never the stored type', () => {
    expect(kindLabel({ objectKind: 'plan', type: 'custom' })).toBe('General');
    expect(kindLabel({ objectKind: 'plan', type: 'watch' })).toBe('Watch');
    expect(kindLabel({ objectKind: 'task', type: 'task' })).toBe('Task');
  });
});
