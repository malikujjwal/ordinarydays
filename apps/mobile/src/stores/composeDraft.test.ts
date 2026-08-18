import type { WallDate } from '@od/shared/time';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_DETAILS,
  EMPTY_LOCATION,
  EMPTY_SCHEDULE,
} from '@/features/compose/model/draft';
import { hasContent, useComposeDraft } from './composeDraft';

/**
 * `expo-crypto` is a native module and has no jsdom implementation. Stubbed with a counter so
 * a test can tell "the same key was reused" from "a new key was generated" — the distinction
 * the idempotency rules turn on.
 */
let uuidCounter = 0;
vi.mock('expo-crypto', () => ({
  getRandomBytes: (count: number) =>
    Uint8Array.from({ length: count }, (_, index) => (uuidCounter + index) % 256),
  randomUUID: () => {
    uuidCounter += 1;
    return `uuid-${uuidCounter}`;
  },
}));

const draft = () => useComposeDraft.getState();

beforeEach(() => {
  uuidCounter = 0;
  useComposeDraft.getState().reset();
});

/**
 * The draft store (P1-24).
 *
 * The tests are grouped by the rule each defends, because every one of them is a product
 * rule rather than a mechanism: what a chooser may set, what it may not, and what survives
 * stepping back.
 */

describe('nothing is selected until the user taps', () => {
  it('opens on the object step with no target', () => {
    draft().open();
    expect(draft().step).toBe('object');
    expect(draft().target).toBeUndefined();
  });

  /**
   * The rule this asserts, in full: Plan alone is not a target. A user who taps `Plan` and
   * backs out has chosen nothing, and there is no state in which the app proceeds with
   * `custom` because a kind was never named.
   */
  it('choosing Plan advances to the kind chooser without fixing a target', () => {
    draft().chooseObject('plan');
    expect(draft().step).toBe('planKind');
    expect(draft().target).toBeUndefined();
  });

  it('choosing Task fixes objectKind task and type task in one step', () => {
    draft().chooseObject('task');
    expect(draft().step).toBe('form');
    expect(draft().target).toEqual({ objectKind: 'task', type: 'task' });
  });

  it('choosing a Plan kind is the only way a plan target appears', () => {
    draft().chooseObject('plan');
    draft().choosePlanKind('watch');
    expect(draft().target).toEqual({ objectKind: 'plan', type: 'watch' });
  });

  it('choosing General fixes custom, as an explicit choice', () => {
    draft().chooseObject('plan');
    draft().choosePlanKind('custom');
    expect(draft().target).toEqual({ objectKind: 'plan', type: 'custom' });
  });

  /** `List item` stays visible so the mental model holds, and has no destination in Phase 1. */
  it('choosing List item reaches the form step with no target', () => {
    draft().chooseObject('listItem');
    expect(draft().step).toBe('form');
    expect(draft().target).toBeUndefined();
  });
});

describe("Today's contextual Task action", () => {
  it('fixes the Task target and today date before words are accepted', () => {
    draft().setTitle('an old draft');

    draft().openTodayTask('2026-08-06' as WallDate);

    expect(draft().step).toBe('form');
    expect(draft().target).toEqual({ objectKind: 'task', type: 'task' });
    expect(draft().title).toBe('');
    expect(draft().schedule).toEqual({
      date: '2026-08-06',
      time: undefined,
      endTime: undefined,
      timeFromSlot: false,
    });
  });

  it.each(['Dinner with Alice', 'watch Severance', 'add milk to groceries'])(
    'keeps the labelled Task target when the title is %j',
    (title) => {
      draft().openTodayTask('2026-08-06' as WallDate);
      draft().setTitle(title);

      expect(draft().target).toEqual({ objectKind: 'task', type: 'task' });
      expect(draft().step).toBe('form');
    },
  );
});

describe('typed words never choose anything', () => {
  /**
   * The single most important assertion in this file. Every phrase below is one that a
   * word-matching implementation would act on — and none of them may.
   */
  it.each([
    'Add a task: call the dentist',
    'dinner with Alice on Friday',
    'watch Severance S2 E4',
    'remind me an hour before',
    'add milk to the groceries list',
  ])('leaves the target and step untouched for %j', (text) => {
    draft().open();
    draft().setTitle(text);
    draft().setNotes(text);

    expect(draft().target).toBeUndefined();
    expect(draft().step).toBe('object');
    expect(draft().title).toBe(text);
  });

  it('a source URL cannot fix a target either', () => {
    draft().open();
    draft().setSourceUrl('https://example.com/tickets');
    expect(draft().target).toBeUndefined();
  });

  it('an attached image cannot fix a target either', () => {
    draft().open();
    draft().attachImage('file:///tmp/poster.jpg');
    expect(draft().target).toBeUndefined();
    expect(draft().attachmentUri).toBe('file:///tmp/poster.jpg');
  });
});

describe('back', () => {
  it('returns a Plan form to its kind chooser and unfixes the target', () => {
    draft().chooseObject('plan');
    draft().choosePlanKind('meal');
    draft().setTitle('Chicken tacos');

    draft().back();

    expect(draft().step).toBe('planKind');
    expect(draft().target).toBeUndefined();
  });

  it('returns a Task form to the object chooser', () => {
    draft().chooseObject('task');
    draft().back();
    expect(draft().step).toBe('object');
    expect(draft().target).toBeUndefined();
  });

  it('returns the kind chooser to the object chooser', () => {
    draft().chooseObject('plan');
    draft().back();
    expect(draft().step).toBe('object');
  });

  it('does nothing at the object step', () => {
    draft().open();
    draft().back();
    expect(draft().step).toBe('object');
  });

  /**
   * "Back from a form returns to its chooser without losing compatible draft fields."
   * In Phase 1 the common fields survive every one of the five stored types, so
   * P1-17's mapping is the identity here and nothing is dropped. P1-25 makes that non-trivial.
   */
  it('keeps title, notes and source URL across a target change', () => {
    draft().chooseObject('plan');
    draft().choosePlanKind('meal');
    draft().setTitle('Chicken tacos');
    draft().setNotes('use the blue pan');
    draft().setSourceUrl('https://example.com/recipe');

    draft().back();
    draft().choosePlanKind('event');

    expect(draft().title).toBe('Chicken tacos');
    expect(draft().notes).toBe('use the blue pan');
    expect(draft().sourceUrl).toBe('https://example.com/recipe');
    expect(draft().target).toEqual({ objectKind: 'plan', type: 'event' });
  });
});

describe('Event reservation defaults', () => {
  it('pre-fills reservation name and price currency from the profile', () => {
    draft().chooseObject('plan');
    draft().choosePlanKind('event', { reservationName: 'Ada', currency: 'usd' });

    expect(draft().details.reservation.name).toBe('Ada');
    expect(draft().details.currency).toBe('USD');
  });

  it('tracks the Event start time until a distinct reservation time is entered', () => {
    draft().chooseObject('plan');
    draft().choosePlanKind('event');
    draft().setTime('19:00');
    expect(draft().details.reservation.time).toBe('19:00');

    draft().setDetails({
      reservation: { ...draft().details.reservation, time: '19:30' },
    });
    draft().setTime('20:00');
    expect(draft().details.reservation.time).toBe('19:30');
  });

  it('clears a reservation time that was inherited when the date is cleared', () => {
    draft().chooseObject('plan');
    draft().choosePlanKind('event');
    draft().setDate('2026-08-12');
    draft().setTime('19:00');

    draft().setDate(undefined);

    expect(draft().schedule.time).toBeUndefined();
    expect(draft().details.reservation.time).toBe('');
  });

  it('clears recurrence with its required date', () => {
    draft().chooseObject('task');
    draft().setDate('2026-08-12');
    draft().setRecurrence({
      mode: 'fixed',
      segments: [{ freq: 'daily', interval: 1, effectiveFrom: '2026-08-12' }],
    });

    draft().setDate(undefined);

    expect(draft().recurrence).toBeUndefined();
  });
});

describe('the idempotency key', () => {
  it('is generated once and reused on retries of the same draft', () => {
    draft().chooseObject('task');
    draft().setTitle('Call the dentist');

    const first = draft().takeIdempotencyKey();
    const second = draft().takeIdempotencyKey();

    expect(first).toBe(second);
  });

  /**
   * Regenerating on edit is what stops a fixed typo being deduplicated back to the original
   * body — a bug that only shows up on a retry.
   */
  it.each([
    ['the title changes', () => draft().setTitle('Call the dentist tomorrow')],
    ['the notes change', () => draft().setNotes('bring the referral')],
    ['a link is added', () => draft().setSourceUrl('https://example.com')],
    ['a photo is attached', () => draft().attachImage('file:///tmp/a.jpg')],
    ['the Plan kind changes', () => draft().choosePlanKind('meal')],
  ])('is regenerated when %s', (_label, change) => {
    draft().chooseObject('task');
    draft().setTitle('Call the dentist');
    const first = draft().takeIdempotencyKey();

    change();

    expect(draft().takeIdempotencyKey()).not.toBe(first);
  });

  it('is cleared by reset', () => {
    draft().chooseObject('task');
    draft().setTitle('x');
    draft().takeIdempotencyKey();
    draft().reset();
    expect(draft().idempotencyKey).toBeUndefined();
  });
});

describe('the client activity identity', () => {
  it('mints one permanent act_ ULID and reuses it for the same draft', () => {
    draft().chooseObject('task');
    draft().setTitle('Call the dentist');

    const first = draft().takeActivityId();
    expect(draft().takeActivityId()).toBe(first);
    expect(first).toMatch(/^act_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it('mints a fresh identity when an accepted draft is edited and saved again', () => {
    draft().chooseObject('task');
    draft().setTitle('Call the dentist');
    const first = draft().takeActivityId();

    draft().setTitle('Call the dentist tomorrow');

    expect(draft().activityId).toBeUndefined();
    expect(draft().takeActivityId()).not.toBe(first);
  });

  it('clears the identity on reset', () => {
    draft().takeActivityId();
    draft().reset();
    expect(draft().activityId).toBeUndefined();
  });
});

describe('reset and open', () => {
  it('open clears the previous session so a chooser never inherits a target', () => {
    draft().chooseObject('plan');
    draft().choosePlanKind('event');
    draft().setTitle('Zahav');

    draft().open();

    expect(draft().step).toBe('object');
    expect(draft().target).toBeUndefined();
    expect(draft().title).toBe('');
  });

  it('clearAttachment removes the image', () => {
    draft().attachImage('file:///tmp/a.jpg');
    draft().clearAttachment();
    expect(draft().attachmentUri).toBeUndefined();
  });
});

describe('hasContent', () => {
  const empty = {
    title: '',
    notes: '',
    sourceUrl: undefined,
    attachmentUri: undefined,
    schedule: EMPTY_SCHEDULE,
    location: EMPTY_LOCATION,
    details: EMPTY_DETAILS,
  };

  /**
   * Choosing `Task` and changing your mind is not content. A confirmation for an empty form
   * is how users learn to dismiss dialogs without reading them.
   */
  it('is false for an untouched draft, whatever was chosen', () => {
    draft().chooseObject('task');
    expect(hasContent(draft())).toBe(false);
  });

  it('is false for whitespace alone', () => {
    expect(hasContent({ ...empty, title: '   ', notes: '\n' })).toBe(false);
  });

  it.each([
    ['a title', { ...empty, title: 'x' }],
    ['notes', { ...empty, notes: 'x' }],
    ['a source URL', { ...empty, sourceUrl: 'https://example.com' }],
    ['an attachment', { ...empty, attachmentUri: 'file:///tmp/a.jpg' }],
    // A chosen date is content too: backing out and losing Saturday without being asked is
    // exactly what the discard prompt exists to prevent (P1-25).
    [
      'a date',
      {
        ...empty,
        schedule: {
          date: '2026-08-15',
          time: undefined,
          endTime: undefined,
          timeFromSlot: false,
        },
      },
    ],
    ['a location', { ...empty, location: { label: 'Zahav', address: '' } }],
    ['a typed detail', { ...empty, details: { ...EMPTY_DETAILS, service: 'Netflix' } }],
    [
      'a chosen slot',
      { ...empty, details: { ...EMPTY_DETAILS, mealSlot: 'dinner' as const } },
    ],
  ])('is true for %s', (_label, state) => {
    expect(hasContent(state)).toBe(true);
  });
});
