import { instant } from '@od/shared/schemas';
import type { TimeZone } from '@od/shared/time';
import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwipeableListCard } from './SwipeableListCard.web';

const activation = vi.hoisted(() => ({
  dismissActions: vi.fn(),
  markLongPress: vi.fn(),
}));
const row = vi.hoisted(() => ({
  onLongPress: undefined as (() => void) | undefined,
}));

vi.mock('../hooks/useLongPressActivation', () => ({
  useLongPressActivation: (onActivate: () => void) => ({
    activate: onActivate,
    dismissActions: activation.dismissActions,
    markLongPress: activation.markLongPress,
  }),
}));

vi.mock('./ListIndexRow', async () => {
  const { createElement } = await import('react');
  return {
    ListIndexRow: ({
      list: currentList,
      onLongPress,
    }: {
      list: List;
      onLongPress?: () => void;
    }) => {
      row.onLongPress = onLongPress;
      return createElement(
        'button',
        { 'aria-label': `${currentList.title}. List card` },
        currentList.title,
      );
    },
  };
});

const NOW = instant.parse('2026-08-26T12:00:00.000Z');
const UTC = 'UTC' as TimeZone;
const list: List = {
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  schemaVersion: 2,
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: 'groceries',
  itemCount: 12,
  doneCount: 5,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-24T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-26T18:30:00.000Z'),
};

describe('the web List-card long press', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    activation.dismissActions.mockClear();
    activation.markLongPress.mockClear();
    row.onLongPress = undefined;
  });

  afterEach(() => vi.useRealTimers());

  it('has one recognizer and opens the actions once for one pointer hold', () => {
    const onAction = vi.fn();
    render(
      <ThemeProvider scheme="light">
        <SwipeableListCard
          list={list}
          now={NOW}
          timezone={UTC}
          onPress={vi.fn()}
          actions={[
            { name: 'archive', label: 'Archive', destructive: false },
            { name: 'delete', label: 'Delete', destructive: true },
          ]}
          onAction={onAction}
        />
      </ThemeProvider>,
    );

    const card = screen.getByRole('button', { name: /^Groceries\./ });
    fireEvent.pointerDown(card, { pointerId: 1, pointerType: 'touch', button: 0 });
    act(() => vi.advanceTimersByTime(500));
    // React Native Web's private responder cannot be synthesized by jsdom, so complete the
    // shared Card recognizer explicitly. One physical hold reaches its single registered owner.
    act(() => row.onLongPress?.());
    fireEvent.pointerUp(card, { pointerId: 1, pointerType: 'touch', button: 0 });

    expect(activation.markLongPress).toHaveBeenCalledOnce();
    expect(screen.getByRole('dialog', { name: 'Groceries actions' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByTestId('list-card-actions')).toBeTruthy();

    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole('dialog', { name: 'Groceries actions' })).toBeNull();
    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      name: 'delete',
      label: 'Delete',
      destructive: true,
    });
  });

  it('keeps Archive immediate while only destructive confirmation waits for dismissal', () => {
    const onAction = vi.fn();
    render(
      <ThemeProvider scheme="light">
        <SwipeableListCard
          list={list}
          now={NOW}
          timezone={UTC}
          onPress={vi.fn()}
          actions={[
            { name: 'archive', label: 'Archive', destructive: false },
            { name: 'delete', label: 'Delete', destructive: true },
          ]}
          onAction={onAction}
        />
      </ThemeProvider>,
    );

    act(() => row.onLongPress?.());
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));

    expect(onAction).toHaveBeenCalledExactlyOnceWith({
      name: 'archive',
      label: 'Archive',
      destructive: false,
    });
  });
});
