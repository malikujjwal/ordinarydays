import { timeZone } from '@od/shared/schemas';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ListsView } from '../hooks/useLists';
import { ExistingListPicker } from './ExistingListPicker';

vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  const React = await import('react');
  return {
    ...actual,
    FlatList: ({
      onEndReached,
      testID,
    }: {
      readonly onEndReached?: () => void;
      readonly testID?: string;
    }) =>
      React.createElement(
        actual.Pressable,
        {
          accessibilityRole: 'button',
          accessibilityLabel: 'Reach list end',
          onPress: onEndReached,
          testID,
        },
        React.createElement(actual.Text, null, 'Reach list end'),
      ),
  };
});

function listsView(overrides: Partial<ListsView> = {}): ListsView {
  return {
    status: 'success',
    lists: [],
    timezone: timeZone.parse('UTC'),
    viewerUserId: 'usr_local_dev',
    refetch: vi.fn(),
    isLoadingMore: false,
    isOffline: false,
    hasMore: true,
    loadMore: vi.fn(),
    ...overrides,
  };
}

function mount(lists: ListsView) {
  render(
    <ThemeProvider scheme="light">
      <ExistingListPicker
        lists={lists}
        active={[]}
        sourceActivityId="act_01J8XKQ2M4N5P6R7S8T9V0W1X3"
        selectedId={undefined}
        onSelect={() => {}}
        attachError={undefined}
        attachRequestId={undefined}
        sheetScroll={{ onScroll: vi.fn(), scrollEventThrottle: 16 }}
      />
    </ThemeProvider>,
  );
}

it('requests the next page when FlatList reaches the end', () => {
  const loadMore = vi.fn();
  mount(listsView({ loadMore }));

  fireEvent.click(screen.getByRole('button', { name: 'Reach list end' }));

  expect(loadMore).toHaveBeenCalledOnce();
});

it('does not automatically request another page after a page failure', () => {
  const loadMore = vi.fn();
  mount(
    listsView({
      loadMore,
      loadMoreFailure: {
        message: 'Something went wrong.',
        retry: vi.fn(),
      },
    }),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Reach list end' }));

  expect(loadMore).not.toHaveBeenCalled();
});
