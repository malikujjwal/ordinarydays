import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListItemRow as ListItemRowType } from '@/lib/sqlite/listItemsRepository';
import type { RowList } from '../model/listItemRow';
import { type ListSwipeAction, watchItemSwipeActions } from '../model/listSwipeActions';
import { WatchSections } from './WatchSections';

/**
 * §5.2's grouped list, rendered (§P3-31, `interaction-contract.md` §3.2, §6.2).
 *
 * `watchSections.test.ts` proves the projection; this proves the tree it becomes — the
 * headings that are there, the one that is not, the progress line a movie does not get, and
 * the accessibility label §6.2 pins for this row.
 */

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const WATCH_LIST: RowList = {
  behaviour: 'watch',
  // A stale `checkable` a behaviour change left behind. No watch row may draw a checkbox.
  capabilities: { checkable: true, supportsLocation: true },
};

const row = (
  suffix: string,
  rank: string,
  title: string,
  details?: ListItemRowType['details'],
): ListItemRowType => ({
  itemId: `itm_01J0000000000000000000${suffix}`,
  listId: LIST_ID,
  rank,
  title,
  checked: false,
  ...(details === undefined ? {} : { details }),
});

const SEVERANCE = row('AA', 'a', 'Severance', {
  behaviour: 'watch',
  watchStatus: 'watching',
  mediaKind: 'show',
  season: 2,
  episode: 4,
});
const ARRIVAL = row('BB', 'b', 'Arrival', {
  behaviour: 'watch',
  watchStatus: 'watched',
  mediaKind: 'movie',
});
const ANDOR = row('CC', 'c', 'Andor', {
  behaviour: 'watch',
  watchStatus: 'want',
  mediaKind: 'show',
});
const SHOGUN = row('DD', 'd', 'Shogun', {
  behaviour: 'watch',
  watchStatus: 'watching',
  mediaKind: 'show',
  season: 1,
  episode: 2,
});

const onAction = vi.fn();
const onReorder = vi.fn();

const tree = (items: readonly ListItemRowType[], actions: readonly ListSwipeAction[]) => (
  <ThemeProvider scheme="light">
    <WatchSections
      list={WATCH_LIST}
      items={items}
      actions={actions}
      onAction={onAction}
      onReorder={onReorder}
    />
  </ThemeProvider>
);

function mount(items: readonly ListItemRowType[], actions = watchItemSwipeActions()) {
  render(tree(items, actions));
}

/** Mounted so a later projection can replace this one, which is how a status change arrives. */
function renderWith(items: readonly ListItemRowType[]) {
  const rendered = render(tree(items, watchItemSwipeActions()));
  return {
    rerender: (next: readonly ListItemRowType[]) =>
      rendered.rerender(tree(next, watchItemSwipeActions())),
  };
}

/**
 * Web reveals a row's actions on hover or focus, as `SwipeableListCard.web.tsx` does — there is
 * no swipe on a pointer device (§7.1). A test that never hovered would be asserting against the
 * resting state and calling it an absence.
 */
const reveal = (item: ListItemRowType) =>
  fireEvent.pointerEnter(screen.getByTestId(`swipeable-item-${item.itemId}`));

/** Section headings in document order, which is what §5.2 fixes. */
const headings = () =>
  screen.getAllByRole('heading').map((node) => node.textContent?.trim());

beforeEach(() => {
  onAction.mockClear();
  onReorder.mockClear();
});

describe('the three sections', () => {
  it('renders §5.2 order from a shuffled fixture', () => {
    mount([ARRIVAL, ANDOR, SHOGUN, SEVERANCE]);

    expect(headings()).toEqual(['Watching', 'Want to watch', 'Watched']);
  });

  it('sorts within a section by rank, not by arrival', () => {
    mount([SHOGUN, SEVERANCE]);

    const watching = screen.getByTestId('watch-items-watching');
    const titles = ['Severance', 'Shogun'].map((title) => screen.getByText(title));
    expect(watching.contains(titles[0] as Node)).toBe(true);
    expect(
      (titles[0] as Node).compareDocumentPosition(titles[1] as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  /** The recorded decision: a group with nothing in it has no heading at all. */
  it('omits an empty group entirely', () => {
    mount([SEVERANCE, SHOGUN]);

    expect(headings()).toEqual(['Watching']);
    expect(screen.queryByText('Want to watch')).toBeNull();
    expect(screen.queryByText('Watched')).toBeNull();
    expect(screen.queryByTestId('watch-sections-want')).toBeNull();
  });
});

describe('the row is P3-28 unchanged', () => {
  it('renders S2 E4 for a show and no progress line for a movie', () => {
    mount([SEVERANCE, ARRIVAL]);

    expect(screen.getByText('S2 E4')).toBeDefined();
    expect(screen.queryByTestId(`list-item-${ARRIVAL.itemId}-progress`)).toBeNull();
  });

  /** §5.7: the status chip replaces the checkbox, whatever a stale capability flag says. */
  it('draws a status chip and never a checkbox', () => {
    mount([SEVERANCE]);

    expect(
      screen.getByTestId(`list-item-${SEVERANCE.itemId}-watch-status`),
    ).toBeDefined();
    expect(screen.queryByTestId(`list-item-${SEVERANCE.itemId}-checkbox`)).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  /** §6.2's `watch` list-item row: `Severance, watching, season 2 episode 4`. */
  it('speaks the §6.2 label', () => {
    mount([SEVERANCE]);

    expect(
      screen.getByLabelText('Severance, watching, season 2 episode 4'),
    ).toBeDefined();
  });
});

/**
 * §P3-31: a status change regroups the item under its new heading **at its existing rank**.
 *
 * Nothing renumbers, because nothing was ever grouped in storage: the sections are a
 * projection, and a status change moves one row between two of them.
 */
describe('a status change', () => {
  /* `M` sorts before `a` in the rank alphabet — digits, then upper case, then lower. */
  const watchedEarly = row('EE', 'M', 'Dune', {
    behaviour: 'watch',
    watchStatus: 'watched',
    mediaKind: 'movie',
  });

  /** Whether `first` precedes `second` in the rendered document, inside `status`'s section. */
  const orderedUnder = (status: string, first: string, second: string) => {
    const section = screen.getByTestId(`watch-items-${status}`);
    const [a, b] = [first, second].map((title) => screen.getByText(title));
    return (
      a !== undefined &&
      b !== undefined &&
      section.contains(a) &&
      section.contains(b) &&
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  };

  it('regroups the row without moving it to the top of its new group', () => {
    // `Severance` at rank `a` sorts after `Dune` at `M`; that must survive the regrouping.
    const { rerender } = renderWith([watchedEarly, SEVERANCE, ANDOR]);
    expect(headings()).toEqual(['Watching', 'Want to watch', 'Watched']);

    rerender([
      watchedEarly,
      { ...SEVERANCE, details: { ...SEVERANCE.details, watchStatus: 'watched' } },
      ANDOR,
    ] as ListItemRowType[]);

    expect(headings()).toEqual(['Want to watch', 'Watched']);
    // Second in its new section, which is where its rank puts it — not first.
    expect(orderedUnder('watched', 'Dune', 'Severance')).toBe(true);
  });

  it('changes nothing else about the row', () => {
    const { rerender } = renderWith([SEVERANCE]);
    const before = screen.getByLabelText('Severance, watching, season 2 episode 4')
      .parentElement?.outerHTML;

    rerender([
      { ...SEVERANCE, details: { ...SEVERANCE.details, watchStatus: 'watched' } },
    ] as ListItemRowType[]);

    // The progress, the media kind and the title are untouched; only the status moved.
    expect(screen.getByText('S2 E4')).toBeDefined();
    expect(screen.getByLabelText('Severance, watched, season 2 episode 4')).toBeDefined();
    expect(before).toBeDefined();
  });
});

/**
 * Invalid data. §P3-31 says the response schema rejects a committed watch row with no typed
 * details rather than the client placing it in `Want to watch`.
 */
describe('a row with no readable status', () => {
  it('is shown without a heading and never under Want to watch', () => {
    mount([SEVERANCE, row('ZZ', 'z', 'Mystery')]);

    expect(screen.getByText('Mystery')).toBeDefined();
    expect(screen.getByTestId('watch-sections-ungrouped')).toBeDefined();
    expect(headings()).toEqual(['Watching']);
    expect(screen.queryByText('Want to watch')).toBeNull();
  });
});

describe('the swipe actions (§3.2)', () => {
  it('offers Mark watched and Delete, in that order', () => {
    mount([SEVERANCE]);
    reveal(SEVERANCE);

    const actions = screen.getAllByRole('button', { name: /Mark watched|Delete/ });
    expect(actions.map((node) => node.getAttribute('aria-label'))).toEqual([
      'Mark watched',
      'Delete',
    ]);
  });

  it('reports the row the action was taken on', () => {
    mount([SEVERANCE, ANDOR]);
    reveal(SEVERANCE);

    fireEvent.click(
      screen.getAllByRole('button', { name: 'Mark watched' })[0] as HTMLElement,
    );

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]?.[0]).toEqual(SEVERANCE);
    expect(onAction.mock.calls[0]?.[1]).toMatchObject({ name: 'mark-watched' });
  });

  /** An action with no handler is absent, not inert: `Delete` belongs to P3-29. */
  it('renders only the actions it was given', () => {
    mount(
      [SEVERANCE],
      watchItemSwipeActions().filter((a) => a.name === 'mark-watched'),
    );
    reveal(SEVERANCE);

    expect(screen.getByRole('button', { name: 'Mark watched' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });
});

/**
 * §P3-30's guard, made structural: each section is its own drag surface, so a drop reports a
 * position **within its group** and no gesture can cross a heading.
 */
describe('the drag is bounded by the headings', () => {
  it('reports a position within the group the row is in', () => {
    mount([SEVERANCE, ANDOR, SHOGUN]);

    const handle = screen.getByTestId(`list-reorder-handle-${SEVERANCE.itemId}`);
    handle.focus();
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Enter' });
    fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Enter' });

    // `watching` holds Severance and Shogun; index 1 is the far end of that section.
    expect(onReorder).toHaveBeenCalledWith(SEVERANCE.itemId, 1);
  });

  it('cannot be pushed past the end of its own section', () => {
    mount([SEVERANCE, ANDOR, SHOGUN]);

    const handle = screen.getByTestId(`list-reorder-handle-${SEVERANCE.itemId}`);
    handle.focus();
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Enter' });
    for (let at = 0; at < 6; at += 1) {
      fireEvent.keyDown(document.activeElement ?? document, { key: 'ArrowDown' });
    }
    fireEvent.keyDown(document.activeElement ?? document, { key: 'Enter' });

    // Never 2, which would be Andor's row in the section below.
    expect(onReorder).toHaveBeenCalledWith(SEVERANCE.itemId, 1);
  });
});
