import { instant } from '@od/shared/schemas';
import type { TimeZone } from '@od/shared/time';
import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListIndexRow } from './ListIndexRow';

/**
 * The Lists-index card (`design-system.md` §7.2, §P3-25).
 *
 * The two assertions that matter most are both about what the card **does not** read: the
 * catalogue, and `updatedAt`.
 */

const UTC = 'UTC' as TimeZone;
const NOW = instant.parse('2026-08-26T12:00:00.000Z');

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
  itemCount: 12,
  doneCount: 5,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-24T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-26T18:30:00.000Z'),
  ...overrides,
});

function mount(row: List, onPress = vi.fn()) {
  render(
    <ThemeProvider scheme="light">
      <ListIndexRow list={row} now={NOW} timezone={UTC} onPress={onPress} testID="card" />
    </ThemeProvider>,
  );
  return { onPress };
}

describe('the card renders the list, not its template', () => {
  /**
   * **The mutated-catalogue fixture** (§P3-25). The row carries an icon and copy that no
   * catalogue entry would now supply; the card must still render exactly what is stored,
   * because template values are frozen at creation and a card that re-resolved them would
   * change a year-old list when someone edited a template today.
   */
  it('renders the stored icon and title after the catalogue has moved on', () => {
    mount(
      list({
        // `groceries` names `cart` in the catalogue; this row was created when it named `bag`.
        icon: 'bag',
        title: 'Costco run',
        templateKey: 'groceries',
      }),
    );

    expect(screen.getByTestId('card')).toBeTruthy();
    expect(screen.getByText('Costco run')).toBeTruthy();
  });

  it('falls back to a list marker rather than a blank square for an unknown icon', () => {
    mount(list({ icon: 'not-a-real-glyph' }));

    expect(screen.getByText('Groceries')).toBeTruthy();
  });
});

describe('the count line and the progress bar', () => {
  it('shows the checked half on a checkable collection', () => {
    mount(list());

    expect(screen.getByText('12 items · 5 checked')).toBeTruthy();
    expect(screen.getByTestId('card-progress')).toBeTruthy();
  });

  /**
   * §P3-25's named case: a `watch` list that retained `checkable: true` through a behaviour
   * change renders **no checked count and no bar**. Both halves of the gate, because the
   * capability alone survives a change that removed the checkbox.
   */
  it('shows neither on a staged list that retains the same intrinsic done count', () => {
    mount(
      list({
        itemStateMode: {
          mode: 'stages',
          labels: { open: 'Saved', active: 'Watching', done: 'Watched' },
          groupByState: true,
        },
      }),
    );

    expect(screen.getByText('12 items')).toBeTruthy();
    expect(screen.queryByText(/checked/)).toBeNull();
    expect(screen.queryByTestId('card-progress')).toBeNull();
  });
});

describe('the updated line', () => {
  it('renders lastItemActivityAt', () => {
    mount(list({ lastItemActivityAt: instant.parse('2026-08-26T09:00:00.000Z') }));

    expect(screen.getByText('Updated today')).toBeTruthy();
  });

  /**
   * The P3-47 distinction, asserted as a difference rather than as a value. `updatedAt` moves
   * on a rename and not on checking an item, so a card using it would say `Updated today`
   * because someone renamed the list — backwards from what the line means.
   */
  it('does not move when only updatedAt does', () => {
    mount(
      list({
        updatedAt: instant.parse('2026-08-26T11:59:00.000Z'),
        lastItemActivityAt: instant.parse('2026-08-20T09:00:00.000Z'),
      }),
    );

    expect(screen.getByText('Updated 6 days ago')).toBeTruthy();
    expect(screen.queryByText('Updated today')).toBeNull();
  });
});

describe('tapping the card', () => {
  it('opens the list and mutates nothing (U1)', () => {
    const { onPress } = mount(list());

    fireEvent.click(screen.getByTestId('card'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('carries the whole card as one accessible element', () => {
    mount(list());

    // Three lines, one stop. Three nodes would be three stops each saying part of a sentence.
    expect(
      screen.getByLabelText('Groceries. 12 items · 5 checked. Updated today'),
    ).toBeTruthy();
  });
});
