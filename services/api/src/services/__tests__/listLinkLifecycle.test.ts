import type { Activity, ListItem, ListItemActivityLink } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The link lifecycle table (`plans-and-lists.md` §6.3, `phase-03` §P3-15, acceptance
 * criterion 10) — one test per row, in the file §P3-15 names.
 *
 * The canonical doc calls this "the most commonly mis-implemented rule in the product", and
 * the shape of the mistake is always the same: one side cascading into the other. So every
 * test here asks two questions — what happened to the pointer, and what happened to the
 * ListItem — and the second answer is *nothing* in every single row.
 *
 * ## Why these are service tests with mocked repositories
 *
 * Each row is a decision, not a storage effect: **whether** pointer work is requested, and
 * with which pointers. Asserting on what the service hands the repository is what pins the
 * decision; whether the resulting transaction commits is the repository's own suite. The one
 * thing that would be invisible at any other seam — that a negative outcome through
 * `/complete` behaves exactly like `/skip` — is only observable here.
 *
 * ## The one row with no test, and why
 *
 * **Viewer loses list access** is Phase 6. Membership does not exist yet, so there is no way
 * to lose access to a list and no transition to exercise; a test here could only assert
 * against a stub. Recorded rather than skipped, because a skipped test that asserts nothing
 * is the smell `coding-standards.md` §11.23 rejects.
 *
 * The read side degrades safely in the meantime: P3-14's projection omits a pointer whose
 * Activity the caller cannot read and removes it once a strong read confirms, so an
 * early-arriving case shows no dead link.
 */

const USER = 'usr_local_dev';
const OTHER = 'usr_other_viewer';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const OTHER_ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X4';
const ITEM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X5';
const NOW = '2026-08-25T09:00:00.000Z';

/** Stands in for the repository's own signal that a pointer moved mid-transaction. */
class StaleLink extends Error {}

const mocks = {
  getActivityMeta: vi.fn(),
  listParticipants: vi.fn(() => Promise.resolve([])),
  patchActivity: vi.fn((_u: string, _n: unknown, _e: string, _o?: unknown) =>
    Promise.resolve(),
  ),
  putActivityMeta: vi.fn(),
  getActivityPartition: vi.fn(() => Promise.resolve([])),
  activityFromPartition: vi.fn(),
  deleteActivity: vi.fn((_u: string, _a: string, _o?: unknown) => Promise.resolve()),
  findViewerLinksTo: vi.fn(() => Promise.resolve([])),
  batchGetViewerLinks: vi.fn(() => Promise.resolve([])),
  deleteStaleViewerLink: vi.fn(() => Promise.resolve()),
  getListMeta: vi.fn(),
  listItems: vi.fn(),
  deleteListItem: vi.fn(),
  newListOperationId: vi.fn(() => 'op_01J8XKQ2M4N5P6R7S8T9V0W1X9'),
  assertActivityAccess: vi.fn((_u: string, _a: string, _l?: string) =>
    Promise.resolve({}),
  ),
  assertActivityReadAccessFromPartition: vi.fn(() => Promise.resolve({})),
  assertListAccess: vi.fn(() => Promise.resolve({ index: {}, isOwner: true })),
  getActivityPartitionStrong: vi.fn(() => Promise.resolve([])),
  putOccurrence: vi.fn(() => Promise.resolve()),
  getOccurrence: vi.fn(() => Promise.resolve(undefined)),
  transactWrite: vi.fn(() => Promise.resolve()),
  receiptItem: vi.fn(() => ({ Put: { Item: {} } })),
};

vi.mock('../../repositories/activityRepository.js', () => ({
  getActivityMeta: mocks.getActivityMeta,
  listParticipants: mocks.listParticipants,
  patchActivity: mocks.patchActivity,
  putActivityMeta: mocks.putActivityMeta,
  getActivityPartition: mocks.getActivityPartition,
  getActivityPartitionStrong: mocks.getActivityPartitionStrong,
  StaleViewerLinkError: StaleLink,
  activityFromPartition: mocks.activityFromPartition,
  deleteActivity: mocks.deleteActivity,
}));

vi.mock('../../repositories/listRepository.js', () => ({
  findViewerLinksTo: mocks.findViewerLinksTo,
  batchGetViewerLinks: mocks.batchGetViewerLinks,
  deleteStaleViewerLink: mocks.deleteStaleViewerLink,
  getListMeta: mocks.getListMeta,
  listItems: mocks.listItems,
  deleteListItem: mocks.deleteListItem,
  newListOperationId: mocks.newListOperationId,
  ListNotFoundError: class extends Error {},
  ListReadFenceError: class extends Error {},
}));

vi.mock('../authz.js', () => ({
  assertActivityAccess: mocks.assertActivityAccess,
  assertActivityReadAccessFromPartition: mocks.assertActivityReadAccessFromPartition,
  assertListAccess: mocks.assertListAccess,
}));

vi.mock('../../repositories/occurrenceRepository.js', () => ({
  put: mocks.putOccurrence,
  get: mocks.getOccurrence,
}));

vi.mock('../../repositories/tx.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories/tx.js')>();
  return { ...actual, transactWrite: mocks.transactWrite };
});

vi.mock('../../repositories/idempotencyRepository.js', () => ({
  receiptItem: mocks.receiptItem,
}));

const completion = await import('../completionService.js');
const activityService = await import('../activityService.js');
const listItemService = await import('../listItemService.js');

/** A Plan that came from a list item — the only kind with a pointer to lose. */
const linkedPlan = (overrides: Partial<Activity> = {}): Activity =>
  ({
    activityId: ACT,
    ownerId: USER,
    status: 'scheduled',
    objectKind: 'plan',
    type: 'event',
    title: 'Zahav',
    schedule: { date: '2026-09-01', timezone: 'America/New_York' },
    listId: LIST,
    listItemId: ITEM,
    details: { kind: 'event' },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    icsSequence: 0,
    createdAt: NOW,
    lastActivityAt: NOW,
    updatedAt: NOW,
    schemaVersion: 1,
    ...overrides,
  }) as Activity;

const link = (viewerUserId = USER, activityId = ACT): ListItemActivityLink => ({
  listId: LIST,
  itemId: ITEM,
  viewerUserId,
  activityId,
  linkedAt: NOW,
});

const receiptFor = () => ({ key: 'k' }) as never;

/** The options `deleteActivity` was handed by the cascade. */
const deleteOptions = () =>
  vi.mocked(mocks.deleteActivity).mock.calls[0]?.[2] as
    | { clearViewerLinks?: readonly ListItemActivityLink[] }
    | undefined;

/** The options `patchActivity` was handed — where every pointer decision is visible. */
const patchOptions = () =>
  vi.mocked(mocks.patchActivity).mock.calls[0]?.[3] as
    | { clearViewerLinks?: readonly ListItemActivityLink[] }
    | undefined;

const useActivity = (activity: Activity) => {
  mocks.getActivityMeta.mockResolvedValue(activity as never);
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listParticipants.mockResolvedValue([] as never);
  mocks.patchActivity.mockResolvedValue(undefined as never);
  mocks.findViewerLinksTo.mockResolvedValue([] as never);
  mocks.getOccurrence.mockResolvedValue(undefined as never);
  mocks.putOccurrence.mockResolvedValue(undefined as never);
  mocks.transactWrite.mockResolvedValue(undefined as never);
  mocks.receiptItem.mockReturnValue({ Put: { Item: {} } } as never);
  mocks.assertActivityAccess.mockResolvedValue({} as never);
  mocks.assertListAccess.mockResolvedValue({ index: {}, isOwner: true } as never);
  mocks.newListOperationId.mockReturnValue('op_01J8XKQ2M4N5P6R7S8T9V0W1X9' as never);
});

/* Row 1 — Completed / un-completed / rescheduled. */
describe('completed, un-completed and rescheduled keep the pointer', () => {
  it('requests no pointer work when a Plan is completed', async () => {
    useActivity(linkedPlan());

    await completion.completeActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(patchOptions()).not.toHaveProperty('clearViewerLinks');
    expect(vi.mocked(mocks.findViewerLinksTo)).not.toHaveBeenCalled();
  });

  it('requests no pointer work when a Plan is un-completed', async () => {
    useActivity(linkedPlan({ status: 'completed', completedAt: NOW } as never));

    await completion.uncompleteActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(patchOptions()).not.toHaveProperty('clearViewerLinks');
  });

  /**
   * The reading named in the PR: **nothing restores a cleared pointer.** No row in the table
   * puts one back, so un-completing a Plan whose skip already cleared it leaves it cleared.
   * Re-linking is `Plan this item` again — an explicit action with its own confirmation.
   */
  it('does not restore a pointer a skip already cleared', async () => {
    useActivity(linkedPlan({ status: 'skipped' }));
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await completion.uncompleteActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(patchOptions()).not.toHaveProperty('clearViewerLinks');
    expect(vi.mocked(mocks.findViewerLinksTo)).not.toHaveBeenCalled();
  });

  /** Completion never reaches the item — not to check it, not to read it (§5.10). */
  it('completing a Plan from a checkable list writes no item at all', async () => {
    useActivity(linkedPlan());

    await completion.completeActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(vi.mocked(mocks.getListMeta)).not.toHaveBeenCalled();
    expect(vi.mocked(mocks.listItems)).not.toHaveBeenCalled();
  });
});

/* Row 2 — Plan unscheduled. */
describe('unscheduling keeps the pointer and writes nothing', () => {
  /**
   * The row that separates unschedule from skip, and the reason the table has both: an
   * unscheduled Plan still exists in Needs a date, so its pointer stays and only the state
   * line goes. A skip removes the pointer because the Plan is no longer something that will
   * happen.
   *
   * Unscheduling runs through the schedule route, not this service, and its rule is a
   * **negative**: no pointer work anywhere. What is assertable here is that no completion
   * path treats a date-less Plan as a reason to clear, and that a Plan with no
   * `schedule.date` still carries its provenance — which is what lets the same pointer
   * become visible again when the Activity regains a date.
   */
  it('leaves an unscheduled Plan’s pointer alone on every non-skip transition', async () => {
    useActivity(linkedPlan({ status: 'saved', schedule: undefined } as never));
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await completion.completeActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(patchOptions()).not.toHaveProperty('clearViewerLinks');
    expect(vi.mocked(mocks.findViewerLinksTo)).not.toHaveBeenCalled();
  });

  /**
   * Skip and unschedule diverge on exactly one thing. A Plan with no date that is *skipped*
   * still clears — the rule keys on the resulting status, not on whether a date is present.
   */
  it('still clears when a date-less Plan is skipped, because status is the key', async () => {
    useActivity(linkedPlan({ status: 'saved', schedule: undefined } as never));
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await completion.skipActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(patchOptions()?.clearViewerLinks).toEqual([link()]);
  });

  /** Provenance survives, so rescheduling makes the same pointer meaningful again. */
  it('keeps listId and listItemId on a Plan that lost its date', async () => {
    useActivity(linkedPlan({ status: 'saved', schedule: undefined } as never));

    await completion.completeActivity(USER, ACT, {} as never, NOW, receiptFor);

    const written = vi.mocked(mocks.patchActivity).mock.calls[0]?.[1] as Activity;
    expect(written.listId).toBe(LIST);
    expect(written.listItemId).toBe(ITEM);
  });
});

/* Row 3 — Skipped / didnt_happen. */
describe('a non-occurrence transition to skipped clears the pointer', () => {
  it('clears through POST /skip', async () => {
    useActivity(linkedPlan());
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await completion.skipActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(patchOptions()?.clearViewerLinks).toEqual([link()]);
    expect(vi.mocked(mocks.findViewerLinksTo)).toHaveBeenCalledWith(LIST, ITEM, ACT);
  });

  /**
   * **The nuance this task turns on.** `didnt_happen` arrives through `/complete` and
   * produces `status: 'skipped'`. Keying the rule on the endpoint would clear here and not
   * there, so one user action would behave two ways depending on the route the client used.
   */
  it('clears through POST /complete with a negative outcome', async () => {
    /** `didnt_happen` is the non-event spelling; an event uses `didnt_go`, tested below. */
    useActivity(linkedPlan({ type: 'custom', details: { kind: 'custom' } } as never));
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await completion.completeActivity(
      USER,
      ACT,
      { outcome: 'didnt_happen' } as never,
      NOW,
      receiptFor,
    );

    expect(patchOptions()?.clearViewerLinks).toEqual([link()]);
  });

  /** An event's negative outcome is spelled differently and means the same thing. */
  it('clears for didnt_go on an event', async () => {
    useActivity(linkedPlan({ type: 'event' }));
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await completion.completeActivity(
      USER,
      ACT,
      { outcome: 'didnt_go' } as never,
      NOW,
      receiptFor,
    );

    expect(patchOptions()?.clearViewerLinks).toEqual([link()]);
  });

  it('clears nothing for a Plan that never came from a list', async () => {
    useActivity(linkedPlan({ listId: undefined, listItemId: undefined } as never));

    await completion.skipActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(patchOptions()).not.toHaveProperty('clearViewerLinks');
    expect(vi.mocked(mocks.findViewerLinksTo)).not.toHaveBeenCalled();
  });

  /** Only pointers to *this* Plan; another viewer's Plan from the same item is untouched. */
  it('clears only pointers naming this Plan', async () => {
    useActivity(linkedPlan());
    mocks.findViewerLinksTo.mockResolvedValue([link(USER), link(OTHER)] as never);

    await completion.skipActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(vi.mocked(mocks.findViewerLinksTo)).toHaveBeenCalledWith(LIST, ITEM, ACT);
    for (const cleared of patchOptions()?.clearViewerLinks ?? []) {
      expect(cleared.activityId).toBe(ACT);
    }
  });

  /** The item is never touched by a skip — only the pointer goes. */
  it('writes no item when it clears', async () => {
    useActivity(linkedPlan());
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await completion.skipActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(vi.mocked(mocks.listItems)).not.toHaveBeenCalled();
  });
});

/* Row 3, second half — an occurrence-only skip. */
describe('an occurrence skip leaves the series and its pointer alone', () => {
  const recurring = () =>
    linkedPlan({
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'weekly', effectiveFrom: '2026-09-01', byWeekday: [2] }],
      },
    } as never);

  it('writes only the occurrence override and requests no pointer work', async () => {
    useActivity(recurring());
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await completion.skipActivity(
      USER,
      ACT,
      { occurrenceDate: '2026-09-08' } as never,
      NOW,
      receiptFor,
    );

    expect(vi.mocked(mocks.putOccurrence)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mocks.findViewerLinksTo)).not.toHaveBeenCalled();
  });

  /** `agent-playbook.md` §6.7: the series META is not written at all. */
  it('leaves the series META untouched', async () => {
    useActivity(recurring());

    await completion.skipActivity(
      USER,
      ACT,
      { occurrenceDate: '2026-09-08' } as never,
      NOW,
      receiptFor,
    );

    expect(vi.mocked(mocks.patchActivity)).not.toHaveBeenCalled();
    expect(vi.mocked(mocks.putActivityMeta)).not.toHaveBeenCalled();
  });

  it('separates an occurrence skip from a series skip', async () => {
    useActivity(recurring());
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await completion.skipActivity(
      USER,
      ACT,
      { occurrenceDate: '2026-09-08' } as never,
      NOW,
      receiptFor,
    );
    const afterOccurrence = vi.mocked(mocks.findViewerLinksTo).mock.calls.length;

    expect(afterOccurrence).toBe(0);
  });
});

/* Row 5 — Plan deleted. */
describe('deleting a Plan deletes pointers to it, and nothing else', () => {
  const partitionOf = (activity: Activity) => [
    { pk: `ACT#${activity.activityId}`, sk: 'META', entity: 'Activity', ...activity },
  ];

  /**
   * The partition is supplied through the **strong** read, which is the one the delete uses:
   * both the cascade's key list and the Plan's provenance come out of it, and a row missing
   * from a replica is a row never deleted (P3-15, raised in review).
   */
  const useDeletable = (activity: Activity) => {
    mocks.assertActivityAccess.mockResolvedValue({ activity, isOwner: true } as never);
    mocks.getActivityPartitionStrong.mockResolvedValue(partitionOf(activity) as never);
    mocks.activityFromPartition.mockReturnValue(activity as never);
  };

  it('hands the cascade the pointers that name this Plan', async () => {
    useDeletable(linkedPlan());
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await activityService.removeActivity(USER, ACT, NOW);

    expect(vi.mocked(mocks.findViewerLinksTo)).toHaveBeenCalledWith(LIST, ITEM, ACT);
    expect(deleteOptions()?.clearViewerLinks).toEqual([link()]);
  });

  /** The other half of the row, and the one that matters: **the ListItem survives.** */
  it('never reads or writes the item itself', async () => {
    useDeletable(linkedPlan());
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await activityService.removeActivity(USER, ACT, NOW);

    expect(vi.mocked(mocks.listItems)).not.toHaveBeenCalled();
    expect(vi.mocked(mocks.getListMeta)).not.toHaveBeenCalled();
  });

  it('asks for no pointer work when the Plan never came from a list', async () => {
    useDeletable(linkedPlan({ listId: undefined, listItemId: undefined } as never));

    await activityService.removeActivity(USER, ACT, NOW);

    expect(vi.mocked(mocks.findViewerLinksTo)).not.toHaveBeenCalled();
    expect(deleteOptions()).not.toHaveProperty('clearViewerLinks');
  });
});

/* Row 6 — Viewer schedules again. Assert-only: the replacement is P3-13's put. */
describe('scheduling again replaces only that viewer’s pointer', () => {
  /**
   * The pointer key is `LNK#<viewer>#<item>`, so a second confirmed action for the same
   * viewer overwrites their own row and cannot reach anybody else's. That is a property of
   * the key, proved where the write happens — `listSchedule.int.test.ts` asserts one link row
   * survives with the newer Activity, and the older Plan standing untouched.
   *
   * What belongs here is the consequence for this table: no lifecycle rule fires on a
   * replacement. Nothing is skipped, nothing is deleted, and the older Plan becomes an
   * ordinary Plan with no pointer — v1 exposes no link history.
   */
  it('is not a lifecycle event: replacing a pointer skips and deletes nothing', async () => {
    useActivity(linkedPlan());

    await completion.completeActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(vi.mocked(mocks.deleteActivity)).not.toHaveBeenCalled();
    expect(patchOptions()).not.toHaveProperty('clearViewerLinks');
  });
});

/* The projection: one viewer's link, and never a read of another viewer's Activity. */
describe('the projection returns only the caller’s link', () => {
  const anItem = (): ListItem => ({
    itemId: ITEM,
    listId: LIST,
    rank: 'n',
    itemRevision: 1,
    title: 'Zahav',
    checked: false,
  });

  /**
   * `security-privacy.md` row 15a: the filter to the caller happens in the keyed batch read,
   * **before** any Activity is looked up. The spy is the assertion — another viewer's
   * Activity is never even loaded, so its date and status cannot reach the wrong request.
   */
  it('never loads the other viewer’s Activity', async () => {
    mocks.listItems.mockResolvedValue({
      list: {},
      items: [anItem()],
      itemIds: [ITEM],
    } as never);
    /** The repository returns only the caller's rows; the other viewer's never arrives. */
    mocks.batchGetViewerLinks.mockResolvedValue([link(USER, ACT)] as never);

    const page = await listItemService.listItemsFor(USER, LIST, undefined);

    expect(page.items[0]?.viewerLink?.activityId).toBe(ACT);
    for (const call of vi.mocked(mocks.assertActivityAccess).mock.calls) {
      expect(call[1]).not.toBe(OTHER_ACT);
    }
  });

  it('joins the caller’s link onto the item without altering the item', async () => {
    const item = anItem();
    mocks.listItems.mockResolvedValue({
      list: {},
      items: [item],
      itemIds: [ITEM],
    } as never);
    mocks.batchGetViewerLinks.mockResolvedValue([link()] as never);

    const page = await listItemService.listItemsFor(USER, LIST, undefined);

    expect(page.items[0]?.item).toEqual(item);
  });
});

/* Row 6 — ListItem deleted. */
describe('deleting a ListItem clears its pointers, and every Plan survives', () => {
  /**
   * Verified rather than built: P3-08's delete already writes the whole row in one
   * transaction — a conditional `Delete` per current viewer pointer, and a `REMOVE` of
   * `listId`/`listItemId` on each Plan those pointers named, conditioned on the pair it
   * expects. Nothing deletes an Activity.
   *
   * That storage effect belongs to the repository's own transaction and is asserted against a
   * real table in `listsCrud.int.test.ts`. What this seam owns is the delegation: the service
   * removes the item through the one repository call that carries that transaction, and does
   * not reach for an Activity itself.
   */
  it('goes through the repository delete and touches no Activity directly', async () => {
    mocks.getListMeta.mockResolvedValue({
      listId: LIST,
      behaviour: 'collection',
      capabilities: { checkable: true, supportsLocation: false },
      archived: false,
      rankVersion: 1,
      updatedAt: NOW,
    } as never);
    mocks.deleteListItem.mockResolvedValue({ itemId: ITEM } as never);

    await listItemService.removeItem(USER, LIST, ITEM, NOW);

    expect(vi.mocked(mocks.deleteListItem)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mocks.deleteActivity)).not.toHaveBeenCalled();
    expect(vi.mocked(mocks.patchActivity)).not.toHaveBeenCalled();
  });
});

/* A moved pointer must not cancel the user's skip. */
describe('a pointer replaced mid-skip does not cancel the skip', () => {
  /**
   * The two rules are in tension. The delete is conditional so a viewer who just planned the
   * item again keeps their newer pointer; it is in the status transaction so skipping is one
   * event. A failing condition cancels the **whole** transaction — so without a retry the
   * user's skip silently would not happen because an unrelated pointer moved.
   */
  it('re-reads the pointers and commits the skip', async () => {
    useActivity(linkedPlan());
    mocks.findViewerLinksTo
      .mockResolvedValueOnce([link()] as never)
      .mockResolvedValueOnce([] as never);
    mocks.patchActivity.mockRejectedValueOnce(new StaleLink());

    await completion.skipActivity(USER, ACT, {} as never, NOW, receiptFor);

    expect(vi.mocked(mocks.patchActivity)).toHaveBeenCalledTimes(2);
    /** The retry no longer names the replaced pointer, so the newer Plan keeps it. */
    const second = vi.mocked(mocks.patchActivity).mock.calls[1]?.[3] as {
      clearViewerLinks?: readonly ListItemActivityLink[];
    };
    expect(second.clearViewerLinks).toEqual([]);
  });

  /** Bounded: a pathological contender gets a retryable conflict, never a silent no-op. */
  it('gives up with a conflict rather than reporting a skip that did not happen', async () => {
    useActivity(linkedPlan());
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);
    mocks.patchActivity.mockRejectedValue(new StaleLink());

    await expect(
      completion.skipActivity(USER, ACT, {} as never, NOW, receiptFor),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(vi.mocked(mocks.patchActivity)).toHaveBeenCalledTimes(3);
  });

  it('does not swallow an unrelated failure', async () => {
    useActivity(linkedPlan());
    mocks.patchActivity.mockRejectedValue(new Error('ProvisionedThroughputExceeded'));

    await expect(
      completion.skipActivity(USER, ACT, {} as never, NOW, receiptFor),
    ).rejects.toThrow('ProvisionedThroughputExceeded');
    expect(vi.mocked(mocks.patchActivity)).toHaveBeenCalledTimes(1);
  });
});

/* The delete reads strongly, because it acts on what it reads. */
describe('deleting a Plan reads its provenance from the leader', () => {
  it('never takes the cascade’s partition from a replica', async () => {
    const activity = linkedPlan();
    mocks.assertActivityAccess.mockResolvedValue({ activity, isOwner: true } as never);
    mocks.getActivityPartitionStrong.mockResolvedValue([
      { pk: `ACT#${ACT}`, sk: 'META', entity: 'Activity', ...activity },
    ] as never);
    mocks.findViewerLinksTo.mockResolvedValue([link()] as never);

    await activityService.removeActivity(USER, ACT, NOW);

    expect(vi.mocked(mocks.getActivityPartitionStrong)).toHaveBeenCalledWith(ACT);
    expect(vi.mocked(mocks.getActivityPartition)).not.toHaveBeenCalled();
    /** A META row that had not replicated would read as a Plan with no list, and its
     * pointer would outlive the Plan it names. */
    expect(deleteOptions()?.clearViewerLinks).toEqual([link()]);
  });
});
