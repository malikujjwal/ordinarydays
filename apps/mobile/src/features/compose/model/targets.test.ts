import { createActivityInput, scheduleListItemInput } from '@od/shared/schemas';
import type { Recurrence } from '@od/shared/types';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_DETAILS, EMPTY_LOCATION, EMPTY_SCHEDULE } from './draft';
import {
  canSave,
  createLabel,
  type DraftFields,
  objectChoices,
  planKindChoices,
  planKindLabel,
  saveLabel,
  successToast,
  targetHeading,
  toCreateActivityInput,
  toScheduleListItemInput,
} from './targets';

/**
 * `expo-crypto` is a native module with no jsdom implementation, and P3-17 puts a real `ing_`
 * ULID behind every new ingredient row ({@link newIngredient}). Deterministic bytes keep the
 * minted ids stable so a test can assert identity rather than merely non-emptiness.
 */
vi.mock('expo-crypto', () => ({
  getRandomBytes: (count: number) =>
    Uint8Array.from({ length: count }, (_, index) => index),
  randomUUID: () => 'idem-test-key',
}));

/**
 * The chooser vocabulary and its mapping onto a request body (P1-24).
 *
 * `CLAUDE.md` rule 2 is what this file asserts, and it asserts it against the **real shared
 * schema** rather than against a shape written here: every body produced is fed through
 * `createActivityInput.parse`. A mapping that drifted from the contract would pass a
 * hand-written expectation and fail the server.
 */

describe('the object chooser', () => {
  it('offers exactly Task, Plan, List item, in that order', () => {
    expect(objectChoices.map((c) => c.label)).toEqual(['Task', 'Plan', 'Add list']);
  });

  /**
   * The list is frozen so a "most recently used" experiment cannot be a one-line sort. The
   * chooser costs one tap every time, deliberately (`activities.md` §2.2).
   */
  it('cannot be reordered by a caller', () => {
    expect(Object.isFrozen(objectChoices)).toBe(true);
    expect(() => (objectChoices as { length: number }).length).not.toThrow();
  });
});

describe('the Plan-kind chooser', () => {
  it('offers exactly General, Meal, Watch, Event, in that order', () => {
    expect(planKindChoices.map((c) => c.label)).toEqual([
      'General',
      'Meal',
      'Watch',
      'Event',
    ]);
  });

  /**
   * Every row says what it is for (founder, 2026-08-16). Asserted as a property rather than as
   * fixed strings: the point is that no row can be added without one, and copy that is pinned
   * twice is copy that drifts in one of the two places.
   */
  it('gives every plan kind a subtitle', () => {
    for (const choice of planKindChoices) {
      expect(choice.subtitle.length).toBeGreaterThan(0);
    }
  });

  /** `General` is the visible label for the stored type `custom`, and is a real choice. */
  it('maps General to custom and never to a fallback', () => {
    expect(planKindChoices[0]).toMatchObject({ value: 'custom', label: 'General' });
    expect(planKindLabel('custom')).toBe('General');
  });

  it('maps every stored plan type to a label', () => {
    expect(planKindChoices.map((c) => c.value)).toEqual([
      'custom',
      'meal',
      'watch',
      'event',
    ]);
    expect(planKindLabel('watch')).toBe('Watch');
  });

  it('throws rather than guessing at an unknown kind', () => {
    expect(() => planKindLabel('podcast' as never)).toThrow('Unknown plan kind');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(planKindChoices)).toBe(true);
  });
});

describe('the form header', () => {
  it('names the object for a Task', () => {
    expect(targetHeading({ objectKind: 'task', type: 'task' })).toBe('Task');
  });

  it('names the object and the Plan kind for a Plan', () => {
    expect(targetHeading({ objectKind: 'plan', type: 'watch' })).toBe('Plan · Watch');
    expect(targetHeading({ objectKind: 'plan', type: 'custom' })).toBe('Plan · General');
  });

  it('names a List item', () => {
    expect(
      targetHeading({ objectKind: 'listItem', listId: 'lst_01J000000000000000000000' }),
    ).toBe('List item');
  });
});

describe('the named write button', () => {
  it('says Save task for a Task', () => {
    expect(saveLabel({ objectKind: 'task', type: 'task' })).toBe('Save task');
  });

  it('names Create task, Create plan and Create list on global Add', () => {
    expect(createLabel('task')).toBe('Create task');
    expect(createLabel('plan')).toBe('Create plan');
    expect(createLabel('list')).toBe('Create list');
  });

  it('says Save plan for every Plan kind', () => {
    for (const choice of planKindChoices) {
      expect(saveLabel({ objectKind: 'plan', type: choice.value })).toBe('Save plan');
    }
  });

  /** `Add to <list name>` — a generic `Save` must never hide a list write. */
  it('names the destination list for a List item', () => {
    expect(
      saveLabel(
        { objectKind: 'listItem', listId: 'lst_01J000000000000000000000' },
        'Groceries',
      ),
    ).toBe('Add to Groceries');
  });
});

describe('toCreateActivityInput', () => {
  /**
   * A whole draft from a few fields. P1-25 widened this function's input from the three
   * common fields to the five tables' worth, so every case here states only what it is about
   * and inherits the empty rest — which is also what keeps a new field from silently
   * appearing in an assertion that was not written for it.
   */
  const draft = (patch: Partial<DraftFields> = {}): DraftFields => ({
    title: '',
    notes: '',
    schedule: EMPTY_SCHEDULE,
    location: EMPTY_LOCATION,
    reminderOffset: undefined,
    details: EMPTY_DETAILS,
    ...patch,
  });

  const ZONE = 'America/New_York';
  const fields = draft({ title: '  Call the dentist  ' });

  it('sends objectKind and type for a Task, and trims the title', () => {
    const input = toCreateActivityInput(
      { objectKind: 'task', type: 'task' },
      fields,
      ZONE,
    );

    expect(input).toEqual({
      objectKind: 'task',
      type: 'task',
      title: 'Call the dentist',
      details: { kind: 'task' },
    });
    expect(createActivityInput.safeParse(input).success).toBe(true);
  });

  it.each(planKindChoices.map((c) => c.value))(
    'sends objectKind plan and the chosen type %s, and passes the shared schema',
    (type) => {
      const input = toCreateActivityInput(
        { objectKind: 'plan', type },
        draft({ title: 'Severance', notes: '' }),
        ZONE,
      );

      expect(input).toMatchObject({ objectKind: 'plan', type });
      expect(createActivityInput.safeParse(input).success).toBe(true);
    },
  );

  /** `details.kind` must equal `type` — the server rejects a body where it does not. */
  it('mirrors the chosen type into details.kind for every Plan kind', () => {
    for (const { value } of planKindChoices) {
      const input = toCreateActivityInput(
        { objectKind: 'plan', type: value },
        draft({ title: 'Severance', notes: '' }),
        ZONE,
      );
      expect(input?.details?.kind).toBe(value);
    }
  });

  it('starts a Watch plan mediaTitle equal to the title', () => {
    const input = toCreateActivityInput(
      { objectKind: 'plan', type: 'watch' },
      draft({ title: 'Severance', notes: '' }),
      ZONE,
    );
    expect(input?.details).toEqual({ kind: 'watch', mediaTitle: 'Severance' });
  });

  it('omits notes and sourceUrl rather than sending empty strings', () => {
    const input = toCreateActivityInput(
      { objectKind: 'task', type: 'task' },
      draft({ title: 'x', notes: '   ', sourceUrl: '' }),
      ZONE,
    );
    expect(input).not.toHaveProperty('notes');
    expect(input).not.toHaveProperty('sourceUrl');
  });

  it('carries notes and sourceUrl when they have content', () => {
    const input = toCreateActivityInput(
      { objectKind: 'task', type: 'task' },
      draft({ title: 'x', notes: ' bring cash ', sourceUrl: 'https://example.com/a' }),
      ZONE,
    );
    expect(input).toMatchObject({
      notes: 'bring cash',
      sourceUrl: 'https://example.com/a',
    });
    expect(createActivityInput.safeParse(input).success).toBe(true);
  });

  it('writes one validated recurrence segment only when a schedule date exists', () => {
    const recurring: Recurrence = {
      mode: 'fixed',
      segments: [
        {
          freq: 'weekly',
          interval: 1,
          byWeekday: [3],
          effectiveFrom: '2026-08-12',
        },
      ],
    };
    const input = toCreateActivityInput(
      { objectKind: 'task', type: 'task' },
      draft({
        title: 'Gym',
        schedule: { ...EMPTY_SCHEDULE, date: '2026-08-12' },
        recurrence: recurring,
      }),
      ZONE,
    );

    expect(input?.recurrence).toEqual(recurring);
    expect(createActivityInput.safeParse(input).success).toBe(true);
    expect(
      toCreateActivityInput(
        { objectKind: 'task', type: 'task' },
        draft({ title: 'Gym', recurrence: recurring }),
        ZONE,
      ),
    ).not.toHaveProperty('recurrence');
  });

  /** A List item is not an Activity and does not go to `POST /v1/activities` at all. */
  it('produces no Activity body for a List item', () => {
    expect(
      toCreateActivityInput(
        { objectKind: 'listItem', listId: 'lst_01J000000000000000000000' },
        draft({ title: 'Chicken', notes: '' }),
        ZONE,
      ),
    ).toBeUndefined();
  });
});

describe('canSave', () => {
  it('needs a non-empty trimmed title and nothing else', () => {
    expect(canSave({ title: 'x', notes: '' })).toBe(true);
    expect(canSave({ title: '   ', notes: 'lots of notes' })).toBe(false);
    expect(canSave({ title: '', notes: '' })).toBe(false);
  });
});

const TODAY = '2026-08-12';

describe('successToast', () => {
  it('names the object and where it landed', () => {
    expect(
      successToast({ objectKind: 'task', type: 'task' }, EMPTY_SCHEDULE, TODAY),
    ).toBe('Task · saved to Anytime');
    expect(
      successToast({ objectKind: 'plan', type: 'event' }, EMPTY_SCHEDULE, TODAY),
    ).toBe('Event plan · saved to Needs a date');
    expect(
      successToast({ objectKind: 'plan', type: 'custom' }, EMPTY_SCHEDULE, TODAY),
    ).toBe('General plan · saved to Needs a date');
    expect(
      successToast(
        { objectKind: 'listItem', listId: 'lst_01J000000000000000000000' },
        EMPTY_SCHEDULE,
        TODAY,
      ),
    ).toBe('Added to list');
  });
});

/**
 * The schedule, location and reminder the five forms collect (P1-25).
 *
 * Every case round-trips through `createActivityInput`, because the value of this function is
 * not that it builds an object — it is that the object it builds is one the server accepts.
 */
describe('toCreateActivityInput — schedule, location and reminders', () => {
  const ZONE2 = 'Europe/London';
  const base = (patch: Partial<DraftFields> = {}): DraftFields => ({
    title: 'Dinner',
    notes: '',
    schedule: EMPTY_SCHEDULE,
    location: EMPTY_LOCATION,
    reminderOffset: undefined,
    details: EMPTY_DETAILS,
    ...patch,
  });

  const task = { objectKind: 'task', type: 'task' } as const;

  it('sends no schedule at all for an undated draft', () => {
    const input = toCreateActivityInput(task, base(), ZONE2);
    expect(input).not.toHaveProperty('schedule');
    expect(createActivityInput.safeParse(input).success).toBe(true);
  });

  it('anchors a date in the caller’s zone', () => {
    const input = toCreateActivityInput(
      task,
      base({
        schedule: {
          date: '2026-08-15',
          time: undefined,
          endTime: undefined,
          timeFromSlot: false,
        },
      }),
      ZONE2,
    );
    expect(input?.schedule).toEqual({ date: '2026-08-15', timezone: ZONE2 });
    expect(createActivityInput.safeParse(input).success).toBe(true);
  });

  /** `time` requires `date` and `endTime` requires `time` (§3 rule 4). */
  it('drops a time left behind by a cleared date', () => {
    const input = toCreateActivityInput(
      task,
      base({
        schedule: {
          date: undefined,
          time: '19:00',
          endTime: '21:00',
          timeFromSlot: false,
        },
      }),
      ZONE2,
    );
    expect(input).not.toHaveProperty('schedule');
  });

  it('drops an end time with no start time', () => {
    const input = toCreateActivityInput(
      task,
      base({
        schedule: {
          date: '2026-08-15',
          time: undefined,
          endTime: '21:00',
          timeFromSlot: false,
        },
      }),
      ZONE2,
    );
    expect(input?.schedule).not.toHaveProperty('endTime');
    expect(createActivityInput.safeParse(input).success).toBe(true);
  });

  it('carries a full schedule when all three are set', () => {
    const input = toCreateActivityInput(
      task,
      base({
        schedule: {
          date: '2026-08-15',
          time: '19:00',
          endTime: '21:00',
          timeFromSlot: false,
        },
      }),
      ZONE2,
    );
    expect(input?.schedule).toEqual({
      date: '2026-08-15',
      time: '19:00',
      endTime: '21:00',
      timezone: ZONE2,
    });
    expect(createActivityInput.safeParse(input).success).toBe(true);
  });

  /** `activityLocation` makes `label` required, so an address alone is not a location. */
  it('sends no location for an address with no label', () => {
    const input = toCreateActivityInput(
      task,
      base({ location: { label: '  ', address: '237 St James Place' } }),
      ZONE2,
    );
    expect(input).not.toHaveProperty('location');
  });

  it('sends the label, and the address with it when there is one', () => {
    expect(
      toCreateActivityInput(
        task,
        base({ location: { label: 'Zahav', address: '' } }),
        ZONE2,
      )?.location,
    ).toEqual({ label: 'Zahav' });

    expect(
      toCreateActivityInput(
        task,
        base({ location: { label: ' Zahav ', address: ' 237 St James ' } }),
        ZONE2,
      )?.location,
    ).toEqual({ label: 'Zahav', address: '237 St James' });
  });

  /**
   * A reminder is an offset from an instant, so it needs a date — and it becomes the
   * creator's own `REM#` row rather than a field on the Activity (ADR-047).
   */
  it('sends a reminder only alongside a schedule', () => {
    expect(
      toCreateActivityInput(task, base({ reminderOffset: -15 }), ZONE2),
    ).not.toHaveProperty('reminders');

    const dated = toCreateActivityInput(
      task,
      base({
        reminderOffset: -15,
        schedule: {
          date: '2026-08-15',
          time: '19:00',
          endTime: undefined,
          timeFromSlot: false,
        },
      }),
      ZONE2,
    );
    expect(dated?.reminders).toEqual([{ offsetMinutes: -15 }]);
    expect(createActivityInput.safeParse(dated).success).toBe(true);
  });

  it('sends no reminder for Off', () => {
    const input = toCreateActivityInput(
      task,
      base({
        reminderOffset: undefined,
        schedule: {
          date: '2026-08-15',
          time: '19:00',
          endTime: undefined,
          timeFromSlot: false,
        },
      }),
      ZONE2,
    );
    expect(input).not.toHaveProperty('reminders');
  });
});

/** All seven rows of §2.5's toast table, now that a date can reach them. */
describe('successToast — dated rows', () => {
  const dated = (date: string) => ({
    date,
    time: undefined,
    endTime: undefined,
    timeFromSlot: false,
  });
  const TODAY_2 = '2026-08-12';

  it('names Today for a task dated today', () => {
    expect(
      successToast({ objectKind: 'task', type: 'task' }, dated(TODAY_2), TODAY_2),
    ).toBe('Task · added to Today');
  });

  it('names the day for a task dated another day', () => {
    expect(
      successToast({ objectKind: 'task', type: 'task' }, dated('2026-08-14'), TODAY_2),
    ).toBe('Task · planned for Fri, 14 Aug');
  });

  it('names the day for a dated plan, whichever kind', () => {
    expect(
      successToast({ objectKind: 'plan', type: 'meal' }, dated('2026-08-14'), TODAY_2),
    ).toBe('Meal plan · planned for Fri, 14 Aug');
  });

  /** A past date is the retro-log path, and `logged for` is what tells the user so. */
  it('says logged for a past date, on both objects', () => {
    expect(
      successToast({ objectKind: 'task', type: 'task' }, dated('2026-08-04'), TODAY_2),
    ).toBe('Task · logged for Tue, 4 Aug');
    expect(
      successToast({ objectKind: 'plan', type: 'custom' }, dated('2026-08-04'), TODAY_2),
    ).toBe('General plan · logged for Tue, 4 Aug');
  });

  /** A plan dated today is planned, not "added to Today" — that row is the Task's alone. */
  it('keeps added to Today for tasks only', () => {
    expect(
      successToast({ objectKind: 'plan', type: 'event' }, dated(TODAY_2), TODAY_2),
    ).toBe('Event plan · planned for Wed, 12 Aug');
  });
});

/** The prep relationship (P3-38): carried by the Task arm only, and only from the field. */
describe('toCreateActivityInput — parentActivityId', () => {
  const fields: DraftFields = {
    title: 'Book hotel',
    notes: '',
    schedule: EMPTY_SCHEDULE,
    location: EMPTY_LOCATION,
    reminderOffset: undefined,
    details: EMPTY_DETAILS,
    parentActivityId: 'act_01J0000000000000000000000P',
  };

  it('carries the fixed parent on a Task and passes the shared schema', () => {
    const input = toCreateActivityInput(
      { objectKind: 'task', type: 'task' },
      fields,
      'UTC',
    );
    expect(input?.parentActivityId).toBe('act_01J0000000000000000000000P');
    expect(createActivityInput.safeParse(input).success).toBe(true);
  });

  it('never carries a parent on a Plan, whatever the draft holds', () => {
    const input = toCreateActivityInput(
      { objectKind: 'plan', type: 'custom' },
      fields,
      'UTC',
    );
    expect(input).not.toHaveProperty('parentActivityId');
  });
});

/**
 * The bridge request (P3-34, §P3-13).
 *
 * Same discipline as the create mapping above: every produced body round-trips through the
 * real shared `scheduleListItemInput`, and the two explicit choices — kind and audience — are
 * required parameters this function cannot invent.
 */
describe('toScheduleListItemInput', () => {
  const ZONE3 = 'America/New_York';
  const ACTIVITY = 'act_01J0000000000000000000000A';
  const audience = { mode: 'just_me' } as const;
  const fields = (patch: Partial<DraftFields> = {}): DraftFields => ({
    title: 'Severance',
    notes: '',
    schedule: EMPTY_SCHEDULE,
    location: EMPTY_LOCATION,
    reminderOffset: undefined,
    details: EMPTY_DETAILS,
    ...patch,
  });

  it('carries the explicit kind and audience and nothing defaulted', () => {
    const input = toScheduleListItemInput(
      { objectKind: 'plan', type: 'watch' },
      fields({ details: { ...EMPTY_DETAILS, season: '2', episode: '6' } }),
      ZONE3,
      ACTIVITY,
      audience,
      () => 'rem_01J0000000000000000000000B',
    );
    expect(input?.activityId).toBe(ACTIVITY);
    expect(input?.creationTarget).toEqual({ objectKind: 'plan', type: 'watch' });
    expect(input?.audience).toEqual({ mode: 'just_me' });
    expect(input?.details).toMatchObject({ kind: 'watch', season: 2, episode: 6 });
    expect(scheduleListItemInput.safeParse(input).success).toBe(true);
  });

  it('mints a stable reminder id for every dated reminder', () => {
    const input = toScheduleListItemInput(
      { objectKind: 'plan', type: 'event' },
      fields({
        reminderOffset: -30,
        schedule: {
          date: '2026-08-15',
          time: '19:00',
          endTime: undefined,
          timeFromSlot: false,
        },
      }),
      ZONE3,
      ACTIVITY,
      audience,
      () => 'rem_01J0000000000000000000000C',
    );
    expect(input?.reminders).toEqual([
      { reminderId: 'rem_01J0000000000000000000000C', offsetMinutes: -30 },
    ]);
    expect(scheduleListItemInput.safeParse(input).success).toBe(true);
  });

  it('builds nothing for a non-Plan draft', () => {
    expect(
      toScheduleListItemInput(
        // A Task can never reach the bridge; the type forbids it and so does the runtime.
        { objectKind: 'plan', type: 'custom' },
        fields({ title: '   ' }),
        ZONE3,
        ACTIVITY,
        audience,
        () => 'rem_01J0000000000000000000000D',
      )?.title,
    ).toBe('');
  });
});

/** A form-created activity carries the ids its picker uploaded (P3-41, criterion 24). */
describe('toCreateActivityInput — uploaded photos', () => {
  const ATT = 'att_01J8XKQ2M4N5P6R7S8T9V0W1A1';
  const ATT_TWO = 'att_01J8XKQ2M4N5P6R7S8T9V0W1A2';
  const fields: DraftFields = {
    title: 'Dinner at Zahav',
    notes: '',
    schedule: EMPTY_SCHEDULE,
    location: EMPTY_LOCATION,
    reminderOffset: undefined,
    details: EMPTY_DETAILS,
    attachmentIds: [ATT, ATT_TWO],
  };

  it('carries the uploaded ids in attachmentIds, in pick order, on a Plan', () => {
    const input = toCreateActivityInput(
      { objectKind: 'plan', type: 'event' },
      fields,
      'America/New_York',
    );
    expect(input?.attachmentIds).toEqual([ATT, ATT_TWO]);
    expect(createActivityInput.safeParse(input).success).toBe(true);
  });

  it('carries them on a Task too, and sends nothing when there are none', () => {
    expect(
      toCreateActivityInput({ objectKind: 'task', type: 'task' }, fields, 'UTC')
        ?.attachmentIds,
    ).toEqual([ATT, ATT_TWO]);
    expect(
      toCreateActivityInput(
        { objectKind: 'task', type: 'task' },
        { ...fields, attachmentIds: [] },
        'UTC',
      ),
    ).not.toHaveProperty('attachmentIds');
  });
});
