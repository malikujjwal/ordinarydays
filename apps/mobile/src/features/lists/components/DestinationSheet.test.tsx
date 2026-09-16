import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DestinationSheet } from './DestinationSheet';

vi.mock('expo-crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000000',
}));

const OWNER = 'usr_01J0000000000000000000000B';

function list(
  listId: string,
  title: string,
  slot: List['slot'],
  itemStateMode: List['itemStateMode'],
): List {
  return {
    schemaVersion: 2,
    listId,
    ownerId: OWNER,
    templateKey: 'blank',
    title,
    icon: 'list',
    emptyStateCopy: '',
    itemStateMode,
    featureConfig: {},
    slot,
    itemCount: 0,
    doneCount: 0,
    memberCount: 1,
    rankVersion: 0,
    archived: false,
    updatedAt: '2026-08-24T09:00:00.000Z',
    lastItemActivityAt: '2026-08-24T09:00:00.000Z',
  } as List;
}

const GROCERIES = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1A1', 'Groceries', 'groceries', {
  mode: 'checkbox',
});
const CHECKLIST = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1A2', 'Camping checklist', null, {
  mode: 'checkbox',
});
const UNTITLED = list('lst_01J8XKQ2M4N5P6R7S8T9V0W1A3', 'Untitled list', null, {
  mode: 'none',
});
const INCAPABLE_GROCERIES = list(
  'lst_01J8XKQ2M4N5P6R7S8T9V0W1A4',
  'Groceries without checkboxes',
  'groceries',
  { mode: 'none' },
);

function mount(
  lists: readonly List[] = [GROCERIES, CHECKLIST, UNTITLED, INCAPABLE_GROCERIES],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(['lists'], {
    pages: [{ data: lists, meta: {} }],
    pageParams: [undefined],
  });
  client.setQueryData(['me'], {
    userId: OWNER,
    displayName: 'Dev',
    timezone: 'America/New_York',
    currency: 'USD',
    weekStartsOn: 1,
    defaultLists: {},
  });
  const onChoose = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ThemeProvider scheme="light">{children}</ThemeProvider>
    </QueryClientProvider>
  );
  render(
    <DestinationSheet
      open
      slot="groceries"
      current={undefined}
      onChoose={onChoose}
      onClose={() => {}}
    />,
    { wrapper },
  );
  return { onChoose };
}

describe('ingredient destination capability', () => {
  it('never offers Blank or an incapable groceries-slot list', async () => {
    const { onChoose } = mount();

    await screen.findByTestId(`destination-sheet-list-${GROCERIES.listId}`);
    expect(
      screen.queryByTestId(`destination-sheet-list-${INCAPABLE_GROCERIES.listId}`),
    ).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Choose another list' }));

    expect(
      screen.getByTestId(`destination-sheet-list-${CHECKLIST.listId}`),
    ).toBeDefined();
    expect(screen.queryByText('Untitled list')).toBeNull();
    expect(screen.queryByText('Groceries without checkboxes')).toBeNull();
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('hides Choose another list when every capable list already holds the slot', async () => {
    mount([GROCERIES, UNTITLED, INCAPABLE_GROCERIES]);
    await screen.findByTestId(`destination-sheet-list-${GROCERIES.listId}`);
    expect(screen.queryByRole('button', { name: 'Choose another list' })).toBeNull();
  });

  it('limits New list to the three checkbox templates', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'New list' }));

    expect(screen.queryByTestId('list-style-blank')).toBeNull();
    expect(screen.getByTestId('list-style-checklist')).toBeDefined();
    expect(screen.getByTestId('list-style-groceries')).toBeDefined();
    expect(screen.getByTestId('list-style-places-to-visit')).toBeDefined();
    expect(screen.getByTestId('list-style-grid').children).toHaveLength(3);
  });
});
