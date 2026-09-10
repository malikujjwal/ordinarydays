import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { Activity, ActivityDetails } from '../types/activity.js';
import type {
  ActivityDetail,
  ActivityParentSummary,
  ActivitySourceList,
} from '../types/activityDetail.js';
import {
  activity,
  activityCompletionResult,
  activityDetail,
  type activityDetails,
  type activityParentSummary,
  type activitySourceList,
  completeActivityInput,
  completionFollowUp,
  createActivityInput,
  patchActivityInput,
  skipActivityInput,
  uncompleteActivityInput,
} from './activity.js';

/**
 * The schema and the interface describe one stored shape, in both directions — a one-way
 * assertion passes happily when one side gains a field the other lacks.
 *
 * These are checked by `tsconfig.test.json`, which P1-06 added. Before that, test files were
 * excluded from every `tsc` invocation, so `expectTypeOf` — which is erased at runtime —
 * asserted nothing at all.
 */
describe('the schema and the interface are the same shape', () => {
  it('Activity is assignable both ways', () => {
    expectTypeOf<z.infer<typeof activity>>().toEqualTypeOf<Activity>();
  });

  it('ActivityDetails is assignable both ways', () => {
    expectTypeOf<z.infer<typeof activityDetails>>().toEqualTypeOf<ActivityDetails>();
  });

  it('ActivityDetail is assignable both ways', () => {
    expectTypeOf<z.infer<typeof activityDetail>>().toEqualTypeOf<ActivityDetail>();
  });

  it('ActivityParentSummary is assignable both ways', () => {
    expectTypeOf<
      z.infer<typeof activityParentSummary>
    >().toEqualTypeOf<ActivityParentSummary>();
  });

  it('ActivitySourceList is assignable both ways', () => {
    expectTypeOf<
      z.infer<typeof activitySourceList>
    >().toEqualTypeOf<ActivitySourceList>();
  });
});

const base = {
  activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  status: 'saved',
  title: 'Buy milk',
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  icsSequence: 0,
  createdAt: '2026-08-08T00:00:00.000Z',
  lastActivityAt: '2026-08-08T00:00:00.000Z',
  updatedAt: '2026-08-08T00:00:00.000Z',
  schemaVersion: 1,
} as const;

const task = { ...base, objectKind: 'task', type: 'task', details: { kind: 'task' } };

describe('the activity detail projection', () => {
  it('accepts a nonnegative stored-completion count', () => {
    expect(
      activityDetail.safeParse({
        activity: task,
        capabilities: { complete: true, skip: true, snooze: true },
        reminders: [],
        completedOccurrenceCount: 40,
      }).success,
    ).toBe(true);
  });

  it.each([-1, 1.5, '2'])('rejects invalid stored-completion count %s', (count) => {
    expect(
      activityDetail.safeParse({
        activity: task,
        capabilities: { complete: true, skip: true, snooze: true },
        reminders: [],
        completedOccurrenceCount: count,
      }).success,
    ).toBe(false);
  });

  it('accepts optional named parent and origin list', () => {
    expect(
      activityDetail.safeParse({
        activity: task,
        capabilities: { complete: true, skip: true, snooze: true },
        reminders: [],
        parent: {
          activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X9',
          title: 'Sunday roast',
        },
        sourceList: {
          listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1XD',
          title: 'Weekly shop',
        },
      }).success,
    ).toBe(true);
  });

  it('rejects a parent or origin list without a title', () => {
    const envelope = {
      activity: task,
      capabilities: { complete: true, skip: true, snooze: true },
      reminders: [],
    };
    expect(
      activityDetail.safeParse({
        ...envelope,
        parent: { activityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X9', title: '' },
      }).success,
    ).toBe(false);
    expect(
      activityDetail.safeParse({
        ...envelope,
        sourceList: { listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1XD', title: '' },
      }).success,
    ).toBe(false);
  });
});

describe('the stored Activity', () => {
  it('accepts a minimal Task', () => {
    expect(activity.safeParse(task).success).toBe(true);
  });

  it.each(['20:00', '2026-08-09T00:00:00.000Z'])(
    'accepts server-derived snoozedUntil %s',
    (snoozedUntil) => {
      expect(activity.safeParse({ ...task, snoozedUntil }).success).toBe(true);
    },
  );

  it('accepts a Plan of each of the four visible kinds', () => {
    for (const [type, details] of [
      ['custom', { kind: 'custom' }],
      ['meal', { kind: 'meal' }],
      ['watch', { kind: 'watch', mediaTitle: 'Severance' }],
      ['event', { kind: 'event' }],
    ] as const) {
      expect(
        activity.safeParse({ ...base, objectKind: 'plan', type, details }).success,
      ).toBe(true);
    }
  });

  it('rejects the hidden task-flavoured Plan', () => {
    expect(
      activity.safeParse({
        ...base,
        objectKind: 'plan',
        type: 'task',
        details: { kind: 'task' },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['usr_local_dev', true],
    ['usr_01J8XKQ2M4N5P6R7S8T9V0W1X2', true],
    ['local_dev', false],
    ['usr_', false],
    ['', false],
  ])('ownerId %s is accepted: %s', (ownerId, expected) => {
    expect(activity.safeParse({ ...task, ownerId }).success).toBe(expected);
  });
});

/**
 * The refinement that makes "a meal with watch fields" unrepresentable. Every mismatched
 * pair, not a sample: the point is that no combination slips through.
 */
describe('details.kind must equal type', () => {
  const kinds = ['task', 'meal', 'watch', 'event', 'custom'] as const;
  const detailsFor = (kind: (typeof kinds)[number]) =>
    kind === 'watch' ? { kind, mediaTitle: 'x' } : { kind };

  for (const type of kinds) {
    for (const kind of kinds) {
      if (type === kind) continue;
      it(`rejects type ${type} with details.kind ${kind}`, () => {
        const objectKind = type === 'task' ? 'task' : 'plan';
        const result = activity.safeParse({
          ...base,
          objectKind,
          type,
          details: detailsFor(kind),
        });
        expect(result.success).toBe(false);
      });
    }
  }
});

describe('title bounds', () => {
  it('accepts 200 characters', () => {
    expect(activity.safeParse({ ...task, title: 'x'.repeat(200) }).success).toBe(true);
  });

  it('rejects 201', () => {
    expect(activity.safeParse({ ...task, title: 'x'.repeat(201) }).success).toBe(false);
  });

  it('rejects a title that is only whitespace, because it trims first', () => {
    expect(activity.safeParse({ ...task, title: '   ' }).success).toBe(false);
  });
});

describe('Event reservation party size', () => {
  const withPartySize = (partySize: number) => ({
    ...base,
    objectKind: 'plan',
    type: 'event',
    details: { kind: 'event', reservation: { partySize } },
  });

  it('accepts the documented maximum of 99', () => {
    expect(activity.safeParse(withPartySize(99)).success).toBe(true);
  });

  it('rejects 100', () => {
    expect(activity.safeParse(withPartySize(100)).success).toBe(false);
  });
});

/**
 * The tests this task exists for. A body that does not name its target is rejected — never
 * completed from context, a default, or `details.kind`.
 */
describe('the creation target is explicit or the request fails', () => {
  it.each([
    ['a title alone', { title: 'Buy milk' }],
    ['a type with no objectKind', { title: 'Buy milk', type: 'task' }],
    ['an objectKind with no type', { title: 'Buy milk', objectKind: 'task' }],
    [
      'details that imply a kind, with no target',
      { title: 'Pasta', details: { kind: 'meal' } },
    ],
  ])('rejects %s', (_why, body) => {
    expect(createActivityInput.safeParse(body).success).toBe(false);
  });

  it('accepts the same title once a Task target is named', () => {
    expect(
      createActivityInput.safeParse({
        title: 'Buy milk',
        objectKind: 'task',
        type: 'task',
      }).success,
    ).toBe(true);
  });

  it('accepts the same title as a Meal Plan, so the words never choose', () => {
    expect(
      createActivityInput.safeParse({
        title: 'Buy milk',
        objectKind: 'plan',
        type: 'meal',
      }).success,
    ).toBe(true);
  });

  it('rejects a Plan whose type is task', () => {
    expect(
      createActivityInput.safeParse({
        title: 'Buy milk',
        objectKind: 'plan',
        type: 'task',
      }).success,
    ).toBe(false);
  });

  it('rejects participants on a Task, which cannot have them', () => {
    expect(
      createActivityInput.safeParse({
        title: 'Buy milk',
        objectKind: 'task',
        type: 'task',
        participants: [{ displayName: 'Alice' }],
      }).success,
    ).toBe(false);
  });

  it('accepts participants on a Plan, so Phase 6 changes no client code', () => {
    expect(
      createActivityInput.safeParse({
        title: 'Dinner',
        objectKind: 'plan',
        type: 'event',
        participants: [{ displayName: 'Alice' }],
      }).success,
    ).toBe(true);
  });
});

describe('schedule validation', () => {
  const create = (schedule: unknown) =>
    createActivityInput.safeParse({
      title: 'Gym',
      objectKind: 'task',
      type: 'task',
      schedule,
    });

  it('accepts a date alone', () => {
    expect(create({ date: '2026-08-08', timezone: 'America/New_York' }).success).toBe(
      true,
    );
  });

  it('rejects an end time with no start time', () => {
    expect(
      create({ date: '2026-08-08', endTime: '19:00', timezone: 'America/New_York' })
        .success,
    ).toBe(false);
  });

  it('rejects an end time before the start', () => {
    expect(
      create({
        date: '2026-08-08',
        time: '19:00',
        endTime: '18:00',
        timezone: 'America/New_York',
      }).success,
    ).toBe(false);
  });

  it('rejects an end time equal to the start', () => {
    expect(
      create({
        date: '2026-08-08',
        time: '19:00',
        endTime: '19:00',
        timezone: 'America/New_York',
      }).success,
    ).toBe(false);
  });

  it('rejects a time with no date, because there is nothing to hang it on', () => {
    expect(create({ time: '19:00', timezone: 'America/New_York' }).success).toBe(false);
  });
});

describe('recurrence on create', () => {
  const schedule = { date: '2026-08-08', timezone: 'America/New_York' };
  const first = { freq: 'daily' as const, effectiveFrom: '2099-01-01' };

  it('accepts one segment when the activity has a date', () => {
    expect(
      createActivityInput.safeParse({
        title: 'Gym',
        objectKind: 'task',
        type: 'task',
        schedule,
        recurrence: { mode: 'fixed', segments: [first] },
      }).success,
    ).toBe(true);
  });

  it('rejects a two-segment create', () => {
    expect(
      createActivityInput.safeParse({
        title: 'Gym',
        objectKind: 'task',
        type: 'task',
        schedule,
        recurrence: {
          mode: 'fixed',
          segments: [first, { ...first, effectiveFrom: '2099-02-01' }],
        },
      }).success,
    ).toBe(false);
  });

  it('rejects recurrence without a schedule date', () => {
    expect(
      createActivityInput.safeParse({
        title: 'Gym',
        objectKind: 'task',
        type: 'task',
        recurrence: { mode: 'fixed', segments: [first] },
      }).success,
    ).toBe(false);
  });
});

describe('reminders on create', () => {
  const base = { title: 'Gym', objectKind: 'task', type: 'task' } as const;

  it('accepts minute precision with a timed proposed schedule', () => {
    expect(
      createActivityInput.safeParse({
        ...base,
        schedule: { date: '2026-08-12', time: '18:00', timezone: 'UTC' },
        reminders: [{ offsetMinutes: -15 }],
      }).success,
    ).toBe(true);
  });

  it.each([0, -1440, -10080])(
    'accepts date-only whole-day offset %i',
    (offsetMinutes) => {
      expect(
        createActivityInput.safeParse({
          ...base,
          schedule: { date: '2026-08-12', timezone: 'UTC' },
          reminders: [{ offsetMinutes }],
        }).success,
      ).toBe(true);
    },
  );

  it.each([-15, -1439])('rejects date-only sub-day offset %i', (offsetMinutes) => {
    expect(
      createActivityInput.safeParse({
        ...base,
        schedule: { date: '2026-08-12', timezone: 'UTC' },
        reminders: [{ offsetMinutes }],
      }).success,
    ).toBe(false);
  });

  it('rejects reminders without a proposed schedule date', () => {
    expect(
      createActivityInput.safeParse({
        ...base,
        reminders: [{ offsetMinutes: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe('server-derived timestamps on create', () => {
  it.each(['lastActivityAt', 'updatedAt', 'snoozedUntil'])(
    'rejects %s instead of accepting mass assignment',
    (field) => {
      expect(
        createActivityInput.safeParse({
          title: 'Buy milk',
          objectKind: 'task',
          type: 'task',
          [field]: '2026-08-09T00:00:00.000Z',
        }).success,
      ).toBe(false);
    },
  );
});

describe('patch', () => {
  it.each(['lastActivityAt', 'updatedAt', 'snoozedUntil'])(
    'rejects server-derived %s',
    (field) => {
      expect(
        patchActivityInput.safeParse({ [field]: '2026-08-09T00:00:00.000Z' }).success,
      ).toBe(false);
    },
  );
  it('accepts cancelled, the one status a client may set', () => {
    expect(patchActivityInput.safeParse({ status: 'cancelled' }).success).toBe(true);
  });

  it.each(['saved', 'scheduled', 'completed', 'skipped'])(
    'rejects %s, which is derived server-side',
    (status) => {
      expect(patchActivityInput.safeParse({ status }).success).toBe(false);
    },
  );

  it('rejects schedule and unschedule fields because POST /schedule is the sole path', () => {
    expect(patchActivityInput.safeParse({ schedule: null }).success).toBe(false);
    expect(
      patchActivityInput.safeParse({
        schedule: { date: '2026-08-10', timezone: 'UTC' },
      }).success,
    ).toBe(false);
  });

  it('rejects objectKind without type, so the server never picks a Plan kind', () => {
    expect(patchActivityInput.safeParse({ objectKind: 'plan' }).success).toBe(false);
  });

  it('accepts a complete conversion target', () => {
    expect(
      patchActivityInput.safeParse({ objectKind: 'task', type: 'task' }).success,
    ).toBe(true);
  });

  it('rejects an unknown field rather than ignoring it', () => {
    expect(patchActivityInput.safeParse({ ownerId: 'usr_other' }).success).toBe(false);
  });

  /**
   * Strictness holds **all the way down**, not only at the top level (P3-13). Before that,
   * `activityLocation` and every `activityDetails` arm were plain `z.object`s, so a nested
   * unknown field parsed happily and vanished — and the activity that got written was
   * quietly smaller than the one the user confirmed, which is the exact failure the
   * `activityDetails` doc comment already claimed did not happen.
   */
  it.each([
    [
      'an authority field on location',
      { location: { label: 'Zahav', ownerId: 'usr_other' } },
    ],
    ['a field from another details arm', { details: { kind: 'meal', season: 3 } }],
    [
      'an unknown field on an ingredient',
      { details: { kind: 'meal', ingredients: [{ name: 'Eggs', aisle: 4 }] } },
    ],
  ])('rejects %s on a patch rather than stripping it', (_why, body) => {
    expect(patchActivityInput.safeParse(body).success).toBe(false);
  });

  it.each([
    [
      'an unknown field on schedule',
      {
        schedule: {
          date: '2026-09-01',
          timezone: 'America/New_York',
          occurrenceDate: 'x',
        },
      },
    ],
    [
      'a field from another details arm',
      { details: { kind: 'event', watchStatus: 'want' } },
    ],
  ])('rejects %s on a create rather than stripping it', (_why, overrides) => {
    expect(
      createActivityInput.safeParse({
        objectKind: 'plan',
        type: 'event',
        title: 'Zahav',
        ...overrides,
      }).success,
    ).toBe(false);
  });

  it('accepts editedFromDate with a recurrence append request', () => {
    expect(
      patchActivityInput.safeParse({
        recurrence: {
          mode: 'fixed',
          segments: [{ freq: 'daily', effectiveFrom: '2026-08-08' }],
        },
        editedFromDate: '2026-08-10',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['no recurrence field', { editedFromDate: '2026-08-10' }],
    ['recurrence removal', { recurrence: null, editedFromDate: '2026-08-10' }],
  ])('rejects editedFromDate with %s', (_name, patch) => {
    expect(patchActivityInput.safeParse(patch).success).toBe(false);
  });
});

describe('complete, uncomplete and skip inputs', () => {
  it('accepts the optional nominal date and a supported outcome', () => {
    expect(
      completeActivityInput.safeParse({
        occurrenceDate: '2026-08-11',
        outcome: 'attended',
      }).success,
    ).toBe(true);
  });

  it.each([
    [completeActivityInput, { status: 'completed' }],
    [uncompleteActivityInput, { outcome: 'done' }],
    [skipActivityInput, { status: 'skipped' }],
  ])('rejects fields owned by the server', (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('accepts an optional nominal date for skip', () => {
    expect(skipActivityInput.safeParse({ occurrenceDate: '2026-08-11' }).success).toBe(
      true,
    );
  });
});

/**
 * The client-minted `act_` id (Phase 2.6, ADR-055).
 *
 * Identity only: the field carries which entity this is, never who owns it or when it was
 * made. The authority fields stay rejected by the same `strictObject` that rejects a typo.
 */
describe('createActivityInput accepts a client-minted activityId', () => {
  const task = { title: 'Buy milk', objectKind: 'task', type: 'task' } as const;
  const ACT = 'act_01J0000000000000000000000A';

  it('stays valid with the field omitted, so the change is additive', () => {
    const parsed = createActivityInput.safeParse(task);
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'activityId' in parsed.data).toBe(false);
  });

  it('accepts a well-formed act_ ULID and preserves it', () => {
    const parsed = createActivityInput.safeParse({ ...task, activityId: ACT });
    expect(parsed.success && parsed.data.activityId).toBe(ACT);
  });

  it('accepts one on a Plan too, since offline creation is not Task-only', () => {
    expect(
      createActivityInput.safeParse({
        title: 'Dinner',
        objectKind: 'plan',
        type: 'event',
        activityId: ACT,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a bare ULID with no prefix', '01J0000000000000000000000A'],
    ['another entity prefix', 'rem_01J0000000000000000000000A'],
    ['an id one character short', 'act_01J000000000000000000000A'],
    ['a non-Crockford character', 'act_01J000000000000000000000IA'],
    ['a lowercase body', 'act_01j0000000000000000000000a'],
    ['an empty string', ''],
  ])('rejects %s', (_why, activityId) => {
    expect(createActivityInput.safeParse({ ...task, activityId }).success).toBe(false);
  });

  it('still refuses the authority fields an id might be mistaken for', () => {
    // An id says which entity. It never says whose, or when — those stay server-derived.
    expect(
      createActivityInput.safeParse({
        ...task,
        activityId: ACT,
        ownerId: 'usr_01J0000000000000000000000B',
      }).success,
    ).toBe(false);
    expect(
      createActivityInput.safeParse({
        ...task,
        activityId: ACT,
        createdAt: '2026-08-17T10:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

/**
 * The completion follow-up (P3-16).
 *
 * The schema is the only thing standing between the server and a payload that describes a
 * write nobody asked for, so what it **refuses** is the interesting half.
 */
describe('the completion follow-up', () => {
  const LIST = 'lst_01J0000000000000000000000A';
  const ITEM = 'itm_01J0000000000000000000000B';
  const shared = {
    listId: LIST,
    listTitle: 'Movies and shows',
    itemId: ITEM,
    current: { season: 2, episode: 4 },
  } as const;

  it('accepts the show row: current progress and the session as the target', () => {
    const parsed = completionFollowUp.safeParse({
      kind: 'watch_progress',
      ...shared,
      mediaKind: 'show',
      target: { season: 2, episode: 5 },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts the exposed-state fallback with one canonical done target', () => {
    expect(
      completionFollowUp.safeParse({
        kind: 'list_item_state',
        listId: LIST,
        listTitle: 'Movies and shows',
        itemId: ITEM,
        current: { state: 'active' },
        target: { state: 'done' },
      }).success,
    ).toBe(true);
  });

  it('accepts an item that has never said whether it is a movie or a show', () => {
    expect(
      completionFollowUp.safeParse({
        kind: 'watch_progress',
        ...shared,
        current: {},
        target: { episode: 1 },
      }).success,
    ).toBe(true);
  });

  it.each([
    ['a season alone', { season: 3 }],
    ['an episode alone', { episode: 7 }],
    ['both', { season: 3, episode: 7 }],
  ])('accepts a progress target naming %s', (_why, target) => {
    expect(
      completionFollowUp.safeParse({
        kind: 'watch_progress',
        ...shared,
        mediaKind: 'show',
        target,
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      'a show reaching for the watched transition',
      { kind: 'watch_progress', ...shared, target: { watchStatus: 'watched' } },
    ],
    [
      'a movie carrying an episode to advance to',
      { kind: 'watch_watched', ...shared, target: { season: 2, episode: 5 } },
    ],
    [
      'a state target that is not done',
      {
        kind: 'list_item_state',
        listId: LIST,
        listTitle: 'Movies and shows',
        itemId: ITEM,
        current: { state: 'open' },
        target: { state: 'active' },
      },
    ],
    [
      'an unknown follow-up kind',
      { kind: 'watch_next_episode', ...shared, target: { episode: 6 } },
    ],
    [
      'an activity id, which would let a client confirm against the wrong object',
      {
        kind: 'watch_progress',
        ...shared,
        activityId: 'act_01J0000000000000000000000C',
        target: { episode: 5 },
      },
    ],
  ])('rejects %s', (_why, value) => {
    expect(completionFollowUp.safeParse(value).success).toBe(false);
  });

  /**
   * **An empty target is not a weaker question — it is no question.** `Update to ?` renders
   * nothing, and a client building the confirming `PATCH` from `{}` would send a `details`
   * body that describes no visible update (`plans-and-lists.md` §8.4 step 2).
   */
  it('rejects a progress target naming neither a season nor an episode', () => {
    expect(
      completionFollowUp.safeParse({
        kind: 'watch_progress',
        ...shared,
        mediaKind: 'show',
        target: {},
      }).success,
    ).toBe(false);
  });

  it('accepts structured episode Progress for an item carrying movie context', () => {
    expect(
      completionFollowUp.safeParse({
        kind: 'watch_progress',
        ...shared,
        mediaKind: 'movie',
        target: { season: 2, episode: 5 },
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      'the legacy watched arm',
      { kind: 'watch_watched', ...shared, target: { watchStatus: 'watched' } },
    ],
    [
      'an already-done current state',
      {
        kind: 'list_item_state',
        listId: LIST,
        listTitle: 'Movies and shows',
        itemId: ITEM,
        current: { state: 'done' },
        target: { state: 'done' },
      },
    ],
  ])('rejects %s', (_why, value) => {
    expect(completionFollowUp.safeParse(value).success).toBe(false);
  });

  it('is optional on the result, so a completion with nothing to suggest is valid', () => {
    const result = activityCompletionResult.safeParse({ activity: task });
    expect(result.success).toBe(true);
    expect(result.success && 'followUp' in result.data).toBe(false);
  });
});
