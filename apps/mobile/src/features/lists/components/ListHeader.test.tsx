import { instant } from '@od/shared/schemas';
import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListHeader } from './ListHeader';

/**
 * `plans-and-lists.md` §5.6's one home for renaming, and §P3-32's rule that it has no second
 * one. `ListSettingsSheet.test.tsx` asserts the other half — that the sheet has no Rename row.
 */

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
  itemCount: 3,
  uncheckedCount: 2,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-27T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-27T09:00:00.000Z'),
  ...overrides,
});

function mount(overrides: { list?: List | undefined } = {}) {
  const onBack = vi.fn();
  const onOpenMenu = vi.fn();
  const onRename = vi.fn();
  render(
    <ThemeProvider scheme="light">
      <ListHeader
        list={'list' in overrides ? overrides.list : list()}
        onBack={onBack}
        onOpenMenu={onOpenMenu}
        onRename={onRename}
      />
    </ThemeProvider>,
  );
  return { onBack, onOpenMenu, onRename };
}

const activateTitle = () => fireEvent.click(screen.getByTestId('list-title'));
const type = (value: string) =>
  fireEvent.change(screen.getByTestId('list-title-field'), { target: { value } });

describe('renaming is inline on the title', () => {
  it('shows the title as a control, and no field until it is activated', () => {
    mount();

    expect(screen.getByText('Groceries')).toBeDefined();
    expect(screen.queryByTestId('list-title-field')).toBeNull();
    expect(screen.getByTestId('list-title').getAttribute('aria-label')).toBe(
      'Rename Groceries',
    );
  });

  it('swaps the title for a focused field pre-filled with the current name', () => {
    mount();
    activateTitle();

    const field = screen.getByTestId('list-title-field') as HTMLInputElement;
    expect(field.value).toBe('Groceries');
    expect(document.activeElement).toBe(field);
    // The control it replaced is gone while the editor is open.
    expect(screen.queryByTestId('list-title')).toBeNull();
  });

  /** One write, one field. §5.5: renaming changes nothing else. */
  it('commits the trimmed title once on Save', () => {
    const { onRename } = mount();
    activateTitle();
    type('  Favourite restaurants  ');
    fireEvent.click(screen.getByTestId('list-title-save'));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('Favourite restaurants');
  });

  it('commits on Return, the way every single-line title field does', () => {
    const { onRename } = mount();
    activateTitle();
    type('Shopping');
    fireEvent.keyDown(screen.getByTestId('list-title-field'), { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith('Shopping');
  });

  it('writes nothing on Cancel and puts the committed title back', () => {
    const { onRename } = mount();
    activateTitle();
    type('Something else');
    fireEvent.click(screen.getByTestId('list-title-cancel'));

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText('Groceries')).toBeDefined();
    expect(screen.queryByTestId('list-title-field')).toBeNull();
  });

  /**
   * §7.3: focus returns to the triggering element when a transient control closes. The field
   * replaced the title, so leaving would otherwise drop focus onto the document body.
   */
  it.each([
    ['Save', 'list-title-save'],
    ['Cancel', 'list-title-cancel'],
  ])('returns focus to the title after %s', (_label, testID) => {
    mount();
    activateTitle();
    type('Shopping');
    fireEvent.click(screen.getByTestId(testID));

    expect(document.activeElement).toBe(screen.getByTestId('list-title'));
  });

  /** A title is required (`list.ts`'s `title` schema); an empty one is refused before it flies. */
  it('refuses to save an empty title', () => {
    const { onRename } = mount();
    activateTitle();
    type('   ');
    fireEvent.click(screen.getByTestId('list-title-save'));

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByTestId('list-title-field')).toBeDefined();
    expect(screen.getByTestId('list-title-save').getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('leaves the ⋯ menu and Back where they are while editing', () => {
    const { onBack, onOpenMenu } = mount();
    activateTitle();

    fireEvent.click(screen.getByTestId('list-detail-back'));
    fireEvent.click(screen.getByTestId('list-detail-menu'));
    expect(onBack).toHaveBeenCalled();
    expect(onOpenMenu).toHaveBeenCalled();
  });

  /** Nothing to rename yet, and nothing to act on: the menu is absent, not disabled. */
  it('renders a placeholder and no menu before the list has loaded', () => {
    mount({ list: undefined });

    expect(screen.getByText('List')).toBeDefined();
    expect(screen.queryByTestId('list-detail-menu')).toBeNull();
  });
});
