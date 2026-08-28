import { instant } from '@od/shared/schemas';
import type { List, ListBehaviourConfirmation } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { describe, expect, it, vi } from 'vitest';
import type { ListSettings } from '../hooks/useListSettings';
import { ListSettingsSheet } from './ListSettingsSheet';

/**
 * `plans-and-lists.md` §5.5's settings table and §P3-32's sheet.
 *
 * The hook is stubbed, so what is under test is the surface's own rules: which controls exist
 * on which behaviour, what each of them says, and that the destructive dialog renders the
 * server's numbers rather than any this component could compute.
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
  itemCount: 20,
  uncheckedCount: 2,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-27T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-27T09:00:00.000Z'),
  ...overrides,
});

const preview = (
  overrides: Partial<ListBehaviourConfirmation> = {},
): ListBehaviourConfirmation => ({
  fromBehaviour: 'watch',
  toBehaviour: 'collection',
  itemVersion: 12,
  itemCount: 7,
  fields: ['Watch status', 'Season', 'Episode'],
  ...overrides,
});

function mount(
  options: { list?: List; confirmation?: ListBehaviourConfirmation; busy?: boolean } = {},
) {
  const settings: ListSettings = {
    view: options.list ?? list(),
    rename: vi.fn(),
    setCapability: vi.fn(),
    setSlot: vi.fn(),
    changeBehaviour: vi.fn(),
    confirmation: options.confirmation,
    confirmBehaviour: vi.fn(),
    cancelBehaviour: vi.fn(),
    busy: options.busy ?? false,
  };
  const onClose = vi.fn();
  render(
    <SafeAreaProvider>
      <ThemeProvider scheme="light">
        <ListSettingsSheet
          open
          onClose={onClose}
          list={options.list ?? list()}
          settings={settings}
        />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
  return { settings, onClose };
}

describe('what the sheet is, and what it is not', () => {
  /**
   * §5.6 puts renaming inline on the header title; §P3-32 forbids duplicating it here. Written
   * as an assertion on the **absence** so re-adding a row fails this test.
   */
  it('has no Rename row of any kind', () => {
    mount();

    expect(screen.queryByText(/rename/i)).toBeNull();
    expect(screen.queryByTestId('list-title-field')).toBeNull();
  });

  /** §5.5: "the sheet contains no 'type' control of any kind". */
  it('has no type or kind control', () => {
    mount();

    expect(screen.queryByText(/^(type|kind)$/i)).toBeNull();
  });

  /** A settings surface, not a wizard: nothing is staged, so there is nothing to save. */
  it('has no Save button', () => {
    mount();

    expect(screen.queryByText('Save')).toBeNull();
  });
});

describe('the capability controls', () => {
  it('offers both, labelled as §5.5 labels them', () => {
    mount();

    expect(screen.getByText('Show checkboxes')).toBeDefined();
    expect(screen.getByText('Add a place to items')).toBeDefined();
  });

  it('says that turning either off retains what is stored', () => {
    mount();

    expect(
      screen.getByText(
        'Turning this off keeps every tick, ready for when you turn it back on.',
      ),
    ).toBeDefined();
    expect(
      screen.getByText('Turning this off keeps every place you have saved.'),
    ).toBeDefined();
  });

  it('sends the opposite of the current flag, once', () => {
    const { settings } = mount();
    fireEvent.click(screen.getByTestId('list-settings-checkable'));

    expect(settings.setCapability).toHaveBeenCalledTimes(1);
    expect(settings.setCapability).toHaveBeenCalledWith('checkable', false);
  });

  /**
   * The state is spoken, because React Native Web drops `accessibilityState.checked` on a
   * `Pressable` and the glyph alone would make colour the only carrier (§5.1).
   */
  it("speaks each flag's state rather than leaving it to the tick", () => {
    mount({ list: list({ capabilities: { checkable: true, supportsLocation: false } }) });

    expect(screen.getByRole('checkbox', { name: 'Show checkboxes, on' })).toBeDefined();
    expect(
      screen.getByRole('checkbox', { name: 'Add a place to items, off' }),
    ).toBeDefined();
  });

  /**
   * §5.5: on `watch` or `meals` the flags are retained but drive no control. The rows go; the
   * stored values do not.
   */
  it.each(['watch', 'meals'] as const)('is absent on a %s list', (behaviour) => {
    mount({
      list: list({
        behaviour,
        capabilities: { checkable: true, supportsLocation: true },
      }),
    });

    expect(screen.queryByTestId('list-settings-capabilities')).toBeNull();
    expect(screen.queryByText('Show checkboxes')).toBeNull();
    expect(screen.queryByText('Add a place to items')).toBeNull();
  });
});

describe('the default destination', () => {
  it('names the three slots and says what each one means', () => {
    mount();

    expect(screen.getByText('Send ingredients here by default')).toBeDefined();
    expect(screen.getByText('Send things to watch here by default')).toBeDefined();
    expect(screen.getByText('Send meal ideas here by default')).toBeDefined();
  });

  it('marks the current slot as the chosen one', () => {
    mount({ list: list({ slot: 'groceries' }) });

    expect(
      screen.getByTestId('list-settings-slot-groceries').getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByTestId('list-settings-slot-none').getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('clears the slot with an explicit choice rather than a second control', () => {
    const { settings } = mount();
    fireEvent.click(screen.getByTestId('list-settings-slot-none'));

    expect(settings.setSlot).toHaveBeenCalledWith(null);
  });

  it('sends one slot per row', () => {
    const { settings } = mount();
    fireEvent.click(screen.getByTestId('list-settings-slot-meals'));

    expect(settings.setSlot).toHaveBeenCalledWith('meals');
  });

  /** §5.5's edge case: the profile default goes with it, and the sheet says so. */
  it('says that changing this can change the profile default', () => {
    mount();

    expect(
      screen.getByText(
        'If this list is your default for that, changing it here changes that too.',
      ),
    ).toBeDefined();
  });
});

describe('the behaviour choices', () => {
  it('offers the two the list is not, and never the one it is', () => {
    mount({ list: list({ behaviour: 'collection' }) });

    expect(screen.getByText('Turn this into a watchlist')).toBeDefined();
    expect(screen.getByText('Turn this into a meals list')).toBeDefined();
    expect(screen.queryByText('Turn this into a plain list')).toBeNull();
  });

  it('previews what an upgrade gains before the tap', () => {
    mount({ list: list({ behaviour: 'collection' }) });

    expect(
      screen.getByText('Items will gain a watch status, season and episode.'),
    ).toBeDefined();
    expect(screen.getByText('Items will gain a list of ingredients.')).toBeDefined();
  });

  /** ADR-032: behaviour never changes the presentation the list copied at creation. */
  it('promises the name, icon and empty-list words stay as they are', () => {
    mount();

    expect(
      screen.getByText('The name, icon and empty-list words stay exactly as they are.'),
    ).toBeDefined();
  });

  it('applies an upgrade with no dialog', () => {
    const { settings } = mount({ list: list({ behaviour: 'collection' }) });
    fireEvent.click(screen.getByTestId('list-settings-behaviour-watch'));

    expect(settings.changeBehaviour).toHaveBeenCalledWith('watch');
    expect(screen.queryByTestId('list-behaviour-confirm')).toBeNull();
  });
});

describe('the destructive confirmation', () => {
  it('renders the server field list and count verbatim, in §1a.1 shape', () => {
    mount({
      list: list({ behaviour: 'watch', title: 'Watchlist' }),
      confirmation: preview(),
    });

    expect(screen.getByText('Turn "Watchlist" into a plain list?')).toBeDefined();
    expect(
      screen.getByText('This will remove: Watch status, season and episode from 7 items'),
    ).toBeDefined();
    expect(
      screen.getByText('Keeps: every item, its title, its note, and its order.'),
    ).toBeDefined();
  });

  /**
   * §1a.1 rule 2: the count is the records that carry the data, not the collection's size. The
   * list here holds twenty items and the dialog says seven, because seven is what the server
   * measured.
   */
  it('states the server count and not the list size', () => {
    mount({
      list: list({ behaviour: 'watch', title: 'Watchlist', itemCount: 20 }),
      confirmation: preview({ itemCount: 7 }),
    });

    expect(screen.queryByText(/20 items/)).toBeNull();
    expect(screen.getByText(/7 items/)).toBeDefined();
  });

  it('puts Cancel first and repeats the verb on the destructive button', () => {
    mount({ list: list({ behaviour: 'watch' }), confirmation: preview() });

    expect(screen.getByTestId('confirm-cancel').textContent).toContain('Cancel');
    expect(screen.getByTestId('confirm-accept').textContent).toContain(
      'Turn into a plain list',
    );
  });

  it('hides the settings controls while the question is open', () => {
    mount({ list: list({ behaviour: 'watch' }), confirmation: preview() });

    expect(screen.queryByTestId('list-settings-behaviour')).toBeNull();
    expect(screen.queryByTestId('list-settings-slot')).toBeNull();
  });

  it('cancels back to the settings, writing nothing', () => {
    const { settings } = mount({
      list: list({ behaviour: 'watch' }),
      confirmation: preview(),
    });
    fireEvent.click(screen.getByTestId('confirm-cancel'));

    expect(settings.cancelBehaviour).toHaveBeenCalledTimes(1);
    expect(settings.changeBehaviour).not.toHaveBeenCalled();
  });

  it('confirms through the echoing call, not through a fresh choice', () => {
    const { settings } = mount({
      list: list({ behaviour: 'watch' }),
      confirmation: preview(),
    });
    fireEvent.click(screen.getByTestId('confirm-accept'));

    expect(settings.confirmBehaviour).toHaveBeenCalledTimes(1);
    expect(settings.changeBehaviour).not.toHaveBeenCalled();
  });
});
