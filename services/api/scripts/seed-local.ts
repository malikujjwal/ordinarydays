import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { MAX_NOTES_LEN, MAX_TITLE_LEN } from '@od/shared/constants';
import { tableName } from '@od/shared/table';
import type { Activity, User } from '@od/shared/types';
import { createLocalTable, resetLocalTable } from './create-local-table.js';

/**
 * Turns an empty local table into an app with something in it (P1-21).
 *
 * ```bash
 * pnpm seed:local            # idempotent; safe to run any number of times
 * pnpm seed:local -- --reset # drop and rebuild the table first, then seed
 * ```
 *
 * ## Why this exists
 *
 * Screens built against an empty database get built wrong: empty states get all the
 * attention, row density and text truncation get none, and every manual check starts with
 * five minutes of typing.
 *
 * ## It is meant to be read
 *
 * The rows below are **explicit literal objects**, not a generator loop, because a new agent
 * should learn what a well-formed Activity of each type looks like faster here than by
 * reading the schema. The repetition is the feature. `anActivity` fills only the fields that
 * are the same on every row and never the ones that distinguish them.
 *
 * ## Why it writes through the repositories
 *
 * Every row goes through `UserRepository` and `ActivityRepository`, so the seeded data is
 * byte-identical to what the API writes — same GSI1 bucket assignment, same `schemaVersion`,
 * same stamped attributes — and no key is constructed outside `keys.ts`. A script that built
 * its own items would drift from the API the first time either changed, and the drift would
 * show up as a screen that works on seeded data and not on real data.
 */

/**
 * The guard, in the same throw-don't-warn shape as P1-02's startup check.
 *
 * Both conditions, not either: `STAGE` alone would let a mistyped `DDB_ENDPOINT` point a
 * seed at a deployed table, and `DDB_ENDPOINT` alone would let a `prod` build write fixtures
 * into it. A seed script that can reach a real table is a data-loss incident waiting for a
 * typo, and `--reset` makes it a *drop the table* incident.
 */
function assertLocal(): { endpoint: string; name: string } {
  const stage = process.env.STAGE;
  const endpoint = process.env.DDB_ENDPOINT;

  if (stage !== 'local') {
    throw new Error(
      `seed:local refuses to run with STAGE=${stage ?? '(unset)'}. It only ever writes to a local table.`,
    );
  }
  if (endpoint === undefined || endpoint === '') {
    throw new Error(
      'seed:local refuses to run without an explicit DDB_ENDPOINT, so it can never reach a deployed table.',
    );
  }

  return { endpoint, name: process.env.TABLE_NAME ?? tableName('local') };
}

/** The id `LocalIdentityProvider` resolves for the whole of Phases 1–3 (P1-01). */
const DEV_USER = 'usr_local_dev';

/**
 * A fixed `act_` ULID per row, derived from its index.
 *
 * **Deterministic on purpose**: a second run writes the same keys, so it is a set of
 * overwrites rather than a second set of rows. The service's `newActivityId` is monotonic and
 * therefore different every run, which is right for the API and wrong here.
 *
 * The suffix is base-32 over the Crockford alphabet §8 uses, so these are real ULIDs and pass
 * the shared `act_` validator rather than merely looking like ids.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function seededId(index: number): string {
  // 8 + 16 + 2 = the 26 characters a ULID has. Asserted by the integration test, which parses
  // every seeded row with the shared `activity` schema rather than trusting the arithmetic.
  const suffix = `${CROCKFORD[index % 32]}${CROCKFORD[(index * 7) % 32]}`;
  return `act_01J8SEED${'0'.repeat(16)}${suffix}`;
}

/**
 * A fixed `ing_` embedded-row identity, deterministic for the same reason `seededId` is.
 *
 * P3-17 makes `ingredientId` required, which is a **breaking change for stored rows** — and
 * the seed is where that boundary is drawn (§P3-17). Re-running the seed is the migration:
 * this is pre-deploy local data, and inventing an index-derived compatibility id for the old
 * shape would build exactly the position-is-identity fallback the field exists to remove.
 */
function seededIngredientId(activityIndex: number, row: number): string {
  const suffix = `${CROCKFORD[activityIndex % 32]}${CROCKFORD[row % 32]}`;
  return `ing_01J8SEED${'0'.repeat(16)}${suffix}`;
}

/**
 * Dates relative to **today**, so the data stays plausible in six weeks.
 *
 * Only the ids are fixed. That means a given activity moves date as the weeks pass, which is
 * wanted: a seed whose "tomorrow" is a date in 2026 stops exercising Today within a month. A
 * test that needs a fixed date builds its own row, and E2E tests never read seed data
 * (`testing.md` §8.2).
 */
function day(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/** The next Saturday, so "this weekend" is a weekend rather than a fixed offset. */
function weekend(): string {
  const today = new Date();
  return day((6 - today.getUTCDay() + 7) % 7 || 7);
}

const NOW = new Date().toISOString();
const TZ = 'America/New_York';

/**
 * `seed` repeated and cut to exactly `length` characters.
 *
 * The last character is forced to be non-space, because `title` and `notes` are `.trim()`ed
 * by the schema — a string padded to the bound that happens to end in a space arrives one
 * character short, and the row that was meant to test the limit quietly stops testing it.
 */
function atLength(seed: string, length: number): string {
  const filled = seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
  return filled.endsWith(' ') ? `${filled.slice(0, -1)}.` : filled;
}

/**
 * The dev profile.
 *
 * Every optional field is present, so no screen hits an undefined before the form that sets
 * it exists. **`defaultReminderOffset: -15` is a fixture choice, not the product default** —
 * a real new profile omits the field and ships Off (ADR-047). It is set here precisely so the
 * saved-default path is exercised by ordinary use rather than only by a test.
 */
const profile: User = {
  userId: DEV_USER,
  displayName: 'Dev',
  timezone: TZ,
  currency: 'USD',
  weekStartsOn: 0,
  defaultReminderOffset: -15,
  allDayReminderHour: 9,
  quietHours: { enabled: true, start: '22:00', end: '07:00' },
  onboardingState: 'done',
  createdAt: NOW,
  updatedAt: NOW,
  schemaVersion: 1,
};

/**
 * The fields every row shares, and none that distinguish one.
 *
 * Counters, visibility and `icsSequence` are server-derived on a real create; they are stated
 * here because this writes through the repository rather than through the service, and the
 * repository takes a complete `Activity`.
 */
function anActivity(index: number, row: Partial<Activity> & Pick<Activity, 'title'>) {
  return {
    activityId: seededId(index),
    ownerId: DEV_USER,
    status: 'saved',
    objectKind: 'task',
    type: 'task',
    details: { kind: 'task' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: NOW,
    lastActivityAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...row,
  } as Activity;
}

const scheduled = (date: string, time?: string) => ({
  status: 'scheduled' as const,
  schedule: { date, timezone: TZ, ...(time === undefined ? {} : { time }) },
});

/**
 * Twenty-four rows: every Plan kind, every GSI1 bucket a Phase 1 entity can reach, and the
 * content that breaks layouts.
 *
 * Deliberately **not** written: participants, lists, expenses, recurrence, occurrences and
 * attachments. Those entities do not exist yet; Phases 2, 3, 6 and 7 each extend this script
 * in the same pull request as the entity they add (P1-21).
 */
function activities(): Activity[] {
  return [
    // ── Undated Tasks: the `#N` bucket, Today's ANYTIME ──────────────────────────────────
    anActivity(0, { title: 'Submit the insurance form' }),
    anActivity(1, { title: 'Replace the kitchen bulb' }),
    anActivity(2, { title: 'Book a dentist appointment', notes: 'Ask about the crown.' }),

    // ── Undated Plans: the `#P` bucket, Plans → Needs a date ─────────────────────────────
    anActivity(3, {
      title: 'Poconos trip',
      objectKind: 'plan',
      type: 'custom',
      details: { kind: 'custom' },
    }),
    anActivity(4, {
      title: 'Dinner at Zahav',
      objectKind: 'plan',
      type: 'event',
      details: { kind: 'event', reservation: { name: 'Dev' } },
      location: { label: 'Zahav' },
    }),
    anActivity(5, {
      title: 'Watch Severance',
      objectKind: 'plan',
      type: 'watch',
      details: { kind: 'watch', mediaTitle: 'Severance', mediaKind: 'show', season: 2 },
    }),

    // ── Yesterday: Plans → Past, and the overdue path Phase 2 will need ──────────────────
    anActivity(6, { title: 'Return the library books', ...scheduled(day(-1)) }),
    anActivity(7, {
      title: 'Cinema: Paddington',
      objectKind: 'plan',
      type: 'event',
      details: { kind: 'event', description: 'Doors at seven', organiser: 'The Ritz' },
      ...scheduled(day(-1), '19:00'),
    }),

    // ── Today: timed, untimed, and one already in the past hour ──────────────────────────
    anActivity(8, { title: 'Stand-up', ...scheduled(day(0), '09:30') }),
    anActivity(9, { title: 'Water the plants', ...scheduled(day(0)) }),
    anActivity(10, {
      title: 'Chicken tacos',
      objectKind: 'plan',
      type: 'meal',
      details: {
        kind: 'meal',
        mealSlot: 'dinner',
        recipeUrl: 'https://example.com/tacos',
      },
      ...scheduled(day(0), '19:30'),
    }),
    anActivity(11, {
      title: 'Coffee with Sam',
      objectKind: 'plan',
      type: 'event',
      details: { kind: 'event' },
      location: { label: 'Elixr' },
      ...scheduled(day(0), '08:00'),
    }),

    // ── Tomorrow ─────────────────────────────────────────────────────────────────────────
    anActivity(12, { title: 'Pay the water bill', ...scheduled(day(1)) }),
    anActivity(13, {
      title: 'Gym',
      ...scheduled(day(1), '07:00'),
    }),
    anActivity(14, {
      title: 'Team lunch',
      objectKind: 'plan',
      type: 'meal',
      details: { kind: 'meal', mealSlot: 'lunch' },
      ...scheduled(day(1), '12:30'),
    }),

    // ── This weekend ─────────────────────────────────────────────────────────────────────
    anActivity(15, {
      title: 'Farmers market',
      objectKind: 'plan',
      type: 'event',
      details: { kind: 'event' },
      location: { label: 'Headhouse Square' },
      ...scheduled(weekend(), '10:00'),
    }),
    anActivity(16, { title: 'Change the car oil', ...scheduled(weekend()) }),

    // ── Three weeks out ──────────────────────────────────────────────────────────────────
    anActivity(17, {
      title: 'Flights to Lisbon',
      objectKind: 'plan',
      type: 'event',
      details: { kind: 'event', priceCents: 48_900, currency: 'USD' },
      ...scheduled(day(21), '06:15'),
    }),
    anActivity(18, { title: 'Renew the passport', ...scheduled(day(21)) }),

    // ── The rows that break layouts, which should exist before the layout does ───────────
    anActivity(19, {
      // Exactly at the bound, derived from the constant rather than counted by hand — a
      // literal padded to 200 by eye is a literal that stops being 200 when the copy changes.
      title: atLength(
        'A title that runs to the very limit the schema allows — ',
        MAX_TITLE_LEN,
      ),
      ...scheduled(day(2)),
    }),
    anActivity(20, {
      title: 'Notes at the maximum',
      notes: atLength('Lorem ipsum dolor sit amet. ', MAX_NOTES_LEN),
    }),
    anActivity(21, {
      title: 'Big shop',
      objectKind: 'plan',
      type: 'meal',
      details: {
        kind: 'meal',
        mealSlot: 'dinner',
        ingredients: Array.from({ length: 60 }, (_, i) => ({
          ingredientId: seededIngredientId(21, i),
          name: `Ingredient ${i + 1}`,
          quantity: `${i + 1} g`,
        })),
      },
      ...scheduled(day(3), '18:00'),
    }),
    anActivity(22, {
      title: 'Parents evening',
      objectKind: 'plan',
      type: 'event',
      details: { kind: 'event', organiser: 'Northside Primary' },
      location: {
        label: 'Northside Primary',
        address: '1400 Fairmount Ave, Philadelphia, PA 19130',
      },
      ...scheduled(day(4), '17:45'),
    }),
    anActivity(23, {
      title: 'Cancelled: rooftop drinks',
      objectKind: 'plan',
      type: 'event',
      details: { kind: 'event' },
      location: { label: 'Bok Bar' },
      // `scheduled` sets `status: 'scheduled'`, so the cancellation comes **after** the
      // spread. A cancelled plan keeps its date — that is what makes it render as cancelled
      // on the day it was going to happen rather than vanishing.
      ...scheduled(day(5), '18:30'),
      status: 'cancelled',
    }),
  ];
}

export interface SeedResult {
  readonly profile: string;
  readonly activities: number;
  readonly reset: boolean;
}

/**
 * Writes the profile and every activity.
 *
 * **Idempotent by key, not by check.** Each write is an unconditional put of a row whose id
 * is derived from its index, so a second run overwrites the first rather than appending.
 * There is no "does it exist" read anywhere — that would be slower and would still race.
 */
export async function seedLocal(options: { reset?: boolean } = {}): Promise<SeedResult> {
  const { endpoint, name } = assertLocal();

  const admin = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint,
    credentials: { accessKeyId: 'local', secretAccessKey: 'localsecret' },
  });

  try {
    if (options.reset === true) {
      await resetLocalTable(admin, name);
    } else {
      await createLocalTable(admin, name);
    }
  } finally {
    admin.destroy();
  }

  /**
   * Imported **after** the table exists and after the guard has run, because both
   * repositories reach `lib/ddb.ts`, which builds its client from the environment at module
   * load. A top-level import would construct that client before `assertLocal` could refuse.
   */
  const users = await import('../src/repositories/userRepository.js');
  const rows = await import('../src/repositories/activityRepository.js');

  await users.putProfile(profile);

  const seeded = activities();
  for (const activity of seeded) {
    /**
     * **Skip what is already there.** This script promises to be safe to run any number of
     * times, and it used to keep that promise by accident: `createActivity` wrote
     * unconditionally, so a second run overwrote each fixture with an identical copy.
     *
     * P2-49 made that write conditional on `attribute_not_exists(pk)` — the guard that stops
     * a replayed client-minted create from overwriting somebody's activity — so the second
     * run now collides on every fixture id. Checking first restores idempotency without
     * softening the guard, which is the half that matters. Deleting and recreating would be
     * worse still: a delete leaves a tombstone, and the tombstone would then block the
     * recreate.
     */
    if ((await rows.getActivityMeta(activity.activityId)) !== undefined) continue;
    await rows.createActivity(DEV_USER, activity);
  }

  return {
    profile: profile.userId,
    activities: seeded.length,
    reset: options.reset === true,
  };
}

/** Run only when invoked directly, so the integration test can import `seedLocal` instead. */
if (process.argv[1]?.includes('seed-local')) {
  seedLocal({ reset: process.argv.includes('--reset') })
    .then((result) => {
      console.log(
        `Seeded ${result.activities} activities and the ${result.profile} profile${
          result.reset ? ' into a freshly rebuilt table' : ''
        }.`,
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
