import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListHeaderMenu } from './ListHeaderMenu';

const list = (overrides: Partial<List> = {}): List => ({
  schemaVersion: 2,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: 'groceries',
  itemCount: 10,
  doneCount: 7,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-24T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-25T18:30:00.000Z'),
  ...overrides,
});

function mount(subject = list(), checkedCount = 7) {
  const actions = {
    onClose: vi.fn(),
    onClearDone: vi.fn(),
    onUncheckAll: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  render(
    <ThemeProvider scheme="light">
      <ListHeaderMenu open list={subject} checkedCount={checkedCount} {...actions} />
    </ThemeProvider>,
  );
  return actions;
}

describe('ListHeaderMenu', () => {
  it('offers both immediate done-set actions with their count', () => {
    const actions = mount();

    fireEvent.click(screen.getByTestId('list-clear-checked'));
    fireEvent.click(screen.getByTestId('list-uncheck-all'));

    expect(screen.getByText('Clear checked (7)')).toBeTruthy();
    expect(screen.getByText('Uncheck all (7)')).toBeTruthy();
    expect(actions.onClearDone).toHaveBeenCalledOnce();
    expect(actions.onUncheckAll).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  it('hides bulk state actions outside checkbox mode and when no done rows exist', () => {
    mount(list({ itemStateMode: { mode: 'none' } }), 7);
    expect(screen.queryByTestId('list-clear-checked')).toBeNull();
    expect(screen.queryByTestId('list-uncheck-all')).toBeNull();

    mount(list(), 0);
    expect(screen.queryByText(/Uncheck all/)).toBeNull();
  });

  it('keeps settings and archive available for every state mode', () => {
    const actions = mount(
      list({
        itemStateMode: {
          mode: 'stages',
          labels: { open: 'Saved', active: 'Working', done: 'Done' },
          groupByState: true,
        },
      }),
    );

    fireEvent.click(screen.getByTestId('list-settings-open'));
    fireEvent.click(screen.getByTestId('list-archive'));

    expect(actions.onOpenSettings).toHaveBeenCalledOnce();
    expect(actions.onArchive).toHaveBeenCalledOnce();
  });

  it('puts List settings first and explains what it contains', () => {
    mount();

    const sheet = screen.getByTestId('list-header-menu');
    const settings = screen.getByTestId('list-settings-open');
    const clear = screen.getByTestId('list-clear-checked');
    expect(
      settings.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(sheet.textContent).toContain('State, item details and planning');
  });

  it('makes list deletion discoverable from the detail overflow menu', () => {
    const actions = mount();

    fireEvent.click(screen.getByRole('button', { name: 'Delete list' }));

    expect(actions.onDelete).toHaveBeenCalledOnce();
  });
});
