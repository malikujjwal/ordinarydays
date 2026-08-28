import { completionFollowUp, instant } from '@od/shared/schemas';
import type {
  Activity,
  ActivityDetails,
  List,
  ListItem,
  ListItemActivityLink,
  ProgressValue,
} from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../lib/errors.js';

/**
 * Which completions offer a follow-up, and what it says (§P3-16, acceptance criterion 11).
 *
 * ## Why these are service tests with the repository mocked
 *
 * Every line under test is a **decision**: whether to look at all, whether the pointer that
 * came back is the right one, and which of `activities.md` §5.3's two watch rows this is.
 * Storage settles none of that — `watchFollowUp.int.test.ts` settles the storage half against
 * a real table, and pins the negative claim a mock cannot: that nothing was written.
 *
 * What only this seam can show is the **order**: that a completion with nothing to suggest
 * never reads the list at all, and that the read is skipped entirely for a negative outcome
 * and for a recurring occurrence. A test at the endpoint sees the same empty answer either
 * way and cannot tell "asked and declined" from "never asked".
 */

const USER = 'usr_local_dev';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const OTHER_ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X4';
const ITEM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X5';
const NOW = instant.parse('2026-08-25T09:00:00.000Z');

class StaleLink extends Error {}
class ReadFence extends Error {}

const mocks = {
  getActivityMeta: vi.fn(),
  listParticipants: vi.fn(),
  patchActivity: vi.fn(),
  putActivityMeta: vi.fn(),
  findViewerLinksTo: vi.fn(),
  readWatchFollowUpSource: vi.fn(),
  assertListAccess: vi.fn(),
  putOccurrence: vi.fn(),
  getOccurrence: vi.fn(),
  transactWrite: vi.fn(),
  receiptItem: vi.fn(),
};

vi.mock('../../repositories/activityRepository.js', () => ({
  getActivityMeta: mocks.getActivityMeta,
  listParticipants: mocks.listParticipants,
  patchActivity: mocks.patchActivity,
  putActivityMeta: mocks.putActivityMeta,
  StaleViewerLinkError: StaleLink,
}));

vi.mock('../../repositories/listRepository.js', () => ({
  findViewerLinksTo: mocks.findViewerLinksTo,
  readWatchFollowUpSource: mocks.readWatchFollowUpSource,
  ListReadFenceError: ReadFence,
}));

vi.mock('../authz.js', () => ({ assertListAccess: mocks.assertListAccess }));

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

const watchSession = (
  overrides: Partial<Extract<ActivityDetails, { kind: 'watch' }>> = {},
): ActivityDetails => ({
  kind: 'watch',
  mediaTitle: 'Severance',
  mediaKind: 'show',
  season: 2,
  episode: 5,
  ...overrides,
});

/** A watch Plan made from a list item — the only kind with a follow-up to offer. */
const session = (overrides: Partial<Activity> = {}): Activity =>
  ({
    activityId: ACT,
    ownerId: USER,
    status: 'scheduled',
    objectKind: 'plan',
    type: 'watch',
    title: 'Severance',
    schedule: { date: '2026-08-25', timezone: 'UTC' },
    listId: LIST,
    listItemId: ITEM,
    details: watchSession(),
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

const list = (): List => ({
  schemaVersion: 2,
  listId: LIST,
  ownerId: USER,
  templateKey: 'watch-later',
  title: 'Movies and shows',
  icon: 'play-rect',
  emptyStateCopy: 'Add a TV show.',
  itemStateMode: {
    mode: 'stages',
    labels: { open: 'Want', active: 'Watching', done: 'Watched' },
    groupByState: true,
  },
  featureConfig: { progress: { enabled: true, kind: 'episode' } },
  slot: 'watch',
  itemCount: 1,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 1,
  archived: false,
  updatedAt: NOW,
  lastItemActivityAt: NOW,
});

const item = (progress?: ProgressValue): ListItem => ({
  itemId: ITEM,
  listId: LIST,
  rank: 'a0',
  itemRevision: 0,
  title: 'Severance',
  state: 'open',
  ...(progress === undefined ? {} : { features: { progress } }),
});

const progress = (
  overrides: Partial<Extract<ProgressValue, { kind: 'episode' }>> = {},
): ProgressValue => ({
  kind: 'episode',
  mediaKind: 'show',
  season: 2,
  episode: 4,
  ...overrides,
});

const link = (activityId = ACT): ListItemActivityLink => ({
  listId: LIST,
  itemId: ITEM,
  viewerUserId: USER,
  activityId,
  linkedAt: NOW,
});

const receiptFor = vi.fn(() => ({ key: 'k' }) as never);

/** The whole picture `readWatchFollowUpSource` would have returned, minus the storage. */
const source = (
  options: { list?: List; item?: ListItem; link?: ListItemActivityLink } = {},
) => {
  mocks.readWatchFollowUpSource.mockResolvedValue({
    list: options.list ?? list(),
    link: options.link ?? link(),
    item: options.item ?? item(progress()),
  } as never);
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  receiptFor.mockReset();
  receiptFor.mockReturnValue({ key: 'k' } as never);
  mocks.listParticipants.mockResolvedValue([] as never);
  mocks.patchActivity.mockResolvedValue(undefined as never);
  mocks.findViewerLinksTo.mockResolvedValue([] as never);
  mocks.getOccurrence.mockResolvedValue(undefined as never);
  mocks.putOccurrence.mockResolvedValue(undefined as never);
  mocks.transactWrite.mockResolvedValue(undefined as never);
  mocks.receiptItem.mockReturnValue({ Put: { Item: {} } } as never);
  mocks.assertListAccess.mockResolvedValue({ index: {}, isOwner: true } as never);
  mocks.readWatchFollowUpSource.mockResolvedValue(undefined as never);
});

const complete = (activity: Activity, input: Record<string, unknown> = {}) => {
  mocks.getActivityMeta.mockResolvedValue(activity as never);
  return completion.completeActivity(USER, ACT, input as never, NOW, receiptFor);
};

describe('what the follow-up says', () => {
  it('offers done when exposed state is the compatible fallback', async () => {
    source({ item: item() });

    const result = await complete(
      session({
        details: { kind: 'watch', mediaTitle: 'Severance', mediaKind: 'movie' },
      }),
    );

    expect(result.followUp).toEqual({
      kind: 'list_item_state',
      listId: LIST,
      listTitle: 'Movies and shows',
      itemId: ITEM,
      current: { state: 'open' },
      target: { state: 'done' },
    });
  });

  it('offers the session’s season and episode against the item’s current pair', async () => {
    source();

    const result = await complete(session());

    expect(result.followUp).toEqual({
      kind: 'watch_progress',
      listId: LIST,
      listTitle: 'Movies and shows',
      itemId: ITEM,
      mediaKind: 'show',
      current: { season: 2, episode: 4 },
      target: { season: 2, episode: 5 },
    });
  });

  it('carries movie provenance without inferring a watched transition', async () => {
    source({ item: item(progress({ mediaKind: 'movie' })) });

    const result = await complete(session());

    expect(result.followUp).toEqual({
      kind: 'watch_progress',
      listId: LIST,
      listTitle: 'Movies and shows',
      itemId: ITEM,
      mediaKind: 'movie',
      current: { season: 2, episode: 4 },
      target: { season: 2, episode: 5 },
    });
  });

  /**
   * P3-09's back-fill leaves a whole upgraded list without one. The progress branch offers
   * the season and episode the user typed on **this session**, which is not an opinion about
   * what kind of thing the item is — and `kind` still tells the client which copy to render.
   */
  it('takes the progress branch for an item that has never named a media kind', async () => {
    source({
      item: item({ kind: 'episode', season: 2, episode: 4 }),
    });

    const result = await complete(session());

    expect(result.followUp).toMatchObject({
      kind: 'watch_progress',
      target: { season: 2, episode: 5 },
    });
    expect(result.followUp).not.toHaveProperty('mediaKind');
  });

  it('carries only the fields the item actually has', async () => {
    source({ item: item({ kind: 'episode' }) });

    const result = await complete(session({ details: watchSession({ season: 1 }) }));

    expect(result.followUp).toEqual({
      kind: 'watch_progress',
      listId: LIST,
      listTitle: 'Movies and shows',
      itemId: ITEM,
      current: {},
      target: { season: 1, episode: 5 },
    });
  });

  /**
   * A rewatch. `plans-and-lists.md` §8.4 names dismissal as the right answer for one, so the
   * question is still asked rather than suppressed for being a no-op.
   */
  it('still asks when the session repeats the item’s current progress', async () => {
    source();

    const result = await complete(
      session({ details: watchSession({ season: 2, episode: 4 }) }),
    );

    expect(result.followUp).toMatchObject({ target: { season: 2, episode: 4 } });
  });

  /**
   * The API never parses its own response, so nothing else in the running system would notice
   * this service emitting a shape the published contract refuses — and the two rows the
   * schema's arms exist to forbid are `watch_progress` with `mediaKind: 'movie'` and a target
   * naming neither season nor episode, both of which are decisions made in this function.
   * Every producing path is therefore round-tripped through the contract itself.
   */
  it.each([
    ['a show', progress(), watchSession()],
    ['a movie', progress({ mediaKind: 'movie' }), watchSession()],
    ['an item with no media kind', { kind: 'episode' } as ProgressValue, watchSession()],
    [
      'a season with no episode',
      progress(),
      { kind: 'watch', mediaTitle: 'Severance', season: 2 } as ActivityDetails,
    ],
    [
      'an episode with no season',
      progress(),
      { kind: 'watch', mediaTitle: 'Severance', episode: 5 } as ActivityDetails,
    ],
  ])(
    'emits a follow-up the shared schema accepts for %s',
    async (_why, item_, details) => {
      source({ item: item(item_) });

      const result = await complete(session({ details }));

      expect(completionFollowUp.safeParse(result.followUp)).toMatchObject({
        success: true,
      });
    },
  );

  /**
   * The response body is frozen for replay before the transaction commits, so a follow-up
   * that reached the caller but not the receipt would vanish on the first retry.
   */
  it('is part of the response the idempotency receipt replays', async () => {
    source();

    const result = await complete(session());

    expect(receiptFor).toHaveBeenCalledWith(
      expect.objectContaining({ followUp: result.followUp }),
    );
  });
});

describe('what offers nothing, and does not go looking', () => {
  const neverRead = () => {
    expect(mocks.assertListAccess).not.toHaveBeenCalled();
    expect(mocks.readWatchFollowUpSource).not.toHaveBeenCalled();
  };

  it('a Plan of another kind', async () => {
    const result = await complete(
      session({ type: 'event', details: { kind: 'event' } } as never),
    );

    expect(result.followUp).toBeUndefined();
    neverRead();
  });

  it.each(['listId', 'listItemId'] as const)(
    'a watch Plan with no %s',
    async (absent) => {
      const activity = session();
      delete activity[absent];

      const result = await complete(activity);

      expect(result.followUp).toBeUndefined();
      neverRead();
    },
  );

  /**
   * A negative outcome is `skipped`, and P3-15 makes that transition clear the caller's
   * pointer. Reading it back to describe a suggestion would be describing a pointer this same
   * request is about to delete.
   */
  it('a session that did not happen', async () => {
    source();

    const result = await complete(session(), { outcome: 'didnt_happen' });

    expect(result.activity.status).toBe('skipped');
    expect(result.followUp).toBeUndefined();
    neverRead();
  });

  /** `CLAUDE.md` rule 3: one occurrence is one occurrence, and the next one already exists. */
  it('one occurrence of a recurring series', async () => {
    source();
    const recurring = session({
      recurrence: {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: '2026-08-01' }],
      },
    } as never);

    const result = await complete(recurring, { occurrenceDate: '2026-08-25' });

    expect(result.occurrence).toMatchObject({ status: 'completed' });
    expect(result.followUp).toBeUndefined();
    neverRead();
  });

  /** The idempotent no-op return is not the completion event the follow-up belongs to. */
  it('an activity that was already completed', async () => {
    source();

    const result = await complete(session({ status: 'completed', completedAt: NOW }));

    expect(result.followUp).toBeUndefined();
    neverRead();
  });
});

describe('what offers nothing after looking', () => {
  it('a list that is no longer a watch list, or an item that is gone', async () => {
    mocks.readWatchFollowUpSource.mockResolvedValue(undefined as never);

    const result = await complete(session());

    expect(mocks.readWatchFollowUpSource).toHaveBeenCalledWith(USER, LIST, {}, ITEM);
    expect(result.followUp).toBeUndefined();
  });

  /**
   * The pointer decides, not the Activity's stored `listItemId`. Planning the item again
   * moves the caller's pointer, and the superseded session must not speak for the one that
   * replaced it (ADR-034).
   */
  it('a session the caller’s pointer has since moved off', async () => {
    source({ link: link(OTHER_ACT) });

    expect((await complete(session())).followUp).toBeUndefined();
  });

  it('an item with no episode progress falls back to exposed state', async () => {
    source({ item: item() });

    expect((await complete(session())).followUp).toMatchObject({
      kind: 'list_item_state',
      target: { state: 'done' },
    });
  });

  it('an item with a different progress kind falls back without parsing it', async () => {
    source({ item: item({ kind: 'text', value: 'Chapter 4' }) });

    expect((await complete(session())).followUp).toMatchObject({
      kind: 'list_item_state',
    });
  });

  it('a show whose session has no progress falls back to exposed state', async () => {
    source();

    const result = await complete(
      session({ details: { kind: 'watch', mediaTitle: 'Severance', mediaKind: 'show' } }),
    );

    expect(result.followUp).toMatchObject({ kind: 'list_item_state' });
  });

  it('state mode none offers nothing when there is no structured progress question', async () => {
    source({
      list: { ...list(), itemStateMode: { mode: 'none' } },
      item: item(),
    });

    expect((await complete(session())).followUp).toBeUndefined();
  });

  it('an item already done offers no state fallback', async () => {
    source({ item: { ...item(), state: 'done' } });

    expect((await complete(session())).followUp).toBeUndefined();
  });
});

/**
 * The user completed their Plan. A suggestion about a list is not worth losing that to, so
 * every failure on the read path becomes silence and the completion still commits.
 */
describe('nothing on the follow-up path can fail the completion', () => {
  it.each([
    [
      'the caller has no pointer to the list',
      new AppError('not_found', 'List not found.'),
    ],
    ['the list is mid-migration', new ReadFence()],
    ['a stored row will not parse', new TypeError('bad row')],
  ])('%s', async (_why, error) => {
    mocks.assertListAccess.mockRejectedValue(error as never);

    const result = await complete(session());

    expect(result.activity.status).toBe('completed');
    expect(result.followUp).toBeUndefined();
    expect(mocks.patchActivity).toHaveBeenCalled();
  });

  it('the fenced read itself throws', async () => {
    mocks.readWatchFollowUpSource.mockRejectedValue(new ReadFence() as never);

    const result = await complete(session());

    expect(result.activity.status).toBe('completed');
    expect(result.followUp).toBeUndefined();
  });
});
