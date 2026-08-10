import { describe, expect, it } from 'vitest';
import type { ActivityDetails, ActivityType } from '../types/index.js';
import {
  blockerMessage,
  type ChangeSource,
  type ChangeTarget,
  changeActivityKind,
} from './changeActivityKind.js';

/**
 * `activities.md` §6.3 point 5, asserted pair by pair.
 *
 * The table is the contract, so the tests are transcribed from it rather than derived from
 * the implementation — a derivation would agree with whatever the code does, which is the
 * one thing worth checking.
 */

const TYPES: ActivityType[] = ['task', 'meal', 'watch', 'event', 'custom'];

const targetFor = (type: ActivityType): ChangeTarget =>
  type === 'task' ? { objectKind: 'task', type: 'task' } : { objectKind: 'plan', type };

/** A fully-populated `details` per kind, so every droppable field is present to be dropped. */
const fullDetails: Record<ActivityType, ActivityDetails> = {
  task: { kind: 'task' },
  meal: {
    kind: 'meal',
    mealSlot: 'dinner',
    recipeUrl: 'https://example.com/tacos',
    ingredients: [{ name: 'Tortillas' }, { name: 'Chicken' }],
  },
  watch: {
    kind: 'watch',
    mediaTitle: 'Severance',
    mediaKind: 'show',
    season: 2,
    episode: 4,
    episodeTitle: 'Woe’s Hollow',
    service: 'Apple TV+',
  },
  event: {
    kind: 'event',
    description: 'Doors at seven',
    priceCents: 4500,
    currency: 'USD',
    ticketUrl: 'https://example.com/tickets',
    organiser: 'The Barbican',
    reservation: { name: 'Ada', time: '19:30', partySize: 4, reference: 'ABC123' },
  },
  custom: { kind: 'custom' },
};

const source = (
  type: ActivityType,
  overrides: Partial<ChangeSource> = {},
): ChangeSource => ({
  title: 'Severance',
  objectKind: type === 'task' ? 'task' : 'plan',
  type,
  details: fullDetails[type],
  participantCount: 0,
  expenseTotalCents: 0,
  childCount: 0,
  ...overrides,
});

const keys = (from: ActivityType, to: ActivityType) =>
  changeActivityKind(source(from), targetFor(to)).dropped.map((field) => field.key);

/**
 * All 25 ordered pairs, generated from the type list rather than written out — so a sixth
 * activity type cannot be added without this failing until its row is considered.
 */
const ALL_PAIRS = TYPES.flatMap((from) => TYPES.map((to) => [from, to] as const));

describe('every ordered pair is covered', () => {
  it('is 25 pairs, and the list is generated from the types themselves', () => {
    expect(ALL_PAIRS).toHaveLength(25);
  });

  it.each(ALL_PAIRS)(
    '%s → %s returns the target exactly and never throws',
    (from, to) => {
      const result = changeActivityKind(source(from), targetFor(to));

      expect(result.type).toBe(to);
      expect(result.objectKind).toBe(to === 'task' ? 'task' : 'plan');
      // `details.kind` always equals `type` — the invariant that makes "a meal with watch
      // fields" unrepresentable.
      expect(result.details.kind).toBe(to);
    },
  );
});

/**
 * **An identity pair is a no-op**, and the table's `→ any` rows do not include it.
 *
 * Read literally they would: `watch → watch` would report the season and episode as lost and
 * return an emptied `details`, destroying a user's data for a request that changed nothing.
 * §6.3's own rule settles it — "keeps `details` fields that still apply and drops the rest",
 * and every field on a Watch still applies to a Watch.
 *
 * Not hypothetical: `PATCH /v1/activities/:id` takes `objectKind` and `type` as a pair, and a
 * form re-sending the current values alongside a title edit is ordinary.
 */
describe('changing a kind to itself', () => {
  it.each(TYPES)('%s → %s keeps the details untouched and drops nothing', (type) => {
    const input = source(type);
    const result = changeActivityKind(input, targetFor(type));

    expect(result.details).toEqual(input.details);
    expect(result.dropped).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  it('does not re-seed mediaTitle from the title, which would overwrite it', () => {
    const renamed = source('watch', {
      title: 'Something else',
      details: { kind: 'watch', mediaTitle: 'Severance', season: 2 },
    });

    expect(changeActivityKind(renamed, targetFor('watch')).details).toEqual({
      kind: 'watch',
      mediaTitle: 'Severance',
      season: 2,
    });
  });

  it('leaves an existing location and notes exactly as they were', () => {
    const input = source('event', {
      notes: 'Ask for the terrace',
      location: { label: 'Home' },
    });
    const result = changeActivityKind(input, targetFor('event'));

    expect(result.notes).toBe('Ask for the terrace');
    expect(result.location).toEqual({ label: 'Home' });
  });

  /** Still a no-op even when the plan has coordinated data hanging off it. */
  it('never blocks, whatever the counts', () => {
    const busy = source('custom', {
      participantCount: 5,
      expenseTotalCents: 9900,
      childCount: 3,
    });

    expect(changeActivityKind(busy, targetFor('custom')).blockers).toEqual([]);
  });
});

/** `watch → any other kind`: the whole payload goes. §6.3's table row, transcribed. */
describe('watch → any', () => {
  it.each(TYPES.filter((type) => type !== 'watch'))(
    'drops the watch payload for %s',
    (to) => {
      expect(keys('watch', to).sort()).toEqual([
        'watch.episodeTitle',
        'watch.mediaKind',
        'watch.seasonEpisode',
        'watch.service',
      ]);
    },
  );

  /**
   * `mediaTitle` is **not** reported as dropped: `any → watch` seeded it from `title`, and
   * `title` survives every change. Listing it would tell the user they are losing something
   * that is still on the screen.
   */
  it('does not report mediaTitle as a loss, because title survives', () => {
    expect(keys('watch', 'meal')).not.toContain('watch.mediaTitle');
  });

  it('labels season and episode as one thing, the way a user reads them', () => {
    const [first] = changeActivityKind(
      source('watch'),
      targetFor('event'),
    ).dropped.filter((field) => field.key === 'watch.seasonEpisode');

    expect(first?.label).toBe('Season and episode (S2 E4)');
  });

  it('labels a season with no episode without a dangling E', () => {
    const partial = source('watch', {
      details: { kind: 'watch', mediaTitle: 'Severance', season: 2 },
    });

    expect(changeActivityKind(partial, targetFor('meal')).dropped[0]?.label).toBe(
      'Season and episode (S2)',
    );
  });

  it('reports nothing for fields the source never had', () => {
    const bare = source('watch', { details: { kind: 'watch', mediaTitle: 'Severance' } });

    expect(changeActivityKind(bare, targetFor('meal')).dropped).toEqual([]);
  });
});

/** `meal → any`: slot, recipe and ingredients. */
describe('meal → any', () => {
  it.each(TYPES.filter((type) => type !== 'meal'))(
    'drops the meal payload for %s',
    (to) => {
      expect(keys('meal', to).sort()).toEqual([
        'meal.ingredients',
        'meal.mealSlot',
        'meal.recipeUrl',
      ]);
    },
  );

  /** The table says grocery items already created keep their provenance — say so in the copy. */
  it('says that grocery items already added survive', () => {
    const [ingredients] = changeActivityKind(
      source('meal'),
      targetFor('task'),
    ).dropped.filter((field) => field.key === 'meal.ingredients');

    expect(ingredients?.label).toContain('2 ingredients');
    expect(ingredients?.label).toContain('already added stay');
  });

  it('reports no ingredients row for an empty list', () => {
    const empty = source('meal', { details: { kind: 'meal', ingredients: [] } });

    expect(changeActivityKind(empty, targetFor('task')).dropped).toEqual([]);
  });
});

/**
 * `event → any`: `description` is carried into notes; commerce and reservation fields are
 * named destructive losses.
 */
describe('event → any', () => {
  /**
   * The table lists four dropped fields and this asserts three rows: `priceCents` and
   * `currency` are one thing to a user — `Price (45.00 USD)` — so the confirmation shows one
   * line, not two. The keys are confirmation rows, not a mirror of the stored shape.
   */
  it.each(TYPES.filter((type) => type !== 'event'))(
    'drops tickets, organiser and populated reservation fields for %s',
    (to) => {
      expect(keys('event', to).sort()).toEqual([
        'event.organiser',
        'event.price',
        'event.reservation.name',
        'event.reservation.partySize',
        'event.reservation.reference',
        'event.reservation.time',
        'event.ticketUrl',
      ]);
    },
  );

  it('appends description to notes, separated by a blank line', () => {
    const withNotes = source('event', { notes: 'Bring the tickets' });

    expect(changeActivityKind(withNotes, targetFor('meal')).notes).toBe(
      'Bring the tickets\n\nDoors at seven',
    );
  });

  /** No leading blank line when there were no notes — "if `notes` is non-empty", read literally. */
  it('becomes the notes outright when there were none', () => {
    expect(changeActivityKind(source('event'), targetFor('meal')).notes).toBe(
      'Doors at seven',
    );
  });

  it('leaves notes alone when there is no description', () => {
    const bare = source('event', {
      notes: 'Bring the tickets',
      details: { kind: 'event' },
    });

    expect(changeActivityKind(bare, targetFor('task')).notes).toBe('Bring the tickets');
  });

  it('formats the price with its currency', () => {
    const [price] = changeActivityKind(source('event'), targetFor('task')).dropped.filter(
      (field) => field.key === 'event.price',
    );

    expect(price?.label).toBe('Price (45.00 USD)');
  });
  it('names each populated reservation field in the confirmation payload', () => {
    const labels = changeActivityKind(source('event'), targetFor('custom'))
      .dropped.filter((field) => field.key.startsWith('event.reservation.'))
      .map((field) => field.label);

    expect(labels).toEqual([
      'Reservation name (Ada)',
      'Reservation time (19:30)',
      'Party size (4)',
      'Reservation reference (ABC123)',
    ]);
  });
});

/**
 * `any → watch` seeds its required field from `title`.
 *
 * The identity pair is excluded from both: seeding is what a *change into* a kind does, and
 * `watch → watch` keeps the `mediaTitle` the user already set rather than overwriting it with
 * the activity title. That case has its own block above.
 */
describe('the carry into Watch', () => {
  it.each(TYPES.filter((type) => type !== 'watch'))(
    '%s → watch sets mediaTitle from the title',
    (from) => {
      const result = changeActivityKind(
        source(from, { title: 'Paddington' }),
        targetFor('watch'),
      );

      expect(result.details).toMatchObject({ kind: 'watch', mediaTitle: 'Paddington' });
    },
  );
});

/** `task ↔ custom` drops no type-specific user data, so no confirmation is shown at all. */
describe('the additive pairs', () => {
  it.each([
    ['task', 'custom'],
    ['custom', 'task'],
  ] as const)('%s → %s drops nothing', (from, to) => {
    expect(changeActivityKind(source(from), targetFor(to)).dropped).toEqual([]);
  });

  it.each(TYPES.filter((type) => type !== 'task'))(
    'task → %s carries the common fields and drops nothing',
    (to) => {
      const task = source('task', { title: 'Trip', notes: 'Pack light' });
      const result = changeActivityKind(task, targetFor(to));

      expect(result.dropped).toEqual([]);
      expect(result.notes).toBe('Pack light');
      expect(result.objectKind).toBe('plan');
      expect(result.type).toBe(to);
    },
  );
});

/**
 * §6.3 point 3: Plan → Task is available only at zero participants, zero expenses and zero
 * prep children. The conversion **never deletes coordinated data as a side effect** — it
 * reports what the user must remove.
 */
describe('Plan → Task blockers', () => {
  const plan = (overrides: Partial<ChangeSource>) =>
    changeActivityKind(source('custom', overrides), targetFor('task'));

  it('is unblocked when all three counts are zero', () => {
    expect(plan({}).blockers).toEqual([]);
  });

  it('blocks on participants alone', () => {
    expect(plan({ participantCount: 2 }).blockers).toEqual([
      { section: 'people', count: 2, label: '2 people' },
    ]);
  });

  it('blocks on expenses alone', () => {
    expect(plan({ expenseTotalCents: 1500 }).blockers.map((b) => b.section)).toEqual([
      'expenses',
    ]);
  });

  it('blocks on prep children alone', () => {
    expect(plan({ childCount: 3 }).blockers).toEqual([
      { section: 'prep', count: 3, label: '3 prep tasks' },
    ]);
  });

  it('blocks on all three together, naming each', () => {
    const blockers = plan({
      participantCount: 2,
      expenseTotalCents: 1500,
      childCount: 1,
    }).blockers;

    expect(blockers.map((b) => b.section)).toEqual(['people', 'expenses', 'prep']);
  });

  it('singularises one person and one prep task', () => {
    const blockers = plan({ participantCount: 1, childCount: 1 }).blockers;

    expect(blockers.map((b) => b.label)).toEqual(['1 person', '1 prep task']);
  });

  /** A negative total is still a balance that exists — a refund is not "no expenses". */
  it('blocks on a negative expense total', () => {
    expect(plan({ expenseTotalCents: -500 }).blockers.map((b) => b.section)).toEqual([
      'expenses',
    ]);
  });

  /** A Plan-kind change is never blocked: nothing coordinated is lost by it. */
  it.each(['meal', 'watch', 'event', 'custom'] as const)(
    'never blocks a plan-kind change to %s, whatever the counts',
    (to) => {
      const busy = source('event', {
        participantCount: 5,
        expenseTotalCents: 9900,
        childCount: 3,
      });

      expect(changeActivityKind(busy, targetFor(to)).blockers).toEqual([]);
    },
  );

  /** Task → Plan cannot be blocked — a Task has none of the three by construction. */
  it('never blocks task → plan', () => {
    const task = source('task', { participantCount: 0, childCount: 0 });

    expect(changeActivityKind(task, targetFor('event')).blockers).toEqual([]);
  });
});

/** The sentence §6.3 point 3 specifies, built once so server and client say the same words. */
describe('blockerMessage', () => {
  it('is undefined when nothing blocks', () => {
    expect(blockerMessage([])).toBeUndefined();
  });

  it('matches the example in the product doc', () => {
    const blockers = changeActivityKind(
      source('custom', { participantCount: 2, expenseTotalCents: 1500 }),
      targetFor('task'),
    ).blockers;

    expect(blockerMessage(blockers)).toBe(
      'Remove 2 people and the expenses on it before changing this to a Task.',
    );
  });

  it('reads without a comma for a single blocker', () => {
    expect(blockerMessage([{ section: 'prep', count: 1, label: '1 prep task' }])).toBe(
      'Remove 1 prep task before changing this to a Task.',
    );
  });

  it('uses commas and a final and for three', () => {
    const blockers = changeActivityKind(
      source('custom', { participantCount: 2, expenseTotalCents: 1500, childCount: 1 }),
      targetFor('task'),
    ).blockers;

    expect(blockerMessage(blockers)).toBe(
      'Remove 2 people, the expenses on it and 1 prep task before changing this to a Task.',
    );
  });
});

/**
 * §6.3 point 8: **no conversion changes `status`, `completedAt` or `outcome`.** They are
 * absent from the result type, so a caller cannot pass them through by accident — an Event
 * that changes kind stays completed with its historical `outcome: 'attended'`
 * because this function never had the chance to touch them.
 */
describe('what the result deliberately does not carry', () => {
  it.each(ALL_PAIRS)('%s → %s returns no status, completedAt or outcome', (from, to) => {
    const result = changeActivityKind(source(from), targetFor(to));

    expect(result).not.toHaveProperty('status');
    expect(result).not.toHaveProperty('completedAt');
    expect(result).not.toHaveProperty('outcome');
  });
});

/**
 * Purity, asserted rather than assumed — it is what lets the client run this to preview a
 * write that has not happened.
 */
describe('the function is pure', () => {
  it.each(ALL_PAIRS)('%s → %s gives a deep-equal answer twice', (from, to) => {
    const input = source(from);

    expect(changeActivityKind(input, targetFor(to))).toEqual(
      changeActivityKind(input, targetFor(to)),
    );
  });

  it('does not mutate its input', () => {
    const input = source('event', { notes: 'Ask for the terrace' });
    const before = structuredClone(input);

    changeActivityKind(input, targetFor('meal'));

    expect(input).toEqual(before);
  });

  it('does not hand back a reference into the input', () => {
    const input = source('event', { location: { label: 'Luca' } });
    const result = changeActivityKind(input, targetFor('meal'));

    expect(result.details).not.toBe(input.details);
    expect(result.location).not.toBe(input.location);
  });
});
