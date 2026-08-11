import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type { Activity, ActivityDetails } from '../types/activity.js';
import {
  activity,
  type activityDetails,
  completeActivityInput,
  createActivityInput,
  patchActivityInput,
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

  it('accepts schedule: null, which is the unschedule path', () => {
    expect(patchActivityInput.safeParse({ schedule: null }).success).toBe(true);
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

describe('complete and uncomplete inputs', () => {
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
  ])('rejects fields owned by the server', (schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
