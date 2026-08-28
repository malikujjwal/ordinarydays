import { instant } from '@od/shared/schemas';
import { fixedClock } from '@od/shared/time';
import type { List, ListSettingsMutation } from '@od/shared/types';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import { useToast } from '@/stores/toast';
import { useListSettings } from './useListSettings';

const calls = vi.hoisted(() => ({ patch: vi.fn(), undo: vi.fn(), uuid: vi.fn() }));
vi.mock('@od/shared/client', async (original) => ({
  ...(await original<typeof import('@od/shared/client')>()),
  patchList: calls.patch,
  undoListOperation: calls.undo,
}));
vi.mock('expo-crypto', () => ({ randomUUID: calls.uuid }));

const LIST: List = {
  schemaVersion: 2,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  templateKey: 'books',
  title: 'Reading',
  icon: 'book',
  emptyStateCopy: 'Add a book.',
  itemStateMode: { mode: 'none' },
  featureConfig: {
    progress: { enabled: false, kind: 'text' },
    subItems: { enabled: false, sectionLabel: 'Materials', singularLabel: 'Material' },
  },
  slot: null,
  itemCount: 1,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-28T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-28T09:00:00.000Z'),
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <ClockProvider clock={fixedClock(instant.parse('2026-08-28T09:00:00.000Z'))}>
    {children}
  </ClockProvider>
);

function success(list: List): ListSettingsMutation {
  return {
    list,
    undoToken: 'undo_1',
    undoExpiresAt: instant.parse('2026-08-28T09:00:06.000Z'),
  };
}

beforeEach(() => {
  calls.patch.mockReset();
  calls.undo.mockReset();
  calls.uuid.mockReset().mockReturnValue('idem_settings');
  useToast.setState({ current: undefined });
});

describe('web canonical List settings', () => {
  it('optimistically changes state mode without rewriting item data', async () => {
    calls.patch.mockReturnValue(new Promise(() => undefined));
    const mounted = renderHook(
      () => useListSettings({ list: LIST, onChanged: vi.fn(), onServerChanged: vi.fn() }),
      { wrapper },
    );

    act(() => mounted.result.current.setStateMode({ mode: 'checkbox' }));

    expect(mounted.result.current.view?.itemStateMode).toEqual({ mode: 'checkbox' });
    expect(mounted.result.current.view?.featureConfig).toEqual(LIST.featureConfig);
    expect(calls.patch).toHaveBeenCalledWith(
      expect.anything(),
      LIST.listId,
      { itemStateMode: { mode: 'checkbox' } },
      LIST.updatedAt,
      'idem_settings',
    );
  });

  it('retains feature configuration byte-for-byte while switching exposure off and on', async () => {
    calls.patch.mockResolvedValue(
      success({
        ...LIST,
        featureConfig: {
          ...LIST.featureConfig,
          progress: { enabled: true, kind: 'text' },
        },
      }),
    );
    const mounted = renderHook(
      () => useListSettings({ list: LIST, onChanged: vi.fn(), onServerChanged: vi.fn() }),
      { wrapper },
    );

    act(() => mounted.result.current.setFeatureEnabled('progress', true));
    await waitFor(() => expect(calls.patch).toHaveBeenCalledOnce());

    expect(calls.patch.mock.calls[0]?.[2]).toEqual({
      featureConfig: { progress: { enabled: true, kind: 'text' } },
    });
    expect(mounted.result.current.view?.featureConfig.subItems).toEqual(
      LIST.featureConfig.subItems,
    );
    expect(useToast.getState().current?.kind).toBe('undo');
  });

  it('never derives a semantic integration from edited Sub-item labels', async () => {
    calls.patch.mockReturnValue(new Promise(() => undefined));
    const mounted = renderHook(
      () => useListSettings({ list: LIST, onChanged: vi.fn(), onServerChanged: vi.fn() }),
      { wrapper },
    );

    act(() =>
      mounted.result.current.setSubItemLabels({
        sectionLabel: 'Ingredients',
        singularLabel: 'Ingredient',
        secondaryLabel: 'Quantity',
      }),
    );

    expect(calls.patch.mock.calls[0]?.[2]).toEqual({
      featureConfig: {
        subItems: {
          enabled: false,
          sectionLabel: 'Ingredients',
          singularLabel: 'Ingredient',
          secondaryLabel: 'Quantity',
        },
      },
    });
  });
});
