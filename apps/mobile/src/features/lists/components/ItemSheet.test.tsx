import type { List, ListItemView } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ItemSheet } from './ItemSheet';

const calls = vi.hoisted(() => ({ save: vi.fn(), remove: vi.fn() }));
vi.mock('../hooks/useListItemActions', () => ({
  useListItemActions: () => calls,
}));
vi.mock('@/lib/localIds', () => ({ newLocalId: () => 'sub_01J8XKQ2M4N5P6R7S8T9V0W9Z9' }));

const list = (
  overrides: Partial<Pick<List, 'itemStateMode' | 'featureConfig'>> = {},
) => ({
  itemStateMode: { mode: 'none' } as List['itemStateMode'],
  featureConfig: {} as List['featureConfig'],
  ...overrides,
});

const item = (overrides: Partial<ListItemView> = {}): ListItemView => ({
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3',
  rank: 'a0',
  title: 'The Bear',
  state: 'active',
  ...overrides,
});

function mount(subject = item(), subjectList = list(), onClose = vi.fn()) {
  return render(
    <ThemeProvider scheme="light">
      <ItemSheet
        open
        list={subjectList}
        item={subject}
        onClose={onClose}
        onChanged={vi.fn()}
        onRemoved={vi.fn()}
      />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  calls.save.mockReset().mockResolvedValue(true);
  calls.remove.mockReset();
});

afterEach(() => vi.useRealTimers());

describe('the canonical item editor shell', () => {
  it('persists Title and Note while typing without requiring blur', () => {
    vi.useFakeTimers();
    const subject = item({ note: 'Pilot' });
    mount(subject);

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'The Bear season 4' },
    });
    fireEvent.change(screen.getByLabelText('Note'), {
      target: { value: 'Watch on Thursday' },
    });
    act(() => vi.advanceTimersByTime(400));

    expect(calls.save).toHaveBeenCalledWith(subject, { title: 'The Bear season 4' });
    expect(calls.save).toHaveBeenCalledWith(subject, { note: 'Watch on Thursday' });
  });

  it('does not allow an item to be renamed to an empty title', () => {
    vi.useFakeTimers();
    const subject = item();
    mount(subject);

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: '   ' },
    });
    act(() => vi.advanceTimersByTime(400));

    expect(screen.getByText('Title is required.')).toBeTruthy();
    expect(calls.save).not.toHaveBeenCalledWith(
      subject,
      expect.objectContaining({ title: '' }),
    );
  });

  it('does not repeat an accepted title write after an invalid blank draft', () => {
    vi.useFakeTimers();
    const subject = item();
    mount(subject);
    const title = screen.getByLabelText('Title');

    fireEvent.change(title, { target: { value: 'The Bear season 4' } });
    act(() => vi.advanceTimersByTime(400));
    fireEvent.change(title, { target: { value: '   ' } });
    fireEvent.blur(title);
    fireEvent.change(title, { target: { value: 'The Bear season 4' } });
    act(() => vi.advanceTimersByTime(400));

    expect(calls.save).toHaveBeenCalledTimes(1);
    expect(calls.save).toHaveBeenCalledWith(subject, { title: 'The Bear season 4' });
  });

  it('still saves a restored valid title when blank input interrupted its debounce', () => {
    vi.useFakeTimers();
    const subject = item();
    mount(subject);
    const title = screen.getByLabelText('Title');

    fireEvent.change(title, { target: { value: 'The Bear season 4' } });
    fireEvent.change(title, { target: { value: '   ' } });
    fireEvent.change(title, { target: { value: 'The Bear season 4' } });
    act(() => vi.advanceTimersByTime(400));

    expect(calls.save).toHaveBeenCalledOnce();
    expect(calls.save).toHaveBeenCalledWith(subject, { title: 'The Bear season 4' });
  });

  it('still saves when only trailing whitespace changes before the debounce', () => {
    vi.useFakeTimers();
    const subject = item();
    mount(subject);
    const title = screen.getByLabelText('Title');

    fireEvent.change(title, { target: { value: 'The Bear season 4' } });
    fireEvent.change(title, { target: { value: 'The Bear season 4 ' } });
    act(() => vi.advanceTimersByTime(400));

    expect(calls.save).toHaveBeenCalledOnce();
    expect(calls.save).toHaveBeenCalledWith(subject, { title: 'The Bear season 4' });
  });

  it('flushes an in-focus field edit through the single close path', () => {
    vi.useFakeTimers();
    const subject = item();
    const onClose = vi.fn();
    mount(subject, list(), onClose);

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'The Bear finale' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    // The sheet owns its exit (P3-51): `onClose` reaches the owner after the `slow` tween.
    act(() => vi.advanceTimersByTime(300));

    expect(calls.save).toHaveBeenCalledWith(subject, { title: 'The Bear finale' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('persists configured Progress, Place, and Sub-item fields while typing', () => {
    vi.useFakeTimers();
    const subject = item({
      features: {
        progress: { kind: 'text', value: 'Page 10' },
        place: { label: 'Library', address: 'Main Street' },
        subItems: { entries: [{ id: 'sub_1', title: 'Paper', rank: 'a0' }] },
      },
    });
    mount(
      subject,
      list({
        featureConfig: {
          progress: { enabled: true, kind: 'text' },
          place: { enabled: true },
          subItems: {
            enabled: true,
            sectionLabel: 'Materials',
            singularLabel: 'Material',
          },
        },
      }),
    );

    fireEvent.change(screen.getByLabelText('Progress'), {
      target: { value: 'Page 11' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit place' }));
    fireEvent.change(screen.getByLabelText('Place'), {
      target: { value: 'Branch library' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Paper' }));
    fireEvent.change(screen.getByLabelText('Material'), {
      target: { value: 'Cardstock' },
    });
    act(() => vi.advanceTimersByTime(400));

    expect(calls.save).toHaveBeenCalledWith(subject, {
      features: { progress: { kind: 'text', value: 'Page 11' } },
    });
    expect(calls.save).toHaveBeenCalledWith(subject, {
      features: { place: { label: 'Branch library', address: 'Main Street' } },
    });
    expect(calls.save).toHaveBeenCalledWith(subject, {
      features: {
        subItems: {
          entries: [expect.objectContaining({ id: 'sub_1', title: 'Cardstock' })],
        },
      },
    });
  });
  it('uses the common Item details title and marks the top-aligned Note optional', () => {
    mount();

    expect(screen.getByRole('dialog', { name: 'Item details' })).toBeTruthy();
    expect(screen.getByText('Optional')).toBeTruthy();
    expect(screen.getByLabelText('Note').getAttribute('style')).toContain(
      'vertical-align: top',
    );
  });

  it('keeps hidden intrinsic state and exposes configured stage labels', () => {
    mount();
    expect(screen.queryByTestId('item-state-editor')).toBeNull();

    mount(
      item(),
      list({
        itemStateMode: {
          mode: 'stages',
          labels: { open: 'Saved', active: 'Reading', done: 'Read' },
          groupByState: true,
        },
      }),
    );
    expect(screen.getByText('Reading')).toBeTruthy();
  });

  it('exposes checkbox state as one compact explicit action and never offers active', () => {
    const subject = item({ state: 'active' });
    mount(subject, list({ itemStateMode: { mode: 'checkbox' } }));

    expect(screen.queryByText('Active')).toBeNull();
    expect(screen.getByText('Not completed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as done, Not completed' }));
    expect(calls.save).toHaveBeenCalledWith(subject, { state: 'done' });
  });

  it('writes open explicitly when the compact checkbox action marks a done item incomplete', () => {
    const subject = item({ state: 'done' });
    mount(subject, list({ itemStateMode: { mode: 'checkbox' } }));

    expect(screen.getByText('Completed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as not done, Completed' }));
    expect(calls.save).toHaveBeenCalledWith(subject, { state: 'open' });
  });

  it('shows a quiet Add affordance instead of blank episode or Place inputs', () => {
    mount(
      item(),
      list({
        featureConfig: {
          progress: { enabled: true, kind: 'episode' },
          place: { enabled: true },
        },
      }),
    );

    expect(screen.getAllByText('Add')).toHaveLength(2);
    expect(screen.queryByText('Season')).toBeNull();
    expect(screen.queryByText('Address')).toBeNull();
  });

  it('summarises populated Place compactly and retains its values when editing opens', () => {
    mount(
      item({
        features: {
          progress: { kind: 'episode', mediaKind: 'show', season: 2, episode: 4 },
          place: { label: 'Joe Coffee', address: '9 W 19th St' },
        },
      }),
      list({
        featureConfig: {
          progress: { enabled: true, kind: 'episode' },
          place: { enabled: true },
        },
      }),
    );

    expect(screen.getByDisplayValue('2')).toBeTruthy();
    expect(screen.getByDisplayValue('4')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Joe Coffee, 9 W 19th St' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit place' })).toBeTruthy();
    expect(screen.queryByDisplayValue('Joe Coffee')).toBeNull();
    expect(screen.queryByDisplayValue('9 W 19th St')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit place' }));

    expect(screen.getByDisplayValue('Joe Coffee')).toBeTruthy();
    expect(screen.getByDisplayValue('9 W 19th St')).toBeTruthy();
  });

  it('uses configured Sub-item vocabulary and creates a stable ranked child', () => {
    mount(
      item(),
      list({
        featureConfig: {
          subItems: {
            enabled: true,
            sectionLabel: 'Materials',
            singularLabel: 'Material',
            secondaryLabel: 'Quantity',
          },
        },
      }),
    );

    expect(screen.getByText('Materials')).toBeTruthy();
    expect(screen.getByText('0 items')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add material' }));

    expect(screen.getByLabelText('Material')).toBeTruthy();
    expect(screen.getByLabelText('Quantity')).toBeTruthy();
  });

  it('renders populated Sub-items as compact vertical rows with grip and overflow', () => {
    mount(
      item({
        features: {
          subItems: {
            entries: [
              { id: 'sub_1', title: 'Paper', secondary: '2 sheets', rank: 'a0' },
              { id: 'sub_2', title: 'Tape', rank: 'b0' },
            ],
          },
        },
      }),
      list({
        featureConfig: {
          subItems: {
            enabled: true,
            sectionLabel: 'Materials',
            singularLabel: 'Material',
            secondaryLabel: 'Quantity',
          },
        },
      }),
    );

    expect(screen.getByRole('button', { name: 'Reorder Paper' })).toBeTruthy();
    const handleSlot = screen.getByRole('button', {
      name: 'Reorder Paper',
    }).parentElement;
    if (handleSlot === null) throw new Error('Reorder handle must have a visible slot');
    expect(getComputedStyle(handleSlot).opacity).toBe('1');
    expect(
      getComputedStyle(screen.getByTestId('list-reorder-row-sub_1')).backgroundColor,
    ).toBe('rgba(0, 0, 0, 0)');
    expect(screen.getByRole('button', { name: 'Remove Paper' })).toBeTruthy();
    expect(screen.getByText('Paper')).toBeTruthy();
    expect(screen.getByText('2 sheets')).toBeTruthy();
    expect(screen.getByText('2 items')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Down' })).toBeNull();

    const grip = screen.getByRole('button', { name: 'Reorder Paper' });
    grip.focus();
    fireEvent.keyDown(document, { key: 'Enter' });
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(calls.save).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'The Bear' }),
      expect.objectContaining({
        features: {
          subItems: {
            entries: [
              expect.objectContaining({ id: 'sub_2', title: 'Tape' }),
              expect.objectContaining({ id: 'sub_1', title: 'Paper' }),
            ],
          },
        },
      }),
    );
    calls.save.mockClear();

    // Remove is a direct control on the row: a second Sheet cannot present over the item
    // sheet's own Modal on iOS, so a menu here is a button that does nothing on device.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Paper' }));
    expect(calls.save).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'The Bear' }),
      {
        features: {
          subItems: {
            entries: [expect.objectContaining({ id: 'sub_2', title: 'Tape' })],
          },
        },
      },
    );
  });

  it('uses configured singular lowercase copy for the compact Add action', () => {
    mount(
      item(),
      list({
        featureConfig: {
          subItems: {
            enabled: true,
            sectionLabel: 'Ingredients',
            singularLabel: 'Ingredient',
          },
        },
      }),
    );

    expect(screen.getByRole('button', { name: 'Add ingredient' })).toBeTruthy();
    expect(screen.queryByText('SUB-ITEMS')).toBeNull();
  });

  it('keeps a long single Sub-item compact when no secondary label is configured', () => {
    mount(
      item({
        features: {
          subItems: {
            entries: [
              {
                id: 'sub_long',
                title: 'A deliberately long ingredient title that needs two lines',
                rank: 'a0',
              },
            ],
          },
        },
      }),
      list({
        featureConfig: {
          subItems: {
            enabled: true,
            sectionLabel: 'Ingredients',
            singularLabel: 'Ingredient',
          },
        },
      }),
    );

    expect(screen.getByText('1 item')).toBeTruthy();
    expect(screen.queryByText('Quantity')).toBeNull();
    const row = screen.getByTestId('sub-item-sub_long').firstElementChild;
    if (!(row instanceof HTMLElement)) throw new Error('Sub-item row must render');
    expect(getComputedStyle(row).minHeight).toBe('56px');
  });

  it('does not expose retained values while their feature is disabled', () => {
    mount(
      item({
        features: {
          progress: { kind: 'text', value: 'Page 143' },
          place: { label: 'Library' },
          subItems: { entries: [{ id: 'sub_1', title: 'Paper', rank: 'a0' }] },
        },
      }),
      list({
        featureConfig: {
          progress: { enabled: false, kind: 'text' },
          place: { enabled: false },
          subItems: {
            enabled: false,
            sectionLabel: 'Materials',
            singularLabel: 'Material',
          },
        },
      }),
    );

    expect(screen.queryByDisplayValue('Page 143')).toBeNull();
    expect(screen.queryByDisplayValue('Library')).toBeNull();
    expect(screen.queryByText('Materials')).toBeNull();
  });

  it('removes from the stable destructive affordance', () => {
    const subject = item();
    mount(subject);

    const deleteItem = screen.getByRole('button', { name: 'Delete item' });
    fireEvent.click(deleteItem);

    expect(calls.remove).toHaveBeenCalledWith(subject);
    expect(getComputedStyle(deleteItem).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  });

  it('keeps stable automation handles on the primary fields', () => {
    mount();

    expect(screen.getByTestId('item-sheet-title')).toBeTruthy();
    expect(screen.getByTestId('item-sheet-note')).toBeTruthy();
  });

  it('does not erase a dirty field when another field refreshes from the server', () => {
    const subjectList = list();
    const mounted = mount(item(), subjectList);
    fireEvent.change(screen.getByLabelText('Note'), {
      target: { value: 'Draft note' },
    });

    mounted.rerender(
      <ThemeProvider scheme="light">
        <ItemSheet
          open
          list={subjectList}
          item={item({ title: 'The Bear, renamed' })}
          onClose={vi.fn()}
          onChanged={vi.fn()}
          onRemoved={vi.fn()}
        />
      </ThemeProvider>,
    );

    expect(screen.getByDisplayValue('The Bear, renamed')).toBeTruthy();
    expect(screen.getByDisplayValue('Draft note')).toBeTruthy();
  });
});
