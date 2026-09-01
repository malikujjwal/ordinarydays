import type { Activity } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertActivityAccess,
  assertActivityReadAccessFromMeta,
  assertActivityReadAccessFromPartition,
  assertListAccess,
  readableActivities,
} from './authz.js';

/**
 * `assertActivityAccess` (P1-10 rule 2), with the repository mocked.
 *
 * **Every one of these runs against invented user ids**, and that is the point: in Phase 1
 * every activity belongs to the only user there is, so the participant and stranger branches
 * are unreachable through the API. They are still rules about keys, and writing the tests now
 * is what stops the checks being bolted onto eleven shipped call sites in Phase 6.
 */
vi.mock('../repositories/activityRepository.js', () => ({
  activityFromPartition: vi.fn((partition: Array<Record<string, unknown>>) =>
    partition.find((row) => row.sk === 'META'),
  ),
  getActivityIndex: vi.fn(),
  getActivityMeta: vi.fn(),
  getActivityPartitionStrong: vi.fn(),
  batchGetActivityMeta: vi.fn(() => Promise.resolve([])),
  listParticipants: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../repositories/listRepository.js', () => ({
  getListPointer: vi.fn(),
}));

const repository = await import('../repositories/activityRepository.js');
const listRepository = await import('../repositories/listRepository.js');

const OWNER = 'usr_owner';
const PARTICIPANT = 'usr_participant';
const STRANGER = 'usr_stranger';

const PLAN = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const PREP = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';

/**
 * `Record<string, unknown>` rather than `Partial<Activity>`: `Activity` is a discriminated
 * union on `objectKind`, so a partial of it pins `type` to whichever arm the base fixture
 * picked and a `task` override stops compiling against a `plan` base. The cast below is what
 * the union is enforced by; the overrides are test data on the way in.
 */
const activity = (overrides: Record<string, unknown> = {}): Activity =>
  ({
    activityId: PLAN,
    ownerId: OWNER,
    status: 'saved',
    objectKind: 'plan',
    type: 'event',
    title: 'Dinner',
    details: { kind: 'event' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  }) as Activity;

/** A stored `PART#` row. `userId` is what the check matches on (`data-model.md` §4.7). */
const participantRow = (userId: string) => ({
  entity: 'Participant',
  activityId: PLAN,
  personId: 'psn_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  userId,
  displayName: 'Someone',
  rsvp: 'going',
  role: 'participant',
  isGuest: false,
});

beforeEach(() => {
  vi.mocked(repository.getActivityIndex).mockReset();
  vi.mocked(repository.getActivityMeta).mockReset();
  vi.mocked(repository.getActivityPartitionStrong).mockReset();
  vi.mocked(repository.listParticipants).mockReset();
  vi.mocked(repository.listParticipants).mockResolvedValue([]);
  vi.mocked(listRepository.getListPointer).mockReset();
});

describe('bounded META/index detail access', () => {
  it('admits the owner without reading an index grant', async () => {
    await expect(assertActivityReadAccessFromMeta(OWNER, activity())).resolves.toEqual({
      activity: activity(),
      isOwner: true,
      viaParent: false,
    });
    expect(repository.getActivityIndex).not.toHaveBeenCalled();
  });

  it('admits the exact direct caller grant with a strong keyed read', async () => {
    vi.mocked(repository.getActivityIndex).mockResolvedValue({ activityId: PLAN });

    await expect(
      assertActivityReadAccessFromMeta(PARTICIPANT, activity()),
    ).resolves.toMatchObject({ isOwner: false, viaParent: false });
    expect(repository.getActivityIndex).toHaveBeenCalledWith(PARTICIPANT, PLAN, {
      consistentRead: true,
    });
  });

  it('inherits through the canonical parent owner without opening a partition', async () => {
    vi.mocked(repository.getActivityIndex).mockResolvedValue(undefined);
    vi.mocked(repository.getActivityMeta).mockResolvedValue(activity());

    await expect(
      assertActivityReadAccessFromMeta(
        OWNER,
        activity({
          activityId: PREP,
          ownerId: STRANGER,
          objectKind: 'task',
          type: 'task',
          details: { kind: 'task' },
          parentActivityId: PLAN,
        }),
      ),
    ).resolves.toMatchObject({ isOwner: false, viaParent: true });
    expect(repository.getActivityMeta).toHaveBeenCalledWith(PLAN, {
      consistentRead: true,
    });
    expect(repository.getActivityPartitionStrong).not.toHaveBeenCalled();
  });

  it('inherits through the exact parent participant grant', async () => {
    vi.mocked(repository.getActivityIndex)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ activityId: PLAN });
    vi.mocked(repository.getActivityMeta).mockResolvedValue(
      activity({ ownerId: STRANGER }),
    );

    await expect(
      assertActivityReadAccessFromMeta(
        PARTICIPANT,
        activity({
          activityId: PREP,
          ownerId: STRANGER,
          objectKind: 'task',
          type: 'task',
          details: { kind: 'task' },
          parentActivityId: PLAN,
        }),
      ),
    ).resolves.toMatchObject({ isOwner: false, viaParent: true });
    expect(repository.getActivityIndex).toHaveBeenLastCalledWith(PARTICIPANT, PLAN, {
      consistentRead: true,
    });
  });
});

describe('list access', () => {
  it.each(['read', 'write', 'owner'] as const)(
    'grants an owner %s access',
    async (level) => {
      vi.mocked(listRepository.getListPointer).mockResolvedValue({
        listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
        userId: OWNER,
        role: 'owner',
        addedAt: '2026-08-09T00:00:00.000Z',
      } as never);

      await expect(assertListAccess(OWNER, 'lst_1', level)).resolves.toMatchObject({
        isOwner: true,
      });
    },
  );

  it.each(['read', 'write'] as const)('grants a member %s access', async (level) => {
    vi.mocked(listRepository.getListPointer).mockResolvedValue({
      listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      userId: PARTICIPANT,
      role: 'member',
      addedAt: '2026-08-09T00:00:00.000Z',
    } as never);

    await expect(assertListAccess(PARTICIPANT, 'lst_1', level)).resolves.toMatchObject({
      isOwner: false,
    });
  });

  it('returns forbidden when a known member requests owner access', async () => {
    vi.mocked(listRepository.getListPointer).mockResolvedValue({
      listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
      userId: PARTICIPANT,
      role: 'member',
      addedAt: '2026-08-09T00:00:00.000Z',
    } as never);

    await expect(assertListAccess(PARTICIPANT, 'lst_1', 'owner')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('returns not_found for an absent pointer without reading List META', async () => {
    vi.mocked(listRepository.getListPointer).mockResolvedValue(undefined);

    await expect(assertListAccess(STRANGER, 'lst_1', 'read')).rejects.toMatchObject({
      code: 'not_found',
      message: 'List not found.',
    });
    expect(listRepository.getListPointer).toHaveBeenCalledWith(STRANGER, 'lst_1');
  });
});

describe('an authoritative partition read', () => {
  const stored = (value: Activity) => ({
    ...value,
    pk: `ACT#${value.activityId}`,
    sk: 'META',
  });

  it('uses a strong parent partition for inherited prep-task access', async () => {
    vi.mocked(repository.getActivityPartitionStrong).mockResolvedValue([
      stored(activity()),
      {
        ...participantRow(PARTICIPANT),
        pk: `ACT#${PLAN}`,
        sk: 'PART#psn_parent_participant',
      },
    ]);

    const access = await assertActivityReadAccessFromPartition(PARTICIPANT, [
      stored(prep()),
    ]);

    expect(access).toMatchObject({
      activity: { activityId: PREP },
      isOwner: false,
      viaParent: true,
    });
    expect(repository.getActivityPartitionStrong).toHaveBeenCalledWith(PLAN);
    expect(repository.getActivityMeta).not.toHaveBeenCalled();
  });

  it('does not inherit access through a second parent hop', async () => {
    vi.mocked(repository.getActivityPartitionStrong).mockResolvedValue([
      stored(activity({ ownerId: STRANGER, parentActivityId: PREP })),
      {
        ...participantRow(PARTICIPANT),
        userId: STRANGER,
        pk: `ACT#${PLAN}`,
        sk: 'PART#psn_grandparent_participant',
      },
    ]);

    await expect(
      assertActivityReadAccessFromPartition(PARTICIPANT, [stored(prep())]),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(repository.getActivityPartitionStrong).toHaveBeenCalledTimes(1);
  });
});

describe('the owner', () => {
  it.each(['read', 'write', 'owner'] as const)('may %s', async (level) => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(activity());

    const access = await assertActivityAccess(OWNER, PLAN, level);

    expect(access.isOwner).toBe(true);
    expect(access.activity.activityId).toBe(PLAN);
  });

  /**
   * The row it loaded comes back, so a service method does not `GetItem` the same key twice
   * for one request — the round-trip budget is 3 for an ordinary endpoint
   * (`definition-of-done.md` §6).
   */
  it('never reads the participant list, so the ordinary path is one round trip', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(activity());

    await assertActivityAccess(OWNER, PLAN, 'owner');

    expect(repository.listParticipants).not.toHaveBeenCalled();
  });

  it('strongly reads META by default', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(activity());

    await assertActivityAccess(OWNER, PLAN, 'read');

    expect(repository.getActivityMeta).toHaveBeenCalledWith(PLAN, {
      consistentRead: true,
    });
  });
});

describe('a stranger', () => {
  /**
   * `404`, never `403`. A `403` confirms the activity exists, and that is a fact a stranger
   * is not entitled to (`definition-of-done.md` §7 rule 5).
   */
  it.each(['read', 'write', 'owner'] as const)(
    'gets not_found rather than forbidden for %s',
    async (level) => {
      vi.mocked(repository.getActivityMeta).mockResolvedValue(activity());

      await expect(assertActivityAccess(STRANGER, PLAN, level)).rejects.toMatchObject({
        code: 'not_found',
      });
    },
  );

  /**
   * The same answer, from the same line, for an id that does not exist — so the two cannot
   * drift into a message or a timing difference a prober could measure.
   */
  it('gets the identical answer for an activity that does not exist', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(undefined);

    await expect(assertActivityAccess(STRANGER, PLAN, 'read')).rejects.toMatchObject({
      code: 'not_found',
      message: 'Activity not found.',
    });
  });

  it('is not admitted by a participant row belonging to somebody else', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(activity());
    vi.mocked(repository.listParticipants).mockResolvedValue([
      participantRow(PARTICIPANT),
    ]);

    await expect(assertActivityAccess(STRANGER, PLAN, 'read')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  /** A guest has no `userId` at all; an absent one must never match an absent caller. */
  it('is not admitted by a guest row with no userId', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(activity());
    vi.mocked(repository.listParticipants).mockResolvedValue([
      { entity: 'Participant', personId: 'psn_x', isGuest: true },
    ]);

    await expect(assertActivityAccess(STRANGER, PLAN, 'read')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('a participant', () => {
  beforeEach(() => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(activity());
    vi.mocked(repository.listParticipants).mockResolvedValue([
      participantRow(PARTICIPANT),
    ]);
  });

  it.each(['read', 'write'] as const)('may %s', async (level) => {
    const access = await assertActivityAccess(PARTICIPANT, PLAN, level);

    expect(access.isOwner).toBe(false);
    expect(access.viaParent).toBe(false);
  });

  it('strongly reads the participant grant by default', async () => {
    await assertActivityAccess(PARTICIPANT, PLAN, 'read');

    expect(repository.listParticipants).toHaveBeenCalledWith(PLAN, {
      consistentRead: true,
    });
  });

  /**
   * `403` here and nowhere else. The participant can already see this plan, so naming the
   * limit is the answer to their question rather than a disclosure — and completing a plan
   * asserts a shared fact about an event, which is the owner's to assert (ADR-048).
   */
  it('gets forbidden, not not_found, for an owner-only action', async () => {
    await expect(assertActivityAccess(PARTICIPANT, PLAN, 'owner')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('is told what the limit is, since they can already see the activity', async () => {
    await expect(assertActivityAccess(PARTICIPANT, PLAN, 'owner')).rejects.toMatchObject({
      message: 'Only the person who created this can change it.',
    });
  });
});

/**
 * A prep task is an item on a shared checklist, not a statement about the plan's outcome. If
 * Alice books the hotel for a trip we are planning together, she must be able to tick
 * `Book hotel` whether or not she typed it (`api-contract.md` §3, ADR-051).
 */
describe('a participant of the parent, acting on a prep task', () => {
  const parentedBy = (rows: Record<string, unknown>[]) => {
    vi.mocked(repository.getActivityMeta).mockImplementation((id: string) =>
      Promise.resolve(id === PREP ? prep() : activity()),
    );
    vi.mocked(repository.listParticipants).mockImplementation((id: string) =>
      Promise.resolve(id === PLAN ? rows : []),
    );
  };

  it.each(['read', 'write'] as const)('may %s the child', async (level) => {
    parentedBy([participantRow(PARTICIPANT)]);

    const access = await assertActivityAccess(PARTICIPANT, PREP, level);

    expect(access.viaParent).toBe(true);
    expect(access.activity.activityId).toBe(PREP);
  });

  it('strongly reads the child, parent and parent participant grant', async () => {
    parentedBy([participantRow(PARTICIPANT)]);

    await assertActivityAccess(PARTICIPANT, PREP, 'read');

    expect(repository.getActivityMeta).toHaveBeenNthCalledWith(1, PREP, {
      consistentRead: true,
    });
    expect(repository.getActivityMeta).toHaveBeenNthCalledWith(2, PLAN, {
      consistentRead: true,
    });
    expect(repository.listParticipants).toHaveBeenNthCalledWith(1, PREP, {
      consistentRead: true,
    });
    expect(repository.listParticipants).toHaveBeenNthCalledWith(2, PLAN, {
      consistentRead: true,
    });
  });

  /**
   * The inheritance stops at `write`. Deleting a prep task is not a checklist tick, so it
   * stays with the child's owner.
   */
  it('may not take an owner-only action on the child', async () => {
    parentedBy([participantRow(PARTICIPANT)]);

    await expect(assertActivityAccess(PARTICIPANT, PREP, 'owner')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('admits the parent’s owner, who is not on their own participant list', async () => {
    vi.mocked(repository.getActivityMeta).mockImplementation((id: string) =>
      Promise.resolve(
        id === PREP
          ? prep({ ownerId: 'usr_someone_else' })
          : activity({ ownerId: OWNER }),
      ),
    );

    const access = await assertActivityAccess(OWNER, PREP, 'write');

    expect(access.viaParent).toBe(true);
  });

  it('still refuses a stranger to the parent', async () => {
    parentedBy([participantRow(PARTICIPANT)]);

    await expect(assertActivityAccess(STRANGER, PREP, 'read')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  /** A dangling parent pointer is not an admission ticket. */
  it('refuses when the parent has been deleted', async () => {
    vi.mocked(repository.getActivityMeta).mockImplementation((id: string) =>
      Promise.resolve(id === PREP ? prep() : undefined),
    );

    await expect(assertActivityAccess(PARTICIPANT, PREP, 'read')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

/** The child fixture, hoisted so the block above can vary it without restating the shape. */
function prep(overrides: Record<string, unknown> = {}): Activity {
  return activity({
    activityId: PREP,
    objectKind: 'task',
    type: 'task',
    parentActivityId: PLAN,
    ...overrides,
  });
}

/**
 * `readableActivities` — the batched read the list projection uses (P3-15, raised in review).
 *
 * The projection used to authorise one Activity per viewer link, **sequentially**: a
 * fifty-item page was fifty round trips. These assert the read *shape*, because that is what
 * regresses — a `Promise.all` over the page would still look correct here while issuing fifty
 * simultaneous requests, so the assertions are on call counts and on the absence of the
 * per-activity read, not on timing.
 */
describe('readableActivities', () => {
  const owned = (activityId: string): Activity =>
    ({ activityId, ownerId: OWNER, title: 'x' }) as Activity;

  const idsFor = (count: number) =>
    Array.from(
      { length: count },
      (_entry, index) => `act_01J8XKQ2M4N5P6R7S8T9V0W${String(index).padStart(3, '0')}`,
    );

  beforeEach(() => {
    vi.mocked(repository.batchGetActivityMeta).mockReset();
    vi.mocked(repository.getActivityMeta).mockReset();
    vi.mocked(repository.listParticipants).mockReset();
    vi.mocked(repository.listParticipants).mockResolvedValue([] as never);
  });

  it('reads a fifty-link page in one batch and no per-activity read', async () => {
    const ids = idsFor(50);
    vi.mocked(repository.batchGetActivityMeta).mockResolvedValue(ids.map(owned) as never);

    const readable = await readableActivities(OWNER, ids);

    expect(readable.size).toBe(50);
    expect(vi.mocked(repository.batchGetActivityMeta)).toHaveBeenCalledTimes(1);
    /** The regression guard: one `GetItem` per link is exactly what this replaced. */
    expect(vi.mocked(repository.getActivityMeta)).not.toHaveBeenCalled();
  });

  /**
   * Ownership is decided from the batch alone. Most links will only ever need this, so the
   * common page costs one read in total rather than one plus a membership check each.
   */
  it('needs no participant read for activities the caller owns', async () => {
    const ids = idsFor(10);
    vi.mocked(repository.batchGetActivityMeta).mockResolvedValue(ids.map(owned) as never);

    await readableActivities(OWNER, ids);

    expect(vi.mocked(repository.listParticipants)).not.toHaveBeenCalled();
  });

  /** A row the batch did not return is absent, not an error — the caller wants a verdict. */
  it('omits ids the batch did not return rather than throwing', async () => {
    const ids = idsFor(3);
    vi.mocked(repository.batchGetActivityMeta).mockResolvedValue([
      owned(ids[0] as string),
    ] as never);

    const readable = await readableActivities(OWNER, ids);

    expect([...readable.keys()]).toEqual([ids[0]]);
  });

  /** A stranger's Activity is absent for the same reason, and by the same rule. */
  it('omits an activity the caller may not read', async () => {
    const ids = idsFor(1);
    vi.mocked(repository.batchGetActivityMeta).mockResolvedValue([
      { activityId: ids[0], ownerId: 'usr_somebody_else', title: 'x' },
    ] as never);

    expect((await readableActivities(STRANGER, ids)).size).toBe(0);
  });

  it('strongly reads participant grants for non-owned batch rows', async () => {
    const ids = idsFor(1);
    vi.mocked(repository.batchGetActivityMeta).mockResolvedValue([
      { activityId: ids[0], ownerId: 'usr_somebody_else', title: 'x' },
    ] as never);

    await readableActivities(PARTICIPANT, ids);

    expect(repository.listParticipants).toHaveBeenCalledWith(ids[0], {
      consistentRead: true,
    });
  });

  it('asks for each id once, however many links name it', async () => {
    const repeated = ['act_01J8XKQ2M4N5P6R7S8T9V0W000', 'act_01J8XKQ2M4N5P6R7S8T9V0W000'];
    vi.mocked(repository.batchGetActivityMeta).mockResolvedValue([
      owned(repeated[0] as string),
    ] as never);

    await readableActivities(OWNER, repeated);

    expect(vi.mocked(repository.batchGetActivityMeta).mock.calls[0]?.[0]).toEqual([
      repeated[0],
    ]);
  });

  it('reads nothing at all for an empty page', async () => {
    expect((await readableActivities(OWNER, [])).size).toBe(0);
    expect(vi.mocked(repository.batchGetActivityMeta)).not.toHaveBeenCalled();
  });
});
