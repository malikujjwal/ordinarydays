import type { Activity } from '@od/shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../repositories/activityRepository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../repositories/activityRepository.js')
  >('../repositories/activityRepository.js');
  return {
    ...actual,
    getActivityMeta: vi.fn(),
    getActivityIndex: vi.fn(),
    listStoredPrepTaskPointers: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('../repositories/listRepository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../repositories/listRepository.js')
  >('../repositories/listRepository.js');
  return {
    ...actual,
    batchGetDetailHydration: vi.fn(),
    listSourceListIds: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('../repositories/activityUpdateRepository.js', () => ({
  listActivityUpdates: vi.fn(() => Promise.resolve({ updates: [] })),
}));

vi.mock('../repositories/reminderRepository.js', () => ({
  listForUser: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../repositories/occurrenceRepository.js', () => ({
  countCompleted: vi.fn(() => Promise.resolve(0)),
  get: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../repositories/attachmentRepository.js', async () => {
  const actual = await vi.importActual<
    typeof import('../repositories/attachmentRepository.js')
  >('../repositories/attachmentRepository.js');
  return {
    ...actual,
    listAttachments: vi.fn(() => Promise.resolve([])),
  };
});

vi.mock('./attachmentService.js', async () => {
  const actual = await vi.importActual<typeof import('./attachmentService.js')>(
    './attachmentService.js',
  );
  return {
    ...actual,
    drainPendingUploads: vi.fn(() => Promise.resolve()),
  };
});

const repository = await import('../repositories/activityRepository.js');
const listRepository = await import('../repositories/listRepository.js');
const { getActivityDetail } = await import('./activityService.js');

const USER = 'usr_local_dev';
const NOW = '2026-08-09T12:00:00.000Z';
const ACT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const PARENT = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X9';
const LIST = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1XD';
const ITEM = 'itm_01J8XKQ2M4N5P6R7S8T9V0W1XC';

const emptyHydration = () => ({
  sourceLists: new Map(),
  childRestoredStatuses: new Map(),
  activityTitles: new Map(),
});

const stored = (overrides: Record<string, unknown> = {}): Activity =>
  ({
    activityId: ACT,
    ownerId: USER,
    status: 'saved',
    objectKind: 'task',
    type: 'task',
    title: 'Peel potatoes',
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
    ...overrides,
  }) as Activity;

beforeEach(() => {
  vi.mocked(repository.getActivityMeta).mockReset();
  vi.mocked(repository.getActivityIndex).mockReset();
  vi.mocked(repository.getActivityIndex).mockResolvedValue(undefined);
  vi.mocked(repository.listStoredPrepTaskPointers).mockReset();
  vi.mocked(repository.listStoredPrepTaskPointers).mockResolvedValue([]);
  vi.mocked(listRepository.listSourceListIds).mockReset();
  vi.mocked(listRepository.listSourceListIds).mockResolvedValue([]);
  vi.mocked(listRepository.batchGetDetailHydration).mockReset();
  vi.mocked(listRepository.batchGetDetailHydration).mockResolvedValue(emptyHydration());
});

const load = () => getActivityDetail(USER, { kind: 'activity', activityId: ACT }, NOW);

describe('getActivityDetail named parent and source list', () => {
  it('includes parent with title when parent META hydrates', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(
      stored({ parentActivityId: PARENT }),
    );
    vi.mocked(listRepository.batchGetDetailHydration).mockResolvedValue({
      ...emptyHydration(),
      activityTitles: new Map([[PARENT, 'Sunday roast']]),
    });

    const detail = await load();

    expect(detail.parent).toEqual({ activityId: PARENT, title: 'Sunday roast' });
    expect(listRepository.batchGetDetailHydration).toHaveBeenCalledWith(
      USER,
      [],
      [PARENT],
    );
  });

  it('omits parent when there is no parentActivityId', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(stored());

    const detail = await load();

    expect(detail).not.toHaveProperty('parent');
    expect(listRepository.batchGetDetailHydration).toHaveBeenCalledWith(USER, [], []);
  });

  it('omits parent when the title cannot be hydrated', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(
      stored({ parentActivityId: PARENT }),
    );

    const detail = await load();

    expect(detail).not.toHaveProperty('parent');
  });

  it('includes sourceList only when hydration proves list access', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(
      stored({
        objectKind: 'plan',
        type: 'event',
        details: { kind: 'event' },
        title: 'Dinner',
        listId: LIST,
        listItemId: ITEM,
      }),
    );
    vi.mocked(listRepository.batchGetDetailHydration).mockResolvedValue({
      ...emptyHydration(),
      sourceLists: new Map([
        [
          LIST,
          {
            listId: LIST,
            title: 'Weekly shop',
            icon: 'list',
            itemCount: 4,
            doneCount: 1,
          },
        ],
      ]),
    });

    const detail = await load();

    expect(detail.sourceList).toEqual({ listId: LIST, title: 'Weekly shop' });
    expect(detail.activity).not.toHaveProperty('listId');
    expect(detail.activity).not.toHaveProperty('listItemId');
    expect(JSON.stringify(detail.activity)).not.toContain('lst_');
    expect(JSON.stringify(detail.activity)).not.toContain('itm_');
    expect(listRepository.batchGetDetailHydration).toHaveBeenCalledWith(USER, [LIST], []);
  });

  it('withholds sourceList when list access is not in the hydration grant', async () => {
    vi.mocked(repository.getActivityMeta).mockResolvedValue(
      stored({
        objectKind: 'plan',
        type: 'event',
        details: { kind: 'event' },
        title: 'Dinner',
        listId: LIST,
        listItemId: ITEM,
      }),
    );

    const detail = await load();

    expect(detail).not.toHaveProperty('sourceList');
    expect(detail.activity).not.toHaveProperty('listId');
    expect(detail.activity).not.toHaveProperty('listItemId');
    expect(JSON.stringify(detail)).not.toContain('lst_');
    expect(JSON.stringify(detail)).not.toContain('itm_');
  });
});
