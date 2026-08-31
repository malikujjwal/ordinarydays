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
  schemaVersion: 2,
  templateKey: 'groceries',
  title: 'Groceries',
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  itemStateMode: { mode: 'checkbox' },
  featureConfig: {},
  slot: 'groceries',
  itemCount: 3,
  doneCount: 1,
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
  const onShare = vi.fn();
  render(
    <ThemeProvider scheme="light">
      <ListHeader
        list={'list' in overrides ? overrides.list : list()}
        onBack={onBack}
        onOpenMenu={onOpenMenu}
        onRename={onRename}
        onShare={onShare}
      />
    </ThemeProvider>,
  );
  return { onBack, onOpenMenu, onRename, onShare };
}

const activateTitle = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Rename Groceries' }));
const type = (value: string) =>
  fireEvent.change(screen.getByLabelText('List name'), { target: { value } });

describe('renaming is inline on the title', () => {
  it('shows the title as a control, and no field until it is activated', () => {
    mount();

    const navigation = screen.getByTestId('list-header-navigation-line');
    const titleLine = screen.getByTestId('list-header-title-line');
    const titleControl = screen.getByRole('button', { name: 'Rename Groceries' });
    expect(screen.getByText('Groceries')).toBeDefined();
    expect(screen.queryByLabelText('List name')).toBeNull();
    expect(titleControl).toBeTruthy();
    expect(screen.getByTestId('list-title-pencil')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share' })).toBeTruthy();
    expect(navigation.contains(screen.getByRole('button', { name: 'Back' }))).toBe(true);
    expect(navigation.contains(screen.getByRole('button', { name: 'Share' }))).toBe(true);
    expect(navigation.contains(screen.getByRole('button', { name: 'More' }))).toBe(true);
    expect(navigation.contains(titleControl)).toBe(false);
    expect(titleLine.contains(titleControl)).toBe(true);
    expect(screen.getByTestId('list-header-title-slot').getAttribute('style')).toContain(
      'flex: 1',
    );
    expect(screen.getByTestId('list-header-share-slot')).toBeTruthy();
    expect(screen.getByTestId('list-header-more-slot')).toBeTruthy();
  });

  it('lets a long title use two lines below fixed navigation actions', () => {
    mount({
      list: list({ title: 'A deliberately long list title that needs two lines' }),
    });

    const title = screen.getByText('A deliberately long list title that needs two lines');
    expect(title.getAttribute('aria-label')).toBeNull();
    expect(title.getAttribute('style')).toContain('webkit-line-clamp: 2');
    expect(screen.getByTestId('list-header-share-slot').getAttribute('style')).toContain(
      'min-width: 64px',
    );
    expect(screen.getByTestId('list-header-share-slot').getAttribute('style')).toContain(
      'flex-shrink: 0',
    );
    expect(
      screen.getByTestId('list-header-navigation-line').contains(
        screen.getByRole('button', {
          name: 'Rename A deliberately long list title that needs two lines',
        }),
      ),
    ).toBe(false);
  });

  it('swaps the title for a focused field pre-filled with the current name', () => {
    mount();
    activateTitle();

    const field = screen.getByLabelText('List name') as HTMLInputElement;
    expect(field.value).toBe('Groceries');
    expect(document.activeElement).toBe(field);
    // The control it replaced is gone while the editor is open.
    expect(screen.queryByRole('button', { name: 'Rename Groceries' })).toBeNull();
  });

  /** One write, one field. §5.5: renaming changes nothing else. */
  it('commits the trimmed title once on blur, with no Save or Cancel controls', () => {
    const { onRename } = mount();
    activateTitle();
    type('  Favourite restaurants  ');
    fireEvent.blur(screen.getByLabelText('List name'));

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('Favourite restaurants');
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('commits on Return, the way every single-line title field does', () => {
    const { onRename } = mount();
    activateTitle();
    type('Shopping');
    fireEvent.keyDown(screen.getByLabelText('List name'), { key: 'Enter' });

    expect(onRename).toHaveBeenCalledWith('Shopping');
  });

  it('writes nothing for a blank title on blur and puts the committed title back', () => {
    const { onRename } = mount();
    activateTitle();
    type('   ');
    fireEvent.blur(screen.getByLabelText('List name'));

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByText('Groceries')).toBeDefined();
    expect(screen.queryByLabelText('List name')).toBeNull();
  });

  /**
   * §7.3: focus returns to the triggering element when a transient control closes. The field
   * replaced the title, so leaving would otherwise drop focus onto the document body.
   */
  it('returns focus to the title after Return', () => {
    mount();
    activateTitle();
    type('Shopping');
    fireEvent.keyDown(screen.getByLabelText('List name'), { key: 'Enter' });

    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Rename Groceries' }),
    );
  });

  /** A title is required (`list.ts`'s `title` schema); an empty one is refused before it flies. */
  it('reverts an empty title when Return is pressed', () => {
    const { onRename } = mount();
    activateTitle();
    type('   ');
    fireEvent.keyDown(screen.getByLabelText('List name'), { key: 'Enter' });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('List name')).toBeNull();
    expect(screen.getByText('Groceries')).toBeDefined();
  });

  it('leaves Share, the ⋯ menu and Back in the compact header while editing', () => {
    const { onBack, onOpenMenu, onShare } = mount();
    activateTitle();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(onBack).toHaveBeenCalled();
    expect(onShare).toHaveBeenCalled();
    expect(onOpenMenu).toHaveBeenCalled();
  });

  /** Nothing to rename yet, and nothing to act on: the menu is absent, not disabled. */
  it('renders a placeholder and no menu before the list has loaded', () => {
    mount({ list: undefined });

    expect(screen.getByText('List')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull();
  });
});
