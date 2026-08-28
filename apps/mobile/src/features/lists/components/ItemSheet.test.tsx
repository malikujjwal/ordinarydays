import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListItemRow } from '@/lib/sqlite/listItemsRepository';
import type { ItemSheetActions } from '../hooks/useItemSheetActions';
import type { RowList } from '../model/itemSheet';
import { ItemSheet } from './ItemSheet';

/**
 * The item sheet (§P3-29, `plans-and-lists.md` §5.6, §5.7, §7.5, §8.1).
 *
 * The writes are stubbed so the sheet's **own** rules are what is under test: which fields
 * exist for which list, what each control sends, the provenance row's degradation, and the
 * dialog that must not be there. `useItemSheetActions.test.tsx` covers the delete, its undo
 * window and the compensating call; `listTransactions.test.ts` and `syncEngine.test.ts` cover
 * the durable native edit.
 */

const actions = vi.hoisted(() => ({ current: {} as ItemSheetActions }));
vi.mock('../hooks/useItemSheetActions', () => ({
  useItemSheetActions: () => actions.current,
}));
vi.mock('expo-crypto', () => ({
  randomUUID: () => 'idem-item-sheet-test',
  getRandomBytes: () => new Uint8Array(10),
}));

const LIST_ID = 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2';
const ITEM_ID = 'itm_01J000000000000000000000AA';
const SOURCE = 'act_01J8XKQ2M4N5P6R7S8T9V0W1X2';

const item = (overrides: Partial<ListItemRow> = {}): ListItemRow => ({
  itemId: ITEM_ID,
  listId: LIST_ID,
  rank: 'm',
  title: 'Chicken',
  checked: false,
  ...overrides,
});

const collection = (supportsLocation: boolean): RowList => ({
  behaviour: 'collection',
  capabilities: { checkable: true, supportsLocation },
});

const WATCH: RowList = {
  behaviour: 'watch',
  capabilities: { checkable: true, supportsLocation: true },
};

const MEALS: RowList = {
  behaviour: 'meals',
  capabilities: { checkable: false, supportsLocation: false },
};

function setActions(overrides: Partial<ItemSheetActions> = {}) {
  actions.current = {
    save: vi.fn(async () => true),
    remove: vi.fn(),
    sourceResolves: vi.fn(async () => true),
    isSaving: false,
    ...overrides,
  };
  return actions.current;
}

function mount(list: RowList, row: ListItemRow, onOpenSource?: (id: string) => void) {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  const onRemoved = vi.fn();
  const { unmount } = render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <ThemeProvider scheme="light">
        <ItemSheet
          open
          list={list}
          item={row}
          onClose={onClose}
          onChanged={onChanged}
          onRemoved={onRemoved}
          {...(onOpenSource === undefined ? {} : { onOpenSource })}
        />
      </ThemeProvider>
    </SafeAreaProvider>,
  );
  return { onClose, onChanged, onRemoved, unmount };
}

const field = (name: string) => screen.getByTestId(`item-sheet-${name}`);
const absent = (name: string) => screen.queryByTestId(`item-sheet-${name}`);

beforeEach(() => {
  setActions();
});

/**
 * §5.7's matrix, rendered. Every negative here asserts **absence**: §P3-29 says a location
 * field on a `supportsLocation: false` list is "absent, not disabled", so a disabled control
 * would pass a `toBeDisabled` assertion and fail this one.
 */
describe('the field set is the behaviour and the capabilities', () => {
  it('gives every behaviour a title and a note', () => {
    for (const list of [collection(false), WATCH, MEALS]) {
      const details =
        list.behaviour === 'watch'
          ? ({ behaviour: 'watch', watchStatus: 'want' } as const)
          : undefined;
      const { unmount } = mount(list, item(details === undefined ? {} : { details }));
      expect(field('title')).toBeDefined();
      expect(field('note')).toBeDefined();
      unmount();
    }
  });

  it('draws the place editor only where the capability is on', () => {
    mount(collection(true), item());
    expect(field('place')).toBeDefined();
    expect(absent('watch')).toBeNull();
    expect(absent('ingredients')).toBeNull();
  });

  it('leaves the place field out entirely when the capability is off', () => {
    mount(collection(false), item({ location: { label: 'Zahav' } }));
    expect(absent('place')).toBeNull();
    expect(absent('place-label')).toBeNull();
    expect(absent('place-address')).toBeNull();
    expect(absent('open-in-maps')).toBeNull();
  });

  it('offers the maps target only once a place is stored', () => {
    const first = mount(collection(true), item());
    expect(absent('open-in-maps')).toBeNull();
    first.unmount();

    mount(
      collection(true),
      item({ location: { label: 'Zahav', address: '237 St James Place' } }),
    );
    expect(field('open-in-maps')).toBeDefined();
    expect(screen.getByLabelText('237 St James Place, open in Maps')).toBeDefined();
  });

  it('draws the watch controls, and progress only for a show', () => {
    mount(
      WATCH,
      item({
        details: { behaviour: 'watch', mediaKind: 'show', watchStatus: 'watching' },
      }),
    );

    expect(field('watch')).toBeDefined();
    expect(field('media-movie')).toBeDefined();
    expect(field('status-want')).toBeDefined();
    expect(field('status-watching')).toBeDefined();
    expect(field('status-watched')).toBeDefined();
    expect(field('season')).toBeDefined();
    expect(field('episode')).toBeDefined();
    expect(field('mark-watched')).toBeDefined();
    expect(absent('place')).toBeNull();
    expect(absent('ingredients')).toBeNull();
  });

  it('leaves season and episode out for a movie', () => {
    mount(
      WATCH,
      item({ details: { behaviour: 'watch', mediaKind: 'movie', watchStatus: 'want' } }),
    );

    expect(field('watch')).toBeDefined();
    expect(absent('progress')).toBeNull();
    expect(absent('season')).toBeNull();
    expect(absent('episode')).toBeNull();
  });

  /** Already true: the chips still allow any → any, and a no-op button is not offered. */
  it('drops Mark as watched once the item is watched', () => {
    mount(
      WATCH,
      item({
        details: { behaviour: 'watch', mediaKind: 'movie', watchStatus: 'watched' },
      }),
    );

    expect(absent('mark-watched')).toBeNull();
    expect(field('status-watched')).toBeDefined();
  });

  it('draws the ingredient editor on a meals list and nothing else', () => {
    mount(MEALS, item({ title: 'Chicken tacos' }));

    expect(field('ingredients')).toBeDefined();
    expect(field('add-ingredient')).toBeDefined();
    expect(absent('place')).toBeNull();
    expect(absent('watch')).toBeNull();
  });

  /**
   * The migration fence, from the only side this component has: a `503` keeps the last
   * committed projection, so the list it is handed still says `collection` and the sheet still
   * draws a collection. No target defaults are rendered over an old-behaviour row.
   */
  it('renders the committed behaviour, never the migration target', () => {
    mount(
      collection(true),
      item({ details: { behaviour: 'watch', watchStatus: 'want' } }),
    );

    expect(field('place')).toBeDefined();
    expect(absent('watch')).toBeNull();
    expect(absent('status-want')).toBeNull();
  });
});

describe('two §5.6 actions are absent, not disabled', () => {
  it('offers neither Plan this item nor Add ingredients to…', () => {
    mount(MEALS, item({ title: 'Chicken tacos' }));

    expect(screen.queryByText('Plan this item')).toBeNull();
    expect(screen.queryByText(/Add ingredients to/)).toBeNull();
  });
});

describe('one PATCH per field', () => {
  it('sends the title on blur and nothing else', async () => {
    const stub = setActions();
    const row = item();
    mount(collection(false), row);

    fireEvent.change(field('title'), { target: { value: 'Tortillas' } });
    fireEvent.blur(field('title'));

    await waitFor(() => expect(stub.save).toHaveBeenCalledTimes(1));
    expect(stub.save).toHaveBeenCalledWith(row, { title: 'Tortillas' });
  });

  it('puts a refused field back and leaves the rest of the sheet alone', async () => {
    const stub = setActions({ save: vi.fn(async () => false) });
    mount(collection(false), item({ note: 'eight' }));

    fireEvent.change(field('note'), { target: { value: 'twelve' } });
    fireEvent.blur(field('note'));

    await waitFor(() =>
      expect(stub.save).toHaveBeenCalledWith(expect.anything(), {
        note: 'twelve',
      }),
    );
    await waitFor(() =>
      expect((field('note') as HTMLTextAreaElement).value).toBe('eight'),
    );
    expect((field('title') as HTMLInputElement).value).toBe('Chicken');
  });

  /**
   * §8.1's any → any. The assertion is the **data change** only: regrouping the row on return
   * to the list is P3-31's, and this task asserts nothing about where the row lands.
   */
  it('sets any status from any status, in one write', async () => {
    const stub = setActions();
    mount(
      WATCH,
      item({ details: { behaviour: 'watch', mediaKind: 'show', watchStatus: 'want' } }),
    );

    fireEvent.click(field('status-watched'));

    await waitFor(() => expect(stub.save).toHaveBeenCalledTimes(1));
    expect(stub.save).toHaveBeenCalledWith(expect.anything(), {
      details: { behaviour: 'watch', watchStatus: 'watched', mediaKind: 'show' },
    });
  });

  it('marks watched from the named shortcut', async () => {
    const stub = setActions();
    mount(
      WATCH,
      item({
        details: {
          behaviour: 'watch',
          mediaKind: 'show',
          watchStatus: 'watching',
          season: 2,
        },
      }),
    );

    fireEvent.click(field('mark-watched'));

    await waitFor(() =>
      expect(stub.save).toHaveBeenCalledWith(expect.anything(), {
        details: {
          behaviour: 'watch',
          watchStatus: 'watched',
          mediaKind: 'show',
          season: 2,
        },
      }),
    );
  });

  it('writes an ingredient only once it has a name', async () => {
    const stub = setActions();
    mount(MEALS, item({ title: 'Chicken tacos' }));

    fireEvent.click(field('add-ingredient'));
    const name = screen.getByTestId('item-sheet-ingredient-name-0');
    fireEvent.change(name, { target: { value: 'Chicken' } });
    fireEvent.change(screen.getByTestId('item-sheet-ingredient-quantity-0'), {
      target: { value: '500g' },
    });
    fireEvent.blur(screen.getByTestId('item-sheet-ingredient-quantity-0'));

    await waitFor(() => expect(stub.save).toHaveBeenCalledTimes(1));
    expect(stub.save).toHaveBeenCalledWith(expect.anything(), {
      details: {
        behaviour: 'meals',
        ingredients: [expect.objectContaining({ name: 'Chicken', quantity: '500g' })],
      },
    });
  });
});

describe('the provenance row (§7.5)', () => {
  it('is navigable while the Activity resolves, and opens it', async () => {
    const stub = setActions();
    const onOpenSource = vi.fn();
    mount(
      collection(false),
      item({ sourceLabel: 'Chicken tacos', sourceActivityId: SOURCE }),
      onOpenSource,
    );

    expect(screen.getByRole('button', { name: 'From Chicken tacos' })).toBeDefined();
    fireEvent.click(field('provenance'));

    await waitFor(() => expect(onOpenSource).toHaveBeenCalledWith(SOURCE));
    expect(stub.sourceResolves).toHaveBeenCalledWith(SOURCE);
  });

  /** There is no resolvability field on the wire; a `404` on the attempt is how it is learned. */
  it('degrades to plain text once a navigation attempt meets 404, and stays that way', async () => {
    const stub = setActions({ sourceResolves: vi.fn(async () => false) });
    const onOpenSource = vi.fn();
    mount(
      collection(false),
      item({ sourceLabel: 'Chicken tacos', sourceActivityId: SOURCE }),
      onOpenSource,
    );

    fireEvent.click(field('provenance'));

    await waitFor(() => expect(stub.sourceResolves).toHaveBeenCalledTimes(1));
    expect(onOpenSource).not.toHaveBeenCalled();
    // Still says the same words; it is simply no longer a control.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'From Chicken tacos' })).toBeNull(),
    );
    expect(screen.getByText('From Chicken tacos')).toBeDefined();

    fireEvent.click(field('provenance'));
    expect(stub.sourceResolves).toHaveBeenCalledTimes(1);
  });

  it('is plain text when the label names no Activity', () => {
    mount(collection(false), item({ sourceLabel: 'Chicken tacos' }), vi.fn());

    expect(screen.getByText('From Chicken tacos')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'From Chicken tacos' })).toBeNull();
  });

  it('is absent on a manually added item', () => {
    mount(collection(false), item());
    expect(absent('provenance')).toBeNull();
  });
});

/**
 * §4.1: a single-item delete is confirmed by nobody and undone by a toast.
 *
 * Written as an assertion on the **absence of the dialog component**, exactly as §P3-10 asks
 * for its bulk twin, so re-adding one fails rather than passing a looser copy check.
 */
describe('delete asks nothing', () => {
  it('issues the delete on the tap with no confirmation dialog anywhere', () => {
    const stub = setActions();
    const row = item();
    const { onClose } = mount(collection(false), row);

    fireEvent.click(field('delete'));

    expect(stub.remove).toHaveBeenCalledWith(row);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('confirm-dialog')).toBeNull();
    expect(screen.queryByText('Delete "Chicken"?')).toBeNull();
  });

  it('names no ConfirmDialog in the source', () => {
    const source = readFileSync(join(__dirname, 'ItemSheet.tsx'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    expect(code).not.toContain('ConfirmDialog');
  });
});
