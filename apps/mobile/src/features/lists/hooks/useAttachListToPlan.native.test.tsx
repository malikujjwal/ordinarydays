import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useAttachListToPlan } from './useAttachListToPlan.native';

const calls = vi.hoisted(() => ({
  patch: vi.fn(),
  run: vi.fn(),
  sync: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: calls.uuid }));
vi.mock('@/lib/sqlite/listTransactions', () => ({
  ListTransactionService: class {
    patchSettings = calls.patch;
  },
}));
vi.mock('@/lib/sqlite/nativeState', () => ({
  requireActiveNativeState: () => ({
    account: { transactions: { run: calls.run } },
    lists: {},
    outbox: {},
    sync: { request: calls.sync },
  }),
}));

const LIST: List = {
  schemaVersion: 2,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  templateKey: 'checklist',
  title: 'Packing',
  icon: 'check-square',
  emptyStateCopy: 'Add an item.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: null,
  itemCount: 4,
  doneCount: 1,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-09-03T12:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-09-03T12:00:00.000Z'),
};

const PLAN_ID = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3';

beforeEach(() => {
  for (const call of Object.values(calls)) call.mockReset();
  calls.uuid.mockReturnValue('intent_attach');
  calls.run.mockImplementation((work: (transaction: object) => unknown) =>
    Promise.resolve(work({})),
  );
  calls.patch.mockResolvedValue(undefined);
});

it('commits the relationship locally before requesting sync', async () => {
  const mounted = renderHook(() => useAttachListToPlan());
  let attached = false;

  await act(async () => {
    attached = await mounted.result.current.attach(LIST, PLAN_ID);
  });

  expect(attached).toBe(true);
  expect(calls.patch).toHaveBeenCalledWith(
    {},
    LIST,
    { sourceActivityId: PLAN_ID },
    'intent_attach',
  );
  expect(calls.sync).toHaveBeenCalledWith('accepted-action');
});

it('logs the diagnostic but exposes only approved recovery copy', async () => {
  const diagnostic = 'SQLITE_CONSTRAINT: owner index mismatch';
  calls.run.mockRejectedValue(new Error(diagnostic));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const mounted = renderHook(() => useAttachListToPlan());

  await act(async () => {
    expect(await mounted.result.current.attach(LIST, PLAN_ID)).toBe(false);
  });

  await waitFor(() =>
    expect(mounted.result.current.errorMessage).toBe("Couldn't add this list."),
  );
  expect(mounted.result.current.errorMessage).not.toContain(diagnostic);
  expect(warning).toHaveBeenCalledWith(
    'native_list_attach_failed',
    expect.objectContaining({
      listId: LIST.listId,
      sourceActivityId: PLAN_ID,
      message: diagnostic,
    }),
  );
  warning.mockRestore();
});
