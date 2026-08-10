import type { Activity } from '@od/shared/types';
import { beforeAll, describe, expect, it } from 'vitest';
import { useTestTable } from './harness.js';

/**
 * `ActivityRepository` against a real DynamoDB Local.
 *
 * The unit suite proves the commands are composed correctly. This proves the questions only
 * a database answers: that a `begins_with` on the index actually returns those rows and no
 * others, that a bucket move leaves **one** entry rather than two, that a stale `updatedAt`
 * really cancels the write, and — the one that matters most — that two users' activities are
 * invisible to each other.
 */
useTestTable();

type Repo = typeof import('../../src/repositories/activityRepository.js');
type Base = typeof import('../../src/repositories/base.js');
type Keys = typeof import('../../src/repositories/keys.js');
type Tx = typeof import('../../src/repositories/tx.js');

let repo: Repo;
let base: Base;
let keys: Keys;
let tx: Tx;

/** Two invented users. Neither needs a profile — the keys are what is under test. */
const ALICE = 'usr_int_repo_alice';
const BEN = 'usr_int_repo_ben';

/**
 * A fresh activity id per call (`data-model.md` §8's Crockford alphabet, which excludes I, L,
 * O and U).
 *
 * A plain counter is enough now that the table is this file's alone and empty at the start of
 * every test. It was not before: this generator used to mix in a random per-run tag, because
 * an `ACT#<id>` partition on the shared table survived the run that wrote it, so the same id
 * at the same sequence position inherited the previous run's rows — which is how, in P1-10,
 * adding one case above `writes exactly two items for a weekly series` made it fail on three
 * `OCC#` rows it had never written. P1-28's table-per-file removed the cause, so the
 * workaround is gone rather than kept as decoration.
 */
let seq = 0;
/** `act_` + 26: 22 fixed characters and a 4-digit counter. */
const nextId = () => `act_01J8XKQ2M4N5P6R7S8T9V0${String(seq++).padStart(4, '0')}`;

const anActivity = (overrides: Partial<Activity> = {}): Activity =>
  ({
    activityId: nextId(),
    ownerId: ALICE,
    objectKind: 'task',
    type: 'task',
    status: 'saved',
    title: 'Buy milk',
    details: { kind: 'task' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: '2026-08-08T10:00:00.000Z',
    lastActivityAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  }) as Activity;

beforeAll(async () => {
  repo = await import('../../src/repositories/activityRepository.js');
  base = await import('../../src/repositories/base.js');
  keys = await import('../../src/repositories/keys.js');
  tx = await import('../../src/repositories/tx.js');
});

describe('create and read back', () => {
  it('round-trips the stored shape', async () => {
    const subject = anActivity({ notes: 'Semi-skimmed' });
    await repo.createActivity(ALICE, subject);

    const stored = await repo.getActivityMeta(subject.activityId);

    expect(stored).toMatchObject({
      activityId: subject.activityId,
      objectKind: 'task',
      type: 'task',
      title: 'Buy milk',
      notes: 'Semi-skimmed',
      ownerId: ALICE,
      schemaVersion: 1,
    });
  });

  /**
   * Access patterns 4 and 4b are the **same query**, unfiltered. The plan-detail projection
   * drops other users' `REM#` rows (P1-10 rule 6) and the Phase 5 scheduler keeps them all;
   * a repository that filtered here would make the scheduler need a second read.
   */
  it('returns the whole partition in one Query, reminders included', async () => {
    const subject = anActivity();
    await repo.createActivity(ALICE, subject, {
      reminders: [{ reminderId: 'rem_1', offsetMinutes: -15 }],
    });

    const partition = await repo.getActivityPartition(subject.activityId);

    expect(partition.map((item) => item.sk).sort()).toEqual([
      'META',
      `REM#${ALICE}#rem_1`,
    ]);
  });

  it('writes a REM# row per reminder, each carrying the creator’s userId', async () => {
    const subject = anActivity();
    await repo.createActivity(ALICE, subject, {
      reminders: [
        { reminderId: 'rem_1', offsetMinutes: -15 },
        { reminderId: 'rem_2', offsetMinutes: -60 },
      ],
    });

    const reminders = (await repo.getActivityPartition(subject.activityId)).filter(
      (item) => (item.sk as string).startsWith('REM#'),
    );

    expect(reminders).toHaveLength(2);
    expect(reminders.every((row) => row.userId === ALICE)).toBe(true);
  });

  it('writes the parent’s SUB# pointer, so prep tasks come from the parent’s own Query', async () => {
    const parent = anActivity({
      objectKind: 'plan',
      type: 'custom',
      details: { kind: 'custom' },
    } as Partial<Activity>);
    await repo.createActivity(ALICE, parent);

    const child = anActivity({
      parentActivityId: parent.activityId,
      title: 'Book hotel',
    });
    await repo.createActivity(ALICE, child);

    const pointers = await repo.listChildPointers(parent.activityId);

    expect(pointers).toHaveLength(1);
    expect(pointers[0]).toMatchObject({
      childActivityId: child.activityId,
      title: 'Book hotel',
      status: 'saved',
    });
  });

  /**
   * `listParticipants`, added in P1-10 for `assertActivityAccess` (access pattern 4's
   * partition, read by prefix).
   *
   * **Phase 1 writes no `PART#` row**, so the case worth proving against a real table is that
   * the prefix query returns an empty list rather than the `META` and `REM#` rows that share
   * the partition — a `begins_with` on the wrong prefix would happily return them, and the
   * authorisation check would then admit anybody whose partition had any row in it at all.
   */
  it('reads no participants from a partition that has other rows in it', async () => {
    const subject = anActivity({ title: 'Dinner' });
    await repo.createActivity(ALICE, subject, {
      reminders: [{ reminderId: 'rem_01J8XKQ2M4N5P6R7S8T9V0W1AA', offsetMinutes: -15 }],
    });

    expect(await repo.getActivityPartition(subject.activityId)).not.toHaveLength(0);
    expect(await repo.listParticipants(subject.activityId)).toEqual([]);
  });
});

/**
 * All four buckets, against the live index. The `#N`-versus-`#P` pair is the one that proves
 * they are not collapsed: same undated title, and only the user's Task-versus-Plan choice
 * separates them.
 */
describe('bucket assignment', () => {
  const scheduled = { date: '2026-08-15', timezone: 'America/New_York', time: '19:30' };
  const series = {
    mode: 'fixed' as const,
    segments: [{ freq: 'weekly' as const, effectiveFrom: '2026-08-01' }],
  };

  it('puts a dated activity in #S', async () => {
    await repo.createActivity(ALICE, anActivity({ schedule: scheduled }));
    expect((await repo.listByBucket(ALICE, 'S')).items).toHaveLength(1);
  });

  it('puts the same undated title in #N as a Task and #P as a Plan', async () => {
    await repo.createActivity(ALICE, anActivity({ title: 'Dinner at Zahav' }));
    await repo.createActivity(
      ALICE,
      anActivity({
        title: 'Dinner at Zahav',
        objectKind: 'plan',
        type: 'event',
        details: { kind: 'event' },
      } as Partial<Activity>),
    );

    expect((await repo.listByBucket(ALICE, 'N')).items).toHaveLength(1);
    expect((await repo.listByBucket(ALICE, 'P')).items).toHaveLength(1);
  });

  it('puts a recurring series in #R even when it has a date', async () => {
    await repo.createActivity(
      ALICE,
      anActivity({ recurrence: series, schedule: scheduled }),
    );

    expect((await repo.listByBucket(ALICE, 'R')).items).toHaveLength(1);
    expect((await repo.listByBucket(ALICE, 'S')).items).toHaveLength(0);
  });

  it('reads a date window from #S (access pattern 1)', async () => {
    await repo.createActivity(
      ALICE,
      anActivity({ schedule: { ...scheduled, date: '2026-08-10' } }),
    );
    await repo.createActivity(
      ALICE,
      anActivity({ schedule: { ...scheduled, date: '2026-09-10' } }),
    );

    const august = await repo.listByBucket(ALICE, 'S', {
      between: ['2026-08-01T00:00', '2026-08-31T23:59'],
    });

    expect(august.items).toHaveLength(1);
  });
});

describe('lastActivityAt ordering', () => {
  it('returns an older touched Needs-a-date Plan before a newer untouched one', async () => {
    const older = anActivity({
      objectKind: 'plan',
      type: 'custom',
      details: { kind: 'custom' },
      title: 'Older plan',
      createdAt: '2026-08-01T10:00:00.000Z',
      lastActivityAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    } as Partial<Activity>);
    const newer = anActivity({
      objectKind: 'plan',
      type: 'custom',
      details: { kind: 'custom' },
      title: 'Newer plan',
      createdAt: '2026-08-02T10:00:00.000Z',
      lastActivityAt: '2026-08-02T10:00:00.000Z',
      updatedAt: '2026-08-02T10:00:00.000Z',
    } as Partial<Activity>);
    await repo.createActivity(ALICE, older);
    await repo.createActivity(ALICE, newer);
    const items: Parameters<typeof repo.touchLastActivity>[3] = [];
    repo.touchLastActivity(older, '2026-08-03T10:00:00.000Z', [ALICE], items);
    await tx.transactWrite(items, { operation: 'touchLastActivityTest' });

    const page = await repo.listByBucket(ALICE, 'P', { ascending: false });

    expect(page.items.map((item) => item.title)).toEqual(['Older plan', 'Newer plan']);
  });
});

/**
 * A stale entry left in the old bucket is a ghost row on Today with no obvious cause,
 * discovered in Phase 2 and blamed on the agenda. The count after the move is the assertion.
 */
describe('a bucket-changing write leaves exactly one index entry', () => {
  const countAll = async (userId: string) => {
    const buckets = await Promise.all(
      (['S', 'P', 'N', 'R'] as const).map((bucket) => repo.listByBucket(userId, bucket)),
    );
    return buckets.reduce((total, page) => total + page.items.length, 0);
  };

  it('moves #N → #S when a date is set', async () => {
    const before = anActivity();
    await repo.createActivity(ALICE, before);

    const after = {
      ...before,
      schedule: { date: '2026-08-15', timezone: 'UTC' },
      updatedAt: '2026-08-08T11:00:00.000Z',
    } as Activity;
    await repo.patchActivity(ALICE, after, before.updatedAt, { previous: before });

    expect(await countAll(ALICE)).toBe(1);
    expect((await repo.listByBucket(ALICE, 'S')).items).toHaveLength(1);
    expect((await repo.listByBucket(ALICE, 'N')).items).toHaveLength(0);
  });

  it('moves #N → #P when the object kind is explicitly changed', async () => {
    const before = anActivity();
    await repo.createActivity(ALICE, before);

    const after = {
      ...before,
      objectKind: 'plan',
      type: 'custom',
      details: { kind: 'custom' },
      updatedAt: '2026-08-08T11:00:00.000Z',
    } as Activity;
    await repo.patchActivity(ALICE, after, before.updatedAt, { previous: before });

    expect(await countAll(ALICE)).toBe(1);
    expect((await repo.listByBucket(ALICE, 'P')).items).toHaveLength(1);
  });

  it('moves #S → #N when the date is cleared', async () => {
    const before = anActivity({ schedule: { date: '2026-08-15', timezone: 'UTC' } });
    await repo.createActivity(ALICE, before);

    const { schedule: _dropped, ...rest } = before;
    const after = { ...rest, updatedAt: '2026-08-08T11:00:00.000Z' } as Activity;
    await repo.patchActivity(ALICE, after, before.updatedAt, { previous: before });

    expect(await countAll(ALICE)).toBe(1);
    expect((await repo.listByBucket(ALICE, 'N')).items).toHaveLength(1);
  });

  it('schedules an undated Plan from #P to #S with exactly one index entry', async () => {
    const before = anActivity({
      objectKind: 'plan',
      type: 'custom',
      details: { kind: 'custom' },
    } as Partial<Activity>);
    await repo.createActivity(ALICE, before);

    const after = {
      ...before,
      schedule: { date: '2026-08-15', timezone: 'UTC' },
      updatedAt: '2026-08-08T11:00:00.000Z',
    } as Activity;
    await repo.patchActivity(ALICE, after, before.updatedAt, { previous: before });

    expect(await countAll(ALICE)).toBe(1);
    expect((await repo.listByBucket(ALICE, 'P')).items).toHaveLength(0);
    expect((await repo.listByBucket(ALICE, 'S')).items).toHaveLength(1);
  });

  it('unschedules a Plan from #S to #P with exactly one index entry', async () => {
    const before = anActivity({
      objectKind: 'plan',
      type: 'event',
      details: { kind: 'event' },
      schedule: { date: '2026-08-15', timezone: 'UTC' },
    } as Partial<Activity>);
    await repo.createActivity(ALICE, before);

    const { schedule: _dropped, ...rest } = before;
    const after = { ...rest, updatedAt: '2026-08-08T11:00:00.000Z' } as Activity;
    await repo.patchActivity(ALICE, after, before.updatedAt, { previous: before });

    expect(await countAll(ALICE)).toBe(1);
    expect((await repo.listByBucket(ALICE, 'S')).items).toHaveLength(0);
    expect((await repo.listByBucket(ALICE, 'P')).items).toHaveLength(1);
  });

  it('keeps an undated Plan in #P when only its presentation type changes', async () => {
    const before = anActivity({
      objectKind: 'plan',
      type: 'custom',
      details: { kind: 'custom' },
    } as Partial<Activity>);
    await repo.createActivity(ALICE, before);

    const after = {
      ...before,
      type: 'event',
      details: { kind: 'event' },
      updatedAt: '2026-08-08T11:00:00.000Z',
    } as Activity;
    await repo.patchActivity(ALICE, after, before.updatedAt, { previous: before });

    expect(await countAll(ALICE)).toBe(1);
    expect((await repo.listByBucket(ALICE, 'P')).items).toHaveLength(1);
  });
});

describe('optimistic concurrency', () => {
  it('accepts the updatedAt the caller read', async () => {
    const before = anActivity();
    await repo.createActivity(ALICE, before);

    const after = {
      ...before,
      title: 'Buy oat milk',
      updatedAt: '2026-08-08T11:00:00.000Z',
    };
    await repo.patchActivity(ALICE, after, before.updatedAt, { previous: before });

    expect((await repo.getActivityMeta(before.activityId))?.title).toBe('Buy oat milk');
  });

  it('rejects a stale one, so two edits cannot silently overwrite each other', async () => {
    const before = anActivity();
    await repo.createActivity(ALICE, before);

    const after = {
      ...before,
      title: 'Buy oat milk',
      updatedAt: '2026-08-08T11:00:00.000Z',
    };

    await expect(
      repo.patchActivity(ALICE, after, '2026-01-01T00:00:00.000Z', { previous: before }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect((await repo.getActivityMeta(before.activityId))?.title).toBe('Buy milk');
  });
});

describe('delete', () => {
  it('removes every item under ACT#<id>, reminders included, plus the index entry', async () => {
    const subject = anActivity();
    await repo.createActivity(ALICE, subject, {
      reminders: [{ reminderId: 'rem_1', offsetMinutes: -15 }],
    });

    await repo.deleteActivity(ALICE, subject.activityId);

    expect(await repo.getActivityPartition(subject.activityId)).toHaveLength(0);
    expect((await repo.listByBucket(ALICE, 'N')).items).toHaveLength(0);
  });

  it('is idempotent, so a retry after a partial failure completes it', async () => {
    const subject = anActivity();
    await repo.createActivity(ALICE, subject);

    await repo.deleteActivity(ALICE, subject.activityId);
    await expect(repo.deleteActivity(ALICE, subject.activityId)).resolves.toBeUndefined();
  });
});

/**
 * **The assertion the whole key design exists for**, written against two invented users while
 * there is only one real one — which `definition-of-done.md` §3 requires and which is the
 * only time it is cheap. Neither id needs a profile.
 */
describe('tenant isolation', () => {
  it('never returns one user’s activities to the other’s list query', async () => {
    await repo.createActivity(ALICE, anActivity({ title: 'Alice’s errand' }));
    await repo.createActivity(BEN, anActivity({ ownerId: BEN, title: 'Ben’s errand' }));

    const alice = await repo.listByBucket(ALICE, 'N');
    const ben = await repo.listByBucket(BEN, 'N');

    expect(alice.items.map((item) => item.title)).toEqual(['Alice’s errand']);
    expect(ben.items.map((item) => item.title)).toEqual(['Ben’s errand']);
  });

  it('gives each user their own index partition, in every bucket', async () => {
    await repo.createActivity(ALICE, anActivity());
    await repo.createActivity(BEN, anActivity({ ownerId: BEN }));

    for (const bucket of ['S', 'P', 'N', 'R'] as const) {
      const alice = await repo.listByBucket(ALICE, bucket);
      const ben = await repo.listByBucket(BEN, bucket);
      const overlap = alice.items.filter((a) =>
        ben.items.some((b) => b.activityId === a.activityId),
      );
      expect(overlap).toHaveLength(0);
    }
  });
});

/**
 * One Activity row holds the whole series and the agenda expands it at read time
 * (`CLAUDE.md` rule 3). Nothing here writes a future occurrence, and the count is what says
 * so.
 */
describe('recurrence is one row, never materialised', () => {
  it('writes exactly two items for a weekly series — META and its index entry', async () => {
    const subject = anActivity({
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'weekly', effectiveFrom: '2026-08-01' }],
      },
      schedule: { date: '2026-08-01', timezone: 'UTC' },
    });

    await repo.createActivity(ALICE, subject);

    expect(await repo.getActivityPartition(subject.activityId)).toHaveLength(1);
    expect(await countIndexRows(ALICE)).toBe(1);
  });

  it('reads occurrence overrides for a window without expanding anything', async () => {
    const subject = anActivity();
    await repo.createActivity(ALICE, subject);

    for (const date of ['2026-07-31', '2026-08-05', '2026-09-01']) {
      await base.putItem({
        ...keys.occurrence(subject.activityId, date),
        entity: 'Occurrence',
        activityId: subject.activityId,
        date,
        status: 'completed',
        schemaVersion: 1,
      });
    }

    const august = await repo.listOccurrences(
      subject.activityId,
      '2026-08-01',
      '2026-08-31',
    );

    expect(august.map((row) => row.date)).toEqual(['2026-08-05']);
  });
});

async function countIndexRows(userId: string): Promise<number> {
  const rows = await base.queryAll(
    { pk: keys.userProfile(userId).pk },
    { skPrefix: 'IDX#' },
  );
  return rows.length;
}
