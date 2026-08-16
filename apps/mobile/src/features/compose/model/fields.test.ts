import type { ActivityType } from '@od/shared/types';
import { describe, expect, it } from 'vitest';
import {
  type FieldKey,
  fieldRegions,
  fieldsByType,
  isFieldVisible,
  MEAL_SLOTS,
  slotForTime,
  timeForSlot,
  UNBUILT_FIELDS,
  watchKind,
} from './fields';

/**
 * The five tables in `activities.md` §4, pinned (P1-25).
 *
 * These are the assertions the phase file asks for: *"a test that fails when a field is added,
 * removed or reordered"*. They are written as literal expected lists rather than derived from
 * the module, because a test that computed its expectation from the thing under test would
 * pass no matter what either of them said.
 */
describe('the field tables', () => {
  const keysOf = (type: keyof typeof fieldsByType) =>
    fieldsByType[type].map((spec) => spec.key);

  it('Task renders §4.1, in order', () => {
    expect(keysOf('task')).toEqual([
      'title',
      'date',
      'time',
      'reminder',
      'repeat',
      'relatedPlan',
      'notes',
    ]);
  });

  it('Meal renders §4.2, in order', () => {
    expect(keysOf('meal')).toEqual([
      'title',
      'date',
      'time',
      'slot',
      'people',
      'ingredients',
      'addIngredientsTo',
      'recipeUrl',
      'notes',
    ]);
  });

  it('Watch renders §4.3, in order', () => {
    expect(keysOf('watch')).toEqual([
      'title',
      'kind',
      'season',
      'episode',
      'episodeTitle',
      'date',
      'time',
      'people',
      'service',
      'alsoAddTo',
      'notes',
    ]);
  });

  it('Event renders §4.4, in order', () => {
    expect(keysOf('event')).toEqual([
      'title',
      'date',
      'time',
      'endTime',
      'location',
      'people',
      'reservation',
      'ticketsAndDetails',
      'description',
      'sourceImageLink',
      'reminder',
      'notes',
    ]);
  });

  it('General renders §4.6, in order', () => {
    expect(keysOf('custom')).toEqual([
      'title',
      'date',
      'time',
      'people',
      'reminder',
      'repeat',
      'notes',
    ]);
  });

  /** The label is the **Field** column, verbatim. Two tables rename the title row. */
  it.each([
    ['task', 'Title'],
    ['meal', 'Meal'],
    ['watch', 'Movie or show'],
    ['event', 'Title'],
    ['custom', 'Title'],
  ] as const)('%s calls its title row %s', (type, label) => {
    expect(fieldsByType[type][0]).toEqual({ key: 'title', label });
  });

  /** Only the Event table calls it `Start time`, because only it offers an end time beside. */
  it('names the time row Start time on an Event and Time everywhere else', () => {
    const timeLabel = (type: keyof typeof fieldsByType) =>
      fieldsByType[type].find((spec) => spec.key === 'time')?.label;

    expect(timeLabel('event')).toBe('Start time');
    for (const type of ['task', 'meal', 'watch', 'custom'] as const) {
      expect(timeLabel(type)).toBe('Time');
    }
  });

  /** §4.7: Tasks never expose People. A coordinated to-do is an explicit Plan → General. */
  it('gives a Task no People row, and every Plan kind one', () => {
    expect(keysOf('task')).not.toContain('people');
    for (const type of ['meal', 'watch', 'event', 'custom'] as const) {
      expect(keysOf(type)).toContain('people');
    }
  });

  /** §2.1 of `notifications.md`: the Meal and Watch forms show none. */
  it('shows Reminder on Task, Event and General only', () => {
    for (const type of ['task', 'event', 'custom'] as const) {
      expect(keysOf(type)).toContain('reminder');
    }
    for (const type of ['meal', 'watch'] as const) {
      expect(keysOf(type)).not.toContain('reminder');
    }
  });
});

describe('conditional visibility', () => {
  it.each(['season', 'episode', 'episodeTitle'] as const)(
    '%s appears only when Kind is Show',
    (key) => {
      expect(isFieldVisible(key, { mediaKind: 'show' })).toBe(true);
      expect(isFieldVisible(key, { mediaKind: 'movie' })).toBe(false);
      expect(isFieldVisible(key, {})).toBe(false);
    },
  );

  /**
   * §3.4's three interlocks, as **absence** rather than as a disabled control (P2-43). Each
   * one used to render greyed with `Pick a date first.` beside it.
   */
  it.each(['time', 'reminder', 'repeat'] as const)(
    '%s appears only once dated',
    (key) => {
      expect(isFieldVisible(key, {})).toBe(false);
      expect(isFieldVisible(key, { hasDate: true })).toBe(true);
    },
  );

  it('shows End time only once a start time exists', () => {
    expect(isFieldVisible('endTime', { hasDate: true })).toBe(false);
    expect(isFieldVisible('endTime', { hasDate: true, hasTime: true })).toBe(true);
  });

  it('leaves every other field unconditional', () => {
    expect(isFieldVisible('date', {})).toBe(true);
    expect(isFieldVisible('notes', { mediaKind: 'movie' })).toBe(true);
  });
});

/**
 * The two regions the form renders (P2-43), and the three properties that make the split safe.
 */
describe('the More options split', () => {
  const types: readonly ActivityType[] = ['task', 'meal', 'watch', 'event', 'custom'];
  const dated = { hasDate: true, hasTime: true, mediaKind: 'show' } as const;
  const keys = (specs: readonly { key: FieldKey }[]) => specs.map((spec) => spec.key);

  /**
   * §3 rule 3: "fields render top-to-bottom in the order given in §4". A disclosure holding a
   * **contiguous suffix** folds the end of the list away without reordering anything; one
   * holding an arbitrary subset would silently rewrite the spec.
   */
  it.each(types)('%s: More options is a contiguous suffix of the table', (type) => {
    const { primary, more } = fieldRegions(type, dated);
    const table = keys(fieldsByType[type]);
    const positions = [...keys(primary), ...keys(more)].map((key) => table.indexOf(key));

    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const firstMore = table.indexOf(keys(more)[0] as FieldKey);
    for (const key of keys(primary)) expect(table.indexOf(key)).toBeLessThan(firstMore);
  });

  it.each(types)('%s: renders no unbuilt field in either region', (type) => {
    const { primary, more } = fieldRegions(type, dated);
    for (const key of [...keys(primary), ...keys(more)]) {
      expect(UNBUILT_FIELDS.has(key)).toBe(false);
    }
  });

  /** The title is the frame's, above both regions, on every type. */
  it.each(types)('%s: neither region carries the title', (type) => {
    const { primary, more } = fieldRegions(type, dated);
    expect([...keys(primary), ...keys(more)]).not.toContain('title');
  });

  it('keeps the schedule up front and folds the rest away', () => {
    expect(keys(fieldRegions('task', { hasDate: true }).primary)).toEqual([
      'date',
      'time',
    ]);
    expect(keys(fieldRegions('task', { hasDate: true }).more)).toEqual([
      'reminder',
      'repeat',
      'notes',
    ]);
  });

  /** §4.2 makes the slot and the time two views of one value, so they stay together. */
  it('keeps a Meal slot beside its time', () => {
    expect(keys(fieldRegions('meal', { hasDate: true }).primary)).toContain('slot');
  });

  /** An undated draft has no time, reminder or repeat to offer, and offers none. */
  it('drops the date-dependent fields entirely while undated', () => {
    const { primary, more } = fieldRegions('task', {});
    expect(keys(primary)).toEqual(['date']);
    expect(keys(more)).toEqual(['notes']);
  });

  /**
   * Removing an unbuilt field must not drag the boundary up with it. Event's split is at
   * `location`; `people` sits below it and is unbuilt, and the fields after `people` must stay
   * inside the disclosure.
   */
  it('anchors the split to the table position, not to what survived', () => {
    const { primary, more } = fieldRegions('event', dated);
    expect(keys(primary)).toEqual(['date', 'time', 'endTime']);
    expect(keys(more)).toEqual([
      'location',
      'reservation',
      'ticketsAndDetails',
      'description',
      'sourceImageLink',
      'reminder',
      'notes',
    ]);
  });
});

/**
 * The four derivations §4 specifies. Each is a **default**, and each applies **only when the
 * other value is unset** — the condition is the rule, not a caveat on it.
 */
describe('meal slot ↔ time', () => {
  it.each([
    ['breakfast', '08:00'],
    ['lunch', '12:30'],
    ['dinner', '19:00'],
  ] as const)('choosing %s with no time set fills %s', (slot, expected) => {
    expect(timeForSlot(slot, undefined, false)).toBe(expected);
  });

  /** Snack has no hour the product is willing to guess. The table says so. */
  it('offers no time for snack', () => {
    expect(timeForSlot('snack', undefined, false)).toBeUndefined();
  });

  it('never overwrites a time the user set', () => {
    expect(timeForSlot('dinner', '20:15', false)).toBe('20:15');
    expect(timeForSlot('breakfast', '10:00', false)).toBe('10:00');
  });

  /**
   * The defect P1-29's UI review surfaced: the app's **own** guess used to block the next one,
   * so picking Breakfast and then Dinner left the meal at 08:00.
   */
  it('re-derives a time it set itself, so a second slot moves it', () => {
    expect(timeForSlot('dinner', '08:00', true)).toBe('19:00');
    expect(timeForSlot('lunch', '08:00', true)).toBe('12:30');
  });

  /** Snack clears a derived time rather than leaving the previous slot's behind. */
  it('clears a derived time when snack is chosen', () => {
    expect(timeForSlot('snack', '12:30', true)).toBeUndefined();
  });

  it.each([
    ['07:30', 'breakfast'],
    ['10:59', 'breakfast'],
    ['11:00', 'lunch'],
    ['12:00', 'lunch'],
    ['14:59', 'lunch'],
    // Snack sits between lunch and dinner: 16:00 is a snack, not an early dinner.
    ['15:00', 'snack'],
    ['16:59', 'snack'],
    ['17:00', 'dinner'],
    ['19:30', 'dinner'],
  ] as const)('entering %s with no slot chosen selects %s', (time, expected) => {
    expect(slotForTime(time, undefined)).toBe(expected);
  });

  it('never overwrites a slot the user chose', () => {
    for (const slot of MEAL_SLOTS) {
      expect(slotForTime('19:30', slot)).toBe(slot);
    }
  });
});

describe('watch kind', () => {
  it('defaults to Movie with nothing entered', () => {
    expect(watchKind(undefined, '', '')).toBe('movie');
  });

  it.each([
    ['a season', '2', ''],
    ['an episode', '', '4'],
    ['both', '2', '4'],
  ])('defaults to Show once %s is entered', (_label, season, episode) => {
    expect(watchKind(undefined, season, episode)).toBe('show');
  });

  /** A default, not a lock: an explicit choice always wins, even against a typed season. */
  it('never overrides an explicit choice', () => {
    expect(watchKind('movie', '2', '4')).toBe('movie');
    expect(watchKind('show', '', '')).toBe('show');
  });

  it('ignores whitespace', () => {
    expect(watchKind(undefined, '  ', ' ')).toBe('movie');
  });
});
