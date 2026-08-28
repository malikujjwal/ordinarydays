import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListHeaderMenu } from './ListHeaderMenu';

const list = (overrides: Partial<List> = {}): List => ({
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  ownerId: 'usr_local_dev',
  behaviour: 'collection',
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: true, supportsLocation: false },
  slot: 'groceries',
  itemCount: 10,
  uncheckedCount: 3,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-24T09:00:00.000Z'),
  // Later than `updatedAt`: the list was renamed, then used (P3-47).
  lastItemActivityAt: instant.parse('2026-08-25T18:30:00.000Z'),
  ...overrides,
});

function mount(options: { list?: List; checkedCount?: number } = {}) {
  const onClearChecked = vi.fn();
  const onUncheckAll = vi.fn();
  const onArchive = vi.fn();
  const onOpenSettings = vi.fn();
  const onClose = vi.fn();
  render(
    <ThemeProvider scheme="light">
      <ListHeaderMenu
        open
        onClose={onClose}
        list={options.list ?? list()}
        checkedCount={options.checkedCount ?? 7}
        onClearChecked={onClearChecked}
        onUncheckAll={onUncheckAll}
        onArchive={onArchive}
        onOpenSettings={onOpenSettings}
      />
    </ThemeProvider>,
  );
  return { onClearChecked, onUncheckAll, onArchive, onOpenSettings, onClose };
}

describe('ListHeaderMenu', () => {
  it('states the count in the button, because that is what replaces the dialog', () => {
    mount({ checkedCount: 7 });

    expect(screen.getByText('Clear checked (7)')).toBeTruthy();
  });

  /**
   * **The test §P3-10 asks for, written as an assertion on the dialog's absence** — so that
   * re-adding one fails here rather than being noticed by a user.
   *
   * `Clear checked` deletes immediately and offers a 10-second undo toast instead of asking
   * (`00-open-decisions.md` item 33). It is the single deliberate exception to
   * `interaction-contract.md` §1a.1, and the exception is only defensible while the count is
   * on the button and the window is real — so this asserts the tap reaches the caller
   * directly, with nothing in between.
   */
  it('renders no confirmation dialog on tap, and calls straight through', () => {
    const { onClearChecked } = mount({ checkedCount: 7 });

    fireEvent.click(screen.getByTestId('list-clear-checked'));

    expect(onClearChecked).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(screen.queryByText(/are you sure/i)).toBeNull();
    expect(screen.queryByText(/can.t be undone/i)).toBeNull();
  });

  /**
   * The **ten seconds** themselves live in `model/bulkUndoToast.ts` and are asserted there:
   * this component only reports the tap, and a test here that claimed to check a duration
   * would be checking nothing.
   */
  it('invokes each bulk action exactly once', () => {
    const { onClearChecked, onUncheckAll } = mount();

    fireEvent.click(screen.getByTestId('list-clear-checked'));
    fireEvent.click(screen.getByTestId('list-uncheck-all'));

    expect(onClearChecked).toHaveBeenCalledTimes(1);
    expect(onUncheckAll).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
  });

  /** Absent rather than present-and-disabled: a greyed row teaches nothing (§P3-10). */
  it('omits Clear checked entirely when nothing is checked', () => {
    mount({ checkedCount: 0 });

    expect(screen.queryByTestId('list-clear-checked')).toBeNull();
    expect(screen.getByTestId('list-uncheck-all')).toBeTruthy();
  });

  /**
   * Both halves of the gate, exactly as the endpoints apply them (criterion 18). A `watch`
   * list can still carry a stored `checkable: true` and items still carrying `checked` — the
   * hidden retained state neither the renderer draws nor these actions may reach.
   */
  it.each([
    ['a watch list whose stored flag survived', list({ behaviour: 'watch' })],
    [
      'a collection with checkboxes off',
      list({ capabilities: { checkable: false, supportsLocation: false } }),
    ],
  ])('offers neither checked action on %s', (_case, subject) => {
    mount({ list: subject, checkedCount: 4 });

    expect(screen.queryByTestId('list-clear-checked')).toBeNull();
    expect(screen.queryByTestId('list-uncheck-all')).toBeNull();
  });

  it('offers Archive on every list, whatever its behaviour', () => {
    const { onArchive } = mount({ list: list({ behaviour: 'meals' }) });

    fireEvent.click(screen.getByTestId('list-archive'));

    expect(onArchive).toHaveBeenCalledTimes(1);
  });
});
