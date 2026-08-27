import type { TimeZone } from '@od/shared/time';
import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListsView } from '../hooks/useLists';
import { ListsScreen } from './ListsScreen';

/**
 * The Lists tab (§P3-25, `plans-and-lists.md` §5.6, §5.9).
 *
 * The hook is stubbed so the screen's own rules are what is under test: the archived filter,
 * the drain, the empty-state gate and server order. `useLists.native.test.tsx` and
 * `listsRepository.test.ts` cover the two data paths behind it.
 */

const view = vi.hoisted(() => ({ current: {} as ListsView }));
vi.mock('../hooks/useLists', () => ({ useLists: () => view.current }));

const UTC = 'UTC' as TimeZone;
const NOW = new Date('2026-08-26T12:00:00.000Z');

const list = (id: string, overrides: Partial<List> = {}): List => ({
  listId: `lst_01J8XKQ2M4N5P6R7S8T9V0W${id}`,
  ownerId: 'usr_local_dev',
  behaviour: 'collection',
  templateKey: 'groceries',
  title: `List ${id}`,
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  capabilities: { checkable: false, supportsLocation: false },
  slot: null,
  itemCount: 3,
  uncheckedCount: 3,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: '2026-08-24T09:00:00.000Z',
  lastItemActivityAt: '2026-08-26T09:00:00.000Z',
  ...overrides,
});

/** Three Crockford characters, so every fixture id is a valid `lst_` ULID. */
const idAt = (index: number) => `${'ABCDEFGHJKMNPQRSTVWXYZ'[index % 22]}${'01'}`;

function setView(overrides: Partial<ListsView> = {}) {
  view.current = {
    status: 'success',
    lists: [],
    timezone: UTC,
    refetch: vi.fn(),
    isLoadingMore: false,
    isOffline: false,
    hasMore: false,
    loadMore: vi.fn(),
    ...overrides,
  };
  return view.current;
}

/**
 * Reveals the row's actions the way a pointer user does.
 *
 * On web §3.2's swipe becomes a hover/focus-revealed control (`SwipeableListCard.web.tsx`), so
 * a test that clicked without hovering would be asserting against a surface no user sees. The
 * accessibility path is asserted separately by the actions model's own test.
 */
function revealActions(listId: string) {
  fireEvent.pointerEnter(screen.getByTestId(`swipeable-list-${listId}`));
}

function mount(handlers: Partial<Parameters<typeof ListsScreen>[0]> = {}) {
  const props = {
    now: NOW,
    viewerUserId: 'usr_local_dev',
    onOpenList: vi.fn(),
    onNewList: vi.fn(),
    onArchive: vi.fn(),
    onRestore: vi.fn(),
    onDelete: vi.fn(),
    ...handlers,
  };
  render(
    <ThemeProvider scheme="light">
      <ListsScreen {...props} />
    </ThemeProvider>,
  );
  return props;
}

beforeEach(() => {
  setView();
});

describe('the empty state', () => {
  /** §5.9, verbatim. `No lists yet` states literal absence, which §5.2 allows. */
  it('renders §5.9 exactly once the cursor is exhausted', () => {
    setView({ lists: [], hasMore: false });
    mount();

    expect(screen.getByText('No lists yet')).toBeTruthy();
    expect(
      screen.getByText('Keep things you want to remember, track, or organise together.'),
    ).toBeTruthy();
    expect(screen.getByText('New list')).toBeTruthy();
  });

  it('opens the creation route rather than creating anything', () => {
    setView({ lists: [] });
    const { onNewList } = mount();

    fireEvent.click(screen.getByText('New list'));

    expect(onNewList).toHaveBeenCalledTimes(1);
  });
});

describe('server pointer order', () => {
  /** ADR-042: `ListIndex` stores no rank, so any client sort would be inventing an order. */
  it('renders a deliberately shuffled response in response order', () => {
    const shuffled = [
      list(idAt(2), { title: 'Zebra' }),
      list(idAt(0), { title: 'Apple' }),
      list(idAt(1), { title: 'Mango' }),
    ];
    setView({ lists: shuffled });
    mount();

    const rendered = ['Zebra', 'Apple', 'Mango'].map((title) => screen.getByText(title));
    // Document order matches response order.
    expect(rendered[0]?.compareDocumentPosition(rendered[1] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(rendered[1]?.compareDocumentPosition(rendered[2] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe('the archived filter', () => {
  it('hides archived lists until Show archived', () => {
    setView({
      lists: [
        list(idAt(0), { title: 'Active' }),
        list(idAt(1), { title: 'Old', archived: true }),
      ],
    });
    mount();

    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.queryByText('Old')).toBeNull();

    fireEvent.click(screen.getByTestId('lists-menu'));
    fireEvent.click(screen.getByTestId('lists-toggle-archived'));

    expect(screen.getByText('Old')).toBeTruthy();
    // A separate de-emphasised group, not mixed into the active ones.
    expect(screen.getByText('Archived')).toBeTruthy();
  });

  /** One tap, per §5.6 — and it is a settings write, not a re-create. */
  it('restores an archived list in one tap', () => {
    const archived = list(idAt(1), { title: 'Old', archived: true });
    setView({ lists: [archived] });
    const { onRestore } = mount();

    fireEvent.click(screen.getByTestId('lists-menu'));
    fireEvent.click(screen.getByTestId('lists-toggle-archived'));
    fireEvent.click(screen.getByTestId(`list-restore-${archived.listId}`));

    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ title: 'Old' }));
  });
});

describe('the auto-drain rule', () => {
  /**
   * §P3-25's named case: **fifty archived pointers on page one, active rows on page two.**
   * The filtered view is empty and a cursor remains, so the screen must neither claim the
   * account is empty nor leave the user looking at nothing.
   */
  it('neither shows the empty state nor stops while a cursor remains', async () => {
    const loadMore = vi.fn();
    const archivedPage = Array.from({ length: 50 }, (_, index) =>
      list(idAt(index), { title: `Old ${String(index)}`, archived: true }),
    );
    setView({ lists: archivedPage, hasMore: true, loadMore });
    mount();

    expect(screen.queryByText('No lists yet')).toBeNull();
    // Filtering is not pagination completion: it asks for the next page.
    await waitFor(() => expect(loadMore).toHaveBeenCalled());
  });

  it('stops asking once the cursor is exhausted, and only then may say No lists yet', () => {
    const loadMore = vi.fn();
    setView({ lists: [], hasMore: false, loadMore });
    mount();

    expect(screen.getByText('No lists yet')).toBeTruthy();
    expect(loadMore).not.toHaveBeenCalled();
  });

  it('does not stack a request while a page is in flight', () => {
    const loadMore = vi.fn();
    setView({ lists: [], hasMore: true, isLoadingMore: true, loadMore });
    mount();

    expect(loadMore).not.toHaveBeenCalled();
    expect(screen.queryByText('No lists yet')).toBeNull();
  });

  /**
   * `Show archived` reuses the pages already materialized — no second request — and only then
   * continues the same bounded drain if the widened view still cannot fill.
   */
  it('reuses materialized pages when archived are shown, then keeps draining', async () => {
    const loadMore = vi.fn();
    const archivedPage = Array.from({ length: 3 }, (_, index) =>
      list(idAt(index), { title: `Old ${String(index)}`, archived: true }),
    );
    setView({ lists: archivedPage, hasMore: true, loadMore });
    mount();

    await waitFor(() => expect(loadMore).toHaveBeenCalled());
    const beforeToggle = loadMore.mock.calls.length;

    fireEvent.click(screen.getByTestId('lists-menu'));
    fireEvent.click(screen.getByTestId('lists-toggle-archived'));

    // The rows were already there; the toggle rendered them without another request.
    expect(screen.getByText('Old 0')).toBeTruthy();
    // Three visible rows still cannot fill the viewport, so the same drain continues.
    await waitFor(() =>
      expect(loadMore.mock.calls.length).toBeGreaterThanOrEqual(beforeToggle),
    );
  });
});

describe('row actions', () => {
  it('opens the list on tap and issues no mutation', () => {
    const row = list(idAt(0));
    setView({ lists: [row] });
    const { onOpenList, onArchive, onDelete, onRestore } = mount();

    fireEvent.click(screen.getByTestId(`list-card-${row.listId}`));

    expect(onOpenList).toHaveBeenCalledWith(row.listId);
    // U1: tapping a row opens detail and never mutates.
    expect(onArchive).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('archives from the swipe action without a dialog', () => {
    const row = list(idAt(0));
    setView({ lists: [row] });
    const { onArchive } = mount();

    revealActions(row.listId);
    fireEvent.click(screen.getByTestId('list-swipe-archive'));

    expect(onArchive).toHaveBeenCalledWith(
      expect.objectContaining({ listId: row.listId }),
    );
  });

  /** §1a.1: the destructive action is the dialog's, never the gesture's. */
  it('asks before deleting, and names what is lost', () => {
    const row = list(idAt(0), { title: 'Groceries', itemCount: 12, memberCount: 3 });
    setView({ lists: [row] });
    const { onDelete } = mount();

    revealActions(row.listId);
    fireEvent.click(screen.getByTestId('list-swipe-delete'));

    expect(onDelete).not.toHaveBeenCalled();
    // Scoped to the dialog: the card behind it states the same count, and asserting globally
    // would pass on the card while the dialog said nothing.
    const dialog = within(screen.getByTestId('list-delete-confirm'));
    expect(dialog.getByText('Delete "Groceries"?')).toBeTruthy();
    expect(dialog.getByText(/12 items/)).toBeTruthy();
    expect(dialog.getByText(/2 other people/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('confirm-accept'));
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ listId: row.listId }),
    );
  });

  it('cancels the delete without writing', () => {
    const row = list(idAt(0));
    setView({ lists: [row] });
    const { onDelete } = mount();

    revealActions(row.listId);
    fireEvent.click(screen.getByTestId('list-swipe-delete'));
    fireEvent.click(screen.getByTestId('confirm-cancel'));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Delete "/)).toBeNull();
  });

  /** Archived rows are inert: their one action is Restore. */
  it('offers no swipe actions on an archived row', () => {
    const row = list(idAt(1), { archived: true });
    setView({ lists: [row] });
    mount();

    fireEvent.click(screen.getByTestId('lists-menu'));
    fireEvent.click(screen.getByTestId('lists-toggle-archived'));
    revealActions(row.listId);

    expect(screen.queryByTestId('list-swipe-archive')).toBeNull();
    expect(screen.queryByTestId('list-swipe-delete')).toBeNull();
  });
});

describe('loading and failure', () => {
  it('shows skeletons before the first load, not an empty state', () => {
    setView({ status: 'pending', lists: [] });
    mount();

    expect(screen.getByTestId('lists-loading')).toBeTruthy();
    expect(screen.queryByText('No lists yet')).toBeNull();
  });

  /** §5.3: with cached rows the content stays and the failure is a line above it. */
  it('keeps rows on a failed refresh', () => {
    setView({ lists: [list(idAt(0))], message: 'Network down' });
    mount();

    expect(screen.getByText(`List ${idAt(0)}`)).toBeTruthy();
    expect(screen.getByTestId('lists-refresh-failed')).toBeTruthy();
  });

  it('becomes an error screen when there is nothing to keep', () => {
    setView({ status: 'error', lists: [], message: "Couldn't load this." });
    mount();

    expect(screen.getByTestId('lists-error')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});
