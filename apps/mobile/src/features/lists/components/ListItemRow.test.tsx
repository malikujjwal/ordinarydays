import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ListBehaviour, ListItemPlanState, ListItemView } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RowList } from '../model/listItemRow';
import { ListItemRow, type ListItemRowProps } from './ListItemRow';

/**
 * The one item renderer (§P3-28, `plans-and-lists.md` §5.7, §6.2, §7.5).
 *
 * The matrix is the point. Every rule this component holds is of the form "exactly when", and
 * the failures worth catching are all the *other* half: a checkbox on a watch list that kept a
 * stale flag, a location line on a list that stopped being a collection, a state line on a
 * pointer with no date. So each gate is asserted from both directions, over fixtures whose
 * retained values are deliberately left set.
 */

const ITEM_ID = 'itm_01J000000000000000000000AA';

const item = (overrides: Partial<ListItemView> = {}): ListItemView => ({
  itemId: ITEM_ID,
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  rank: 'm',
  title: 'Chicken',
  checked: false,
  ...overrides,
});

const list = (
  behaviour: ListBehaviour,
  checkable: boolean,
  supportsLocation = false,
): RowList => ({ behaviour, capabilities: { checkable, supportsLocation } });

function mount(props: Partial<ListItemRowProps> = {}) {
  render(
    <ThemeProvider scheme="light">
      <ListItemRow
        list={list('collection', true)}
        item={item()}
        testID="row"
        {...props}
      />
    </ThemeProvider>,
  );
}

const checkbox = () => screen.queryByTestId('row-checkbox');
const location = () => screen.queryByTestId('row-location');
const planState = () => screen.queryByTestId('row-plan-state');

/** A place and a tick, kept on every fixture so a failed gate is proved to *hide* them. */
const RETAINED = {
  checked: true,
  location: { label: 'Zahav', address: '237 St James Place' },
} satisfies Partial<ListItemView>;

const SCHEDULED: ListItemPlanState = {
  type: 'event',
  status: 'scheduled',
  schedule: { date: '2026-08-29', time: '19:00', timezone: 'America/New_York' },
};

describe('the checkbox appears exactly on a checkable collection', () => {
  it.each([
    ['collection', true, true],
    ['collection', false, false],
    ['watch', true, false],
    ['watch', false, false],
    ['meals', true, false],
    ['meals', false, false],
  ] as const)(
    '%s with checkable=%s renders a checkbox: %s',
    (behaviour, checkable, expected) => {
      mount({
        list: list(behaviour, checkable),
        item: item({
          ...RETAINED,
          ...(behaviour === 'watch'
            ? { details: { behaviour: 'watch', watchStatus: 'want' } as const }
            : {}),
          ...(behaviour === 'meals' ? { details: { behaviour: 'meals' } as const } : {}),
        }),
      });

      expect(checkbox() !== null).toBe(expected);
    },
  );

  /**
   * The retained half of the rule. A `watch` list can carry a `checkable: true` a behaviour
   * change left behind, along with `checked` values — and the renderer hides them rather than
   * clearing them (§5.5, §P3-28's edge cases).
   */
  it('hides a retained tick under a failed gate without changing it', () => {
    const stored = item({
      ...RETAINED,
      details: { behaviour: 'watch', watchStatus: 'want' },
    });
    mount({ list: list('watch', true), item: stored });

    expect(checkbox()).toBeNull();
    // Nothing struck either: a strike is the visible half of an operative tick.
    expect(screen.getByTestId('row-body').textContent).toContain('Chicken');
    // The fixture is untouched — this component writes nothing at all.
    expect(stored.checked).toBe(true);
  });

  it('strikes the title only where the tick is operative', () => {
    mount({ list: list('collection', true), item: item({ checked: true }) });
    expect(screen.getByTestId('row-body').innerHTML).toContain('line-through');
  });

  /**
   * The tick's write has no owning phase task yet. Until it does, the control says so rather
   * than accepting a tap and discarding it.
   */
  it('is disabled, not inert, when no caller can operate it', () => {
    // No handler at all, which is what an unowned write looks like from here.
    mount();

    expect(screen.getByTestId('row-checkbox').getAttribute('aria-disabled')).toBe('true');
  });

  it('is the only tap that mutates', () => {
    const onToggleChecked = vi.fn();
    const onOpen = vi.fn();
    mount({ onToggleChecked, onOpen });

    fireEvent.click(screen.getByTestId('row-checkbox'));
    expect(onToggleChecked).toHaveBeenCalledWith(true);
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('row-body'));
    // U1: the body opens, and opening is not a write.
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onToggleChecked).toHaveBeenCalledOnce();
  });
});

describe('the location line appears exactly on a qualifying collection', () => {
  it.each([
    ['collection', true, true],
    ['collection', false, false],
    ['watch', true, false],
    ['meals', true, false],
  ] as const)(
    '%s with supportsLocation=%s renders a place: %s',
    (behaviour, supportsLocation, expected) => {
      mount({
        list: list(behaviour, false, supportsLocation),
        item: item({
          ...RETAINED,
          ...(behaviour === 'watch'
            ? { details: { behaviour: 'watch', watchStatus: 'want' } as const }
            : {}),
          ...(behaviour === 'meals' ? { details: { behaviour: 'meals' } as const } : {}),
        }),
      });

      expect(location() !== null).toBe(expected);
    },
  );

  it('renders nothing for a qualifying collection with no stored place', () => {
    mount({ list: list('collection', false, true), item: item() });

    expect(location()).toBeNull();
  });

  /**
   * The converted-fixture case §P3-28 names: both the flag and the stored location survive the
   * behaviour change, and neither the subtitle nor the maps target is drawn.
   */
  it.each(['watch', 'meals'] as const)(
    'retains flag and location on a converted %s list while rendering neither',
    (behaviour) => {
      const stored = item({
        ...RETAINED,
        details:
          behaviour === 'watch'
            ? { behaviour: 'watch', watchStatus: 'want' }
            : { behaviour: 'meals' },
      });
      mount({ list: list(behaviour, true, true), item: stored });

      expect(location()).toBeNull();
      expect(screen.queryByText('237 St James Place')).toBeNull();
      expect(stored.location?.address).toBe('237 St James Place');
    },
  );

  it('opens Maps from its own target, not from the body', () => {
    const onOpenLocation = vi.fn();
    const onOpen = vi.fn();
    mount({
      list: list('collection', false, true),
      item: item(RETAINED),
      onOpenLocation,
      onOpen,
    });

    fireEvent.click(screen.getByTestId('row-location'));
    expect(onOpenLocation).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('watch and meals', () => {
  it('renders the status chip and S2 E4 for a show, and no checkbox', () => {
    mount({
      list: list('watch', true),
      item: item({
        title: 'Severance',
        details: {
          behaviour: 'watch',
          mediaKind: 'show',
          watchStatus: 'watching',
          season: 2,
          episode: 4,
        },
      }),
    });

    expect(screen.getByText('Watching')).toBeDefined();
    expect(screen.getByText('S2 E4')).toBeDefined();
    expect(checkbox()).toBeNull();
  });

  /** A movie has no season to count; an episode number on a film is a category error. */
  it('renders no progress for a movie', () => {
    mount({
      list: list('watch', false),
      item: item({
        title: 'Arrival',
        details: { behaviour: 'watch', mediaKind: 'movie', watchStatus: 'want' },
      }),
    });

    expect(screen.getByText('Want to watch')).toBeDefined();
    expect(screen.queryByTestId('row-progress')).toBeNull();
  });

  it('renders the ingredient count, including none', () => {
    mount({
      list: list('meals', false),
      item: item({
        title: 'Chicken tacos',
        details: {
          behaviour: 'meals',
          ingredients: [
            { ingredientId: 'ing_1', name: 'Chicken' },
            { ingredientId: 'ing_2', name: 'Tortillas' },
          ],
        },
      }),
    });
    expect(screen.getByText('2 ingredients')).toBeDefined();
  });

  it.each([
    [undefined, 'No ingredients'],
    [[{ ingredientId: 'ing_1', name: 'Chicken' }], '1 ingredient'],
  ])('renders %j as %s', (ingredients, expected) => {
    mount({
      list: list('meals', false),
      item: item({
        details: {
          behaviour: 'meals',
          ...(ingredients === undefined ? {} : { ingredients }),
        },
      }),
    });

    expect(screen.getByText(expected)).toBeDefined();
  });

  /**
   * Invalid data stays invalid. A committed `watch` item with no typed details is rejected by
   * the schema upstream; if one arrives the row draws the title and stops rather than
   * inventing `want` (§P3-28's edge cases).
   */
  it.each(['watch', 'meals'] as const)(
    'invents nothing for a %s item with no typed details',
    (behaviour) => {
      mount({ list: list(behaviour, true), item: item({ title: 'Severance' }) });

      expect(screen.getByTestId('row-body').textContent).toContain('Severance');
      expect(screen.queryByTestId('row-behaviour')).toBeNull();
      expect(screen.queryByText('Want to watch')).toBeNull();
      expect(screen.queryByText('No ingredients')).toBeNull();
    },
  );
});

describe('the caller state line', () => {
  /** Link presence is never display eligibility (§6.2). */
  it('renders nothing for an unscheduled Plan, whatever line is supplied', () => {
    mount({
      viewerPlan: { type: 'event', status: 'saved' },
      planStateLine: 'Planned Saturday · 7 PM',
    });

    expect(planState()).toBeNull();
  });

  it('renders once the same pointer has a date', () => {
    mount({ viewerPlan: SCHEDULED, planStateLine: 'Planned Saturday · 7 PM' });

    expect(screen.getByText('Planned Saturday · 7 PM')).toBeDefined();
  });

  it('opens the Activity from its own target, not the item', () => {
    const onOpenPlan = vi.fn();
    const onOpen = vi.fn();
    mount({
      viewerPlan: SCHEDULED,
      planStateLine: 'Planned Saturday · 7 PM',
      onOpenPlan,
      onOpen,
    });

    fireEvent.click(screen.getByTestId('row-plan-state'));
    expect(onOpenPlan).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

/**
 * §P3-28's edge case in one render: metadata and caller state occupy independent slots, and a
 * linked item legitimately uses more than one line.
 */
describe('the slots are independent', () => {
  it('shows provenance, location and the state line together', () => {
    mount({
      list: list('collection', true, true),
      item: item({
        title: 'Zahav',
        sourceLabel: 'Sunday dinner',
        location: { label: 'Zahav', address: '237 St James Place' },
      }),
      viewerPlan: SCHEDULED,
      planStateLine: 'Planned Saturday · 7 PM',
    });

    expect(screen.getByText('— Sunday dinner')).toBeDefined();
    expect(screen.getByText('237 St James Place')).toBeDefined();
    expect(screen.getByText('Planned Saturday · 7 PM')).toBeDefined();
    // Three targets, and the checkbox: four elements, four meanings.
    expect(checkbox()).not.toBeNull();
    expect(location()).not.toBeNull();
    expect(planState()).not.toBeNull();
  });
});

/** `interaction-contract.md` §6.2's four list-item rows, label for label. */
describe('the accessibility labels', () => {
  it('speaks the checkbox state rather than implying it', () => {
    mount({ item: item({ title: 'Chicken' }) });
    expect(screen.getByTestId('row-checkbox').getAttribute('aria-label')).toBe(
      'Chicken, not checked',
    );
  });

  it('speaks a checked item as checked', () => {
    mount({ item: item({ title: 'Chicken', checked: true }) });

    expect(screen.getByTestId('row-checkbox').getAttribute('aria-label')).toBe(
      'Chicken, checked',
    );
  });

  it('names the item and its provenance on the body', () => {
    mount({ item: item({ title: 'Chicken', sourceLabel: 'Sunday dinner' }) });

    expect(screen.getByTestId('row-body').getAttribute('aria-label')).toBe(
      'Chicken, from Sunday dinner',
    );
  });

  it('names the item alone on a list with nothing else to say', () => {
    mount({ list: list('collection', false), item: item({ title: 'Zahav' }) });

    expect(screen.getByTestId('row-body').getAttribute('aria-label')).toBe('Zahav');
  });

  it('names the place on the body and the action on the address line', () => {
    mount({
      list: list('collection', false, true),
      item: item({
        title: 'Zahav',
        location: { label: 'Zahav', address: '237 St James Place' },
      }),
    });

    expect(screen.getByTestId('row-body').getAttribute('aria-label')).toBe(
      'Zahav, 237 St James Place',
    );
    expect(screen.getByTestId('row-location').getAttribute('aria-label')).toBe(
      '237 St James Place, open in Maps',
    );
  });

  it('speaks watch progress in full, never as S2 E4', () => {
    mount({
      list: list('watch', false),
      item: item({
        title: 'Severance',
        details: {
          behaviour: 'watch',
          mediaKind: 'show',
          watchStatus: 'watching',
          season: 2,
          episode: 4,
        },
      }),
    });

    expect(screen.getByTestId('row-body').getAttribute('aria-label')).toBe(
      'Severance, watching, season 2 episode 4',
    );
  });

  /**
   * §6.2's `watch` row, as corrected 2026-08-28: two elements going to two screens, and
   * neither label repeating the other.
   */
  it('splits a watch row into a body and a state line, without saying either twice', () => {
    mount({
      list: list('watch', false),
      item: item({
        title: 'Severance',
        details: {
          behaviour: 'watch',
          mediaKind: 'show',
          watchStatus: 'watching',
          season: 2,
          episode: 4,
        },
      }),
      viewerPlan: { ...SCHEDULED, type: 'watch' },
      planStateLine: 'Next session Friday 8:00 PM',
    });

    const body = screen.getByTestId('row-body').getAttribute('aria-label');
    const line = screen.getByTestId('row-plan-state').getAttribute('aria-label');
    expect(body).toBe('Severance, watching, season 2 episode 4');
    expect(line).toBe('Next session Friday 8:00 PM, open plan');
    expect(body).not.toContain('Next session');
  });

  it('names the state line and what tapping it does', () => {
    mount({ viewerPlan: SCHEDULED, planStateLine: 'Planned Saturday · 7 PM' });

    expect(screen.getByTestId('row-plan-state').getAttribute('aria-label')).toBe(
      'Planned Saturday · 7 PM, open plan',
    );
  });

  /** The chip and the progress are inside the body's label already; twice is noise. */
  it('hides the behaviour line from assistive technology', () => {
    mount({
      list: list('watch', false),
      item: item({ details: { behaviour: 'watch', watchStatus: 'want' } }),
    });

    expect(screen.getByTestId('row-behaviour').getAttribute('aria-hidden')).toBe('true');
  });
});

/**
 * §P3-28's own closing requirement, and the same grep P3-25 runs over the feature directory:
 * a template key in this file would mean the model has been misunderstood.
 */
describe('the catalogue is unreachable from the renderer', () => {
  const source = readFileSync(join(__dirname, 'ListItemRow.tsx'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  it('names no template key and resolves nothing by one', () => {
    expect(source).not.toContain('templateKey');
    expect(source).not.toContain('LIST_TEMPLATES');
    for (const key of [
      'simple-list',
      'checklist',
      'groceries',
      'watchlist',
      'meals-to-try',
      'restaurants-to-try',
    ]) {
      expect(source).not.toContain(`'${key}'`);
    }
  });
});
