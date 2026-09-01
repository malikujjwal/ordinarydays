import type { Activity } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  planToTaskBlockedMessage,
  planToTaskBlockers,
  sectionsFor,
  subtitleFor,
} from './sections';

const activity = (patch: Partial<Activity>): Activity =>
  ({
    activityId: 'act_01J0000000000000000000000A',
    ownerId: 'usr_01J0000000000000000000000B',
    objectKind: 'plan',
    type: 'event',
    status: 'saved',
    title: 'Zahav',
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'event' },
    icsSequence: 0,
    createdAt: '2026-08-08T10:00:00.000Z',
    lastActivityAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
    schemaVersion: 1,
    ...patch,
  }) as Activity;

const task = () =>
  activity({ objectKind: 'task', type: 'task', details: { kind: 'task' } });

describe('a Task renders no placeholder for what it lacks', () => {
  /**
   * `today-and-tasks.md` §5.6 is explicit about this, and it is the assertion that stops
   * Task detail drifting into "Plan detail with things greyed out". Tasks are solo; showing
   * People disabled on one would teach the user a Task is a lesser Plan.
   */
  it('shows only when/where, notes and Related plan', () => {
    expect(sectionsFor(task()).map((s) => s.key)).toEqual([
      'whenWhere',
      'notes',
      'relatedPlan',
    ]);
  });

  it('adds the real reminder disclosure only when the Task has a date', () => {
    expect(sectionsFor(task()).map((s) => s.key)).not.toContain('reminders');
    expect(
      sectionsFor(
        activity({
          objectKind: 'task',
          type: 'task',
          details: { kind: 'task' },
          schedule: { date: '2026-08-12', timezone: 'America/New_York' },
        }),
      ).map((s) => s.key),
    ).toContain('reminders');
  });

  it('has no coming-soon section at all', () => {
    expect(sectionsFor(task()).every((s) => !('state' in s))).toBe(true);
  });

  it.each(['people', 'prep', 'lists', 'attachments', 'expenses', 'updates'])(
    'never renders %s',
    (key) => {
      expect(sectionsFor(task()).map((s) => s.key)).not.toContain(key);
    },
  );
});

describe('a Plan renders settings always and sections only once they hold content', () => {
  /** The 2026-08-25 amendment: a bare plan has no empty section headings, only settings. */
  it('renders settings and the two discovery rows on a bare plan', () => {
    // Attachments keeps the §2.2 pre-build discovery row while its P3-41 flow is unbuilt:
    // with no chip to offer, an empty plan must still signal it can hold photos.
    expect(sectionsFor(activity({})).map((s) => s.key)).toEqual([
      'whenWhere',
      'notes',
      'people',
      'attachments-coming-later',
    ]);
  });

  it('adds each content section exactly when its collection is populated', () => {
    const populated = sectionsFor(activity({}), {
      childCount: 2,
      sourceListCount: 1,
      attachmentCount: 4,
      updateCount: 1,
    }).map((s) => s.key);
    expect(populated).toEqual([
      'whenWhere',
      'notes',
      'people',
      'prep',
      'lists',
      'attachments',
      'updates',
    ]);
  });

  /**
   * Founder clarification 2026-08-13, explicitly retained by the 2026-08-25 amendment:
   * `People` teaches the Plan's shape without a disabled Add or a working chevron. It is
   * the one unbuilt capability left with a `Coming later` row.
   */
  it('marks People and empty Attachments as coming later, and nothing else', () => {
    const sections = sectionsFor(activity({}));
    expect(sections).toContainEqual(
      expect.objectContaining({ key: 'people', state: 'coming-later' }),
    );
    expect(sections).toContainEqual(
      expect.objectContaining({ key: 'attachments-coming-later', state: 'coming-later' }),
    );
    expect(sections.filter((s) => s.state === 'coming-later')).toHaveLength(2);
  });

  it('replaces the Attachments discovery row with the real section once content exists', () => {
    const populated = sectionsFor(activity({}), {
      childCount: 0,
      sourceListCount: 0,
      attachmentCount: 1,
      updateCount: 0,
    }).map((s) => s.key);
    expect(populated).toContain('attachments');
    expect(populated).not.toContain('attachments-coming-later');
  });

  it('previews Ingredients only on a Meal plan', () => {
    expect(
      sectionsFor(activity({ type: 'meal', details: { kind: 'meal', ingredients: [] } })),
    ).toContainEqual(
      expect.objectContaining({ key: 'ingredients', state: 'coming-later' }),
    );
    expect(sectionsFor(activity({})).map((section) => section.key)).not.toContain(
      'ingredients',
    );
  });

  /**
   * `plans-and-lists.md` §2.2 hides Expenses below two participants and zero expenses, and
   * hides Updates on a private plan with no entries — which in Phase 1 is every plan. P1-26's
   * brief lists Expenses among the disabled sections; the product doc outranks an
   * implementation plan (`agent-playbook.md` §2), so they are absent rather than greyed out.
   * Raised in the PR rather than resolved silently.
   */
  it.each(['expenses', 'updates'])('hides %s rather than disabling it', (key) => {
    expect(sectionsFor(activity({})).map((s) => s.key)).not.toContain(key);
  });
});

describe('subtitleFor', () => {
  it('names a Task as a Task, with no sharing state', () => {
    expect(subtitleFor(task(), '')).toBe('Task');
  });

  it('names the Plan kind and the share state', () => {
    expect(subtitleFor(activity({}), 'Event')).toBe('Event · Just you');
  });
});

describe('Plan to Task blockers', () => {
  it('is unblocked on a solo plan with nothing attached', () => {
    expect(planToTaskBlockers(activity({}))).toEqual([]);
    expect(planToTaskBlockedMessage([])).toBeUndefined();
  });

  /**
   * Phase 1 can only produce zeroes, so this is checked against the counts rather than
   * hard-coded — the rule has to already be right on the first shared plan in Phase 6.
   */
  it('names people, expenses and prep children when they exist', () => {
    expect(
      planToTaskBlockers(
        activity({ participantCount: 2, expenseTotalCents: 4200, childCount: 1 }),
      ),
    ).toEqual(['2 people', '1 expense', '1 prep task']);
  });

  it('uses the singular for one person and one prep task', () => {
    expect(planToTaskBlockers(activity({ participantCount: 1, childCount: 1 }))).toEqual([
      '1 person',
      '1 prep task',
    ]);
  });

  it('builds §6.3 rule 3 copy naming exactly what must be removed', () => {
    expect(planToTaskBlockedMessage(['2 people', '1 expense'])).toBe(
      'Remove 2 people and 1 expense before changing this to a Task.',
    );
    expect(planToTaskBlockedMessage(['2 people'])).toBe(
      'Remove 2 people before changing this to a Task.',
    );
    expect(planToTaskBlockedMessage(['2 people', '1 expense', '3 prep tasks'])).toBe(
      'Remove 2 people, 1 expense and 3 prep tasks before changing this to a Task.',
    );
  });
});
