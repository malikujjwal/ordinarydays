import { instant } from '@od/shared/schemas';
import type { TimeZone } from '@od/shared/time';
import type { List } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bottomChromeScrollPadding } from '@/components/globalAddLayout';
import type { ListsView } from '../hooks/useLists';
import { listsScrollBottomPadding } from './ListsIndexScroll';
import { ListsScreen } from './ListsScreen';

/**
 * The Lists tab (§P3-25, `plans-and-lists.md` §5.6, §5.9).
 *
 * The hook is stubbed so the screen's own rules are what is under test: the archived filter,
 * the drain, the empty-state gate and newest-first order. `useLists.native.test.tsx` and
 * `listsRepository.test.ts` cover the two data paths behind it.
 */

const view = vi.hoisted(() => ({ current: {} as ListsView }));
vi.mock('../hooks/useLists', () => ({ useLists: () => view.current }));

const UTC = 'UTC' as TimeZone;
const NOW = instant.parse('2026-08-26T12:00:00.000Z');

const list = (id: string, overrides: Partial<List> = {}): List => ({
  listId: `lst_01J8XKQ2M4N5P6R7S8T9V0W${id}`,
  ownerId: 'usr_local_dev',
  schemaVersion: 2,
  templateKey: 'groceries',
  title: `List ${id}`,
  icon: 'cart',
  emptyStateCopy: 'Add something to buy.',
  itemStateMode: { mode: 'none' },
  featureConfig: {},
  slot: null,
  itemCount: 3,
  doneCount: 0,
  memberCount: 1,
  rankVersion: 0,
  archived: false,
  updatedAt: instant.parse('2026-08-24T09:00:00.000Z'),
  lastItemActivityAt: instant.parse('2026-08-26T09:00:00.000Z'),
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

function showArchived() {
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  fireEvent.click(screen.getByRole('checkbox', { name: /^Show archived,/ }));
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

afterEach(() => vi.useRealTimers());

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

describe('newest-first order', () => {
  it('renders newly created Lists before older Lists regardless of response order', () => {
    const shuffled = [
      list(idAt(0), { title: 'Oldest' }),
      list(idAt(2), { title: 'Newest' }),
      list(idAt(1), { title: 'Middle' }),
    ];
    setView({ lists: shuffled });
    mount();

    const rendered = ['Newest', 'Middle', 'Oldest'].map((title) =>
      screen.getByText(title),
    );
    expect(rendered[0]?.compareDocumentPosition(rendered[1] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(rendered[1]?.compareDocumentPosition(rendered[2] as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe('floating navigation clearance', () => {
  it('derives compact bottom space from the one shared chrome metric and safe area', () => {
    expect(listsScrollBottomPadding(34, true)).toBe(bottomChromeScrollPadding(34));
    expect(listsScrollBottomPadding(0, true)).toBe(bottomChromeScrollPadding(0));
  });

  it('keeps expanded content clear without paying for compact floating chrome', () => {
    expect(listsScrollBottomPadding(20, false)).toBe(52);
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

    showArchived();

    expect(screen.getByText('Old')).toBeTruthy();
    // A separate de-emphasised group, not mixed into the active ones.
    expect(screen.getByText('Archived')).toBeTruthy();
  });

  it('separates Archived from the final active card with a visible top border', () => {
    setView({
      lists: [
        list(idAt(0), { title: 'Active' }),
        list(idAt(1), { title: 'Old', archived: true }),
      ],
    });
    mount();

    showArchived();

    const archived = screen.getByTestId('lists-archived-section');
    expect(getComputedStyle(archived).borderTopWidth).toBe('1px');
  });

  /** One tap, per §5.6 — and it is a settings write, not a re-create. */
  it('restores an archived list in one tap', () => {
    const archived = list(idAt(1), { title: 'Old', archived: true });
    setView({ lists: [archived] });
    const { onRestore } = mount();

    showArchived();
    fireEvent.click(screen.getByTestId(`list-restore-${archived.listId}`));

    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ title: 'Old' }));
  });
});

describe('the auto-drain rule', () => {
  it('drains after Show archived until an archived row is discoverable', async () => {
    const loadMore = vi.fn();
    setView({
      lists: Array.from({ length: 8 }, (_, index) => list(idAt(index))),
      hasMore: true,
      loadMore,
    });
    mount();
    expect(loadMore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Show archived/ }));

    await waitFor(() => expect(loadMore).toHaveBeenCalledOnce());
  });

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

    showArchived();

    // The rows were already there; the toggle rendered them without another request.
    expect(screen.getByText('Old 0')).toBeTruthy();
    // Three visible rows still cannot fill the viewport, so the same drain continues.
    await waitFor(() => expect(loadMore.mock.calls.length).toBeGreaterThan(beforeToggle));
  });
});

describe('row actions', () => {
  it('opens the list on tap and issues no mutation', () => {
    vi.useFakeTimers();
    const row = list(idAt(0));
    setView({ lists: [row] });
    const { onOpenList, onArchive, onDelete, onRestore } = mount();

    fireEvent.click(screen.getByRole('button', { name: /^List A01\./ }));

    // Navigation waits one frame so the pressed collection tone has returned to rest before
    // the route transition snapshots this screen.
    expect(onOpenList).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(17));
    expect(onOpenList).toHaveBeenCalledExactlyOnceWith(row.listId);
    // U1: tapping a row opens detail and never mutates.
    expect(onArchive).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('coalesces a multi-frame double click into one navigation', () => {
    vi.useFakeTimers();
    const row = list(idAt(0));
    setView({ lists: [row] });
    const { onOpenList } = mount();

    const card = screen.getByRole('button', { name: /^List A01\./ });
    fireEvent.click(card);

    expect(onOpenList).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(17));
    expect(onOpenList).toHaveBeenCalledExactlyOnceWith(row.listId);

    act(() => vi.advanceTimersByTime(100));
    fireEvent.click(card);
    act(() => vi.advanceTimersByTime(17));
    expect(onOpenList).toHaveBeenCalledOnce();

    // The guard is not permanent: a later deliberate activation still works.
    act(() => vi.advanceTimersByTime(400));
    fireEvent.click(card);
    act(() => vi.advanceTimersByTime(17));
    expect(onOpenList).toHaveBeenCalledTimes(2);
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
    expect(dialog.getByText(/12 List items/)).toBeTruthy();
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

  it('routes member Leave only to the membership callback, with leave-specific impact copy', () => {
    const row = list(idAt(0), {
      ownerId: 'usr_someone_else',
      title: 'Groceries',
      itemCount: 14,
      memberCount: 2,
    });
    setView({ lists: [row] });
    const onLeave = vi.fn();
    const { onDelete } = mount({ onLeave });

    revealActions(row.listId);
    fireEvent.click(screen.getByTestId('list-swipe-leave'));

    const dialog = within(screen.getByTestId('list-delete-confirm'));
    expect(dialog.getByText('Leave "Groceries"?')).toBeTruthy();
    expect(dialog.getByText('This removes the list from your Lists.')).toBeTruthy();
    expect(dialog.getByText(/all 14 items on it/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('confirm-accept'));

    expect(onLeave).toHaveBeenCalledWith(expect.objectContaining({ listId: row.listId }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('does not expose Leave until the self-membership endpoint is installed', () => {
    const row = list(idAt(0), { ownerId: 'usr_someone_else' });
    setView({ lists: [row] });
    mount();

    revealActions(row.listId);

    expect(screen.queryByTestId('list-swipe-leave')).toBeNull();
    expect(screen.queryByTestId('list-swipe-delete')).toBeNull();
  });

  /** Archived rows are inert: their one action is Restore. */
  it('offers no swipe actions on an archived row', () => {
    const row = list(idAt(1), { archived: true });
    setView({ lists: [row] });
    mount();

    showArchived();
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

  /**
   * §5.3 amended (founder, 2026-08-31): cached rows stay, and the failure lives in the
   * header's connectivity glyph rather than as an inline line that reflows the grid.
   */
  it('keeps rows on a failed refresh without an inline failure line', () => {
    setView({
      lists: [list(idAt(0))],
      message: 'Network down',
      requestId: 'req_refresh_failure',
    });
    mount();

    expect(screen.getByText(`List ${idAt(0)}`)).toBeTruthy();
    expect(screen.queryByTestId('lists-refresh-failed')).toBeNull();
    expect(screen.queryByText('req_refresh_failure')).toBeNull();
  });

  it('becomes an error screen when there is nothing to keep', () => {
    setView({
      status: 'error',
      lists: [],
      message: 'Something went wrong.',
      requestId: 'req_lists_failure',
    });
    mount();

    expect(screen.getByTestId('lists-error')).toBeTruthy();
    expect(screen.getByText("Couldn't load this.")).toBeTruthy();
    expect(screen.queryByText('No lists yet')).toBeNull();
    expect(screen.queryByText('Something went wrong.')).toBeNull();
    expect(screen.getByText('req_lists_failure')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });
});
