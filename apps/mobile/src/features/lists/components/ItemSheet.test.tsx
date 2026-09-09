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

describe('the canonical item editor shell', async () => {
  it('persists Title and Note while typing without requiring blur', async () => {
    vi.useFakeTimers();
    const subject = item({ note: 'Pilot' });
    mount(subject);

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'The Bear season 4' },
    });
    fireEvent.change(screen.getByLabelText('Note'), {
      target: { value: 'Watch on Thursday' },
    });
    await act(async () => vi.advanceTimersByTime(400));

    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledWith(subject, { title: 'The Bear season 4' });
    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledWith(subject, { note: 'Watch on Thursday' });
  });

  it('does not allow an item to be renamed to an empty title', async () => {
    vi.useFakeTimers();
    const subject = item();
    mount(subject);

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: '   ' },
    });
    await act(async () => vi.advanceTimersByTime(400));

    expect(screen.getByText('Title is required.')).toBeTruthy();
    await act(async () => undefined);
    expect(calls.save).not.toHaveBeenCalledWith(
      subject,
      expect.objectContaining({ title: '' }),
    );
  });

  it('does not repeat an accepted title write after an invalid blank draft', async () => {
    vi.useFakeTimers();
    const subject = item();
    mount(subject);
    const title = screen.getByLabelText('Title');

    fireEvent.change(title, { target: { value: 'The Bear season 4' } });
    await act(async () => vi.advanceTimersByTime(400));
    fireEvent.change(title, { target: { value: '   ' } });
    fireEvent.blur(title);
    fireEvent.change(title, { target: { value: 'The Bear season 4' } });
    await act(async () => vi.advanceTimersByTime(400));

    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledTimes(1);
    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledWith(subject, { title: 'The Bear season 4' });
  });

  it('still saves a restored valid title when blank input interrupted its debounce', async () => {
    vi.useFakeTimers();
    const subject = item();
    mount(subject);
    const title = screen.getByLabelText('Title');

    fireEvent.change(title, { target: { value: 'The Bear season 4' } });
    fireEvent.change(title, { target: { value: '   ' } });
    fireEvent.change(title, { target: { value: 'The Bear season 4' } });
    await act(async () => vi.advanceTimersByTime(400));

    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledOnce();
    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledWith(subject, { title: 'The Bear season 4' });
  });

  it('still saves when only trailing whitespace changes before the debounce', async () => {
    vi.useFakeTimers();
    const subject = item();
    mount(subject);
    const title = screen.getByLabelText('Title');

    fireEvent.change(title, { target: { value: 'The Bear season 4' } });
    fireEvent.change(title, { target: { value: 'The Bear season 4 ' } });
    await act(async () => vi.advanceTimersByTime(400));

    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledOnce();
    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledWith(subject, { title: 'The Bear season 4' });
  });

  it('flushes an in-focus field edit through the single close path', async () => {
    vi.useFakeTimers();
    const subject = item();
    const onClose = vi.fn();
    mount(subject, list(), onClose);

    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'The Bear finale' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    // The sheet owns its exit (P3-51): `onClose` reaches the owner after the `slow` tween.
    await act(async () => vi.advanceTimersByTime(300));

    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledWith(subject, { title: 'The Bear finale' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('persists configured Progress, Place, and Sub-item fields while typing', async () => {
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
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Branch library' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Edit Paper' }));
    fireEvent.change(screen.getByLabelText('Material'), {
      target: { value: 'Cardstock' },
    });
    await act(async () => vi.advanceTimersByTime(400));

    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledWith(subject, {
      features: { progress: { kind: 'text', value: 'Page 11' } },
    });
    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledWith(subject, {
      features: { place: { label: 'Branch library', address: 'Main Street' } },
    });
    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledWith(subject, {
      features: {
        subItems: {
          entries: [expect.objectContaining({ id: 'sub_1', title: 'Cardstock' })],
        },
      },
    });
  });
  it('uses the common Item details title and marks the top-aligned Note optional', async () => {
    mount();

    expect(screen.getByRole('dialog', { name: 'Item details' })).toBeTruthy();
    expect(screen.getByText('Optional')).toBeTruthy();
    expect(screen.getByLabelText('Note').getAttribute('style')).toContain(
      'vertical-align: top',
    );
  });

  it('keeps hidden intrinsic state and exposes configured stage labels', async () => {
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

  it('exposes compact explicit checkbox choices and never offers active', async () => {
    const subject = item({ state: 'active' });
    mount(subject, list({ itemStateMode: { mode: 'checkbox' } }));

    expect(screen.queryByText('Active')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Not done' }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledWith(subject, { state: 'done' });
  });

  it('writes open explicitly when the compact checkbox action marks a done item incomplete', async () => {
    const subject = item({ state: 'done' });
    mount(subject, list({ itemStateMode: { mode: 'checkbox' } }));

    expect(
      screen.getByRole('button', { name: 'Done' }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Not done' }));
    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledWith(subject, { state: 'open' });
  });

  it('keeps optional episode progress behind Add and labels Place inputs Name and Address', async () => {
    mount(
      item(),
      list({
        featureConfig: {
          progress: { enabled: true, kind: 'episode' },
          place: { enabled: true },
        },
      }),
    );

    expect(screen.getAllByText('Add')).toHaveLength(1);
    expect(screen.queryByText('Season')).toBeNull();
    expect(screen.getByLabelText('Address')).toBeTruthy();
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('shows populated Place in its Name and Address editors without redundant labels', async () => {
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
    expect(screen.getByDisplayValue('Joe Coffee')).toBeTruthy();
    expect(screen.getByDisplayValue('9 W 19th St')).toBeTruthy();
  });

  it('uses configured Sub-item vocabulary and creates a stable ranked child', async () => {
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

  it('renders populated Sub-items as compact vertical rows with grip and direct removal', async () => {
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
    await act(async () => undefined);
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
    await act(async () => undefined);
    calls.save.mockClear();

    // Remove is a direct control on the row: a second Sheet cannot present over the item
    // sheet's own Modal on iOS, so a menu here is a button that does nothing on device.
    fireEvent.click(screen.getByRole('button', { name: 'Remove Paper' }));
    await act(async () => undefined);
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

  it('uses configured singular lowercase copy for the compact Add action', async () => {
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

  it('keeps a long single Sub-item compact when no secondary label is configured', async () => {
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

  it('does not expose retained values while their feature is disabled', async () => {
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

  it('removes from the stable destructive affordance', async () => {
    const subject = item();
    mount(subject);

    const deleteItem = screen.getByRole('button', { name: 'Delete item' });
    fireEvent.click(deleteItem);

    await act(async () => undefined);
    expect(calls.remove).toHaveBeenCalledWith(subject);
    expect(getComputedStyle(deleteItem).backgroundColor).toBe('rgba(0, 0, 0, 0)');
  });

  it('keeps stable automation handles on the primary fields', async () => {
    mount();

    expect(screen.getByTestId('item-sheet-title')).toBeTruthy();
    expect(screen.getByTestId('item-sheet-note')).toBeTruthy();
  });

  it('does not erase a dirty field when another field refreshes from the server', async () => {
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

describe('truthful item autosave feedback', async () => {
  it('waits for persistence, retains a failed draft, and retries it once', async () => {
    vi.useFakeTimers();
    let rejectWrite: (accepted: boolean) => void = () => undefined;
    calls.save.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          rejectWrite = resolve;
        }),
    );
    mount();
    expect(screen.getByText('Changes save automatically.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Note'), {
      target: { value: 'Keep this draft' },
    });
    expect(screen.getByText('Changes waiting to save…')).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(screen.getByText('Saving…')).toBeTruthy();
    expect(screen.queryByText('All changes saved')).toBeNull();
    await act(async () => {
      rejectWrite(false);
    });
    expect(screen.getByDisplayValue('Keep this draft')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry' });
    await act(async () => {
      fireEvent.click(retry);
      fireEvent.click(retry);
    });
    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledTimes(2);
    expect(screen.getByText('All changes saved')).toBeTruthy();
  });

  it('serializes a newer edit including a return to the old value behind the pending acknowledgement', async () => {
    vi.useFakeTimers();
    let accept: (accepted: boolean) => void = () => undefined;
    calls.save.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          accept = resolve;
        }),
    );
    mount();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'First edit' } });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'The Bear' } });
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    await act(async () => undefined);
    expect(calls.save).toHaveBeenCalledTimes(1);
    await act(async () => {
      accept(true);
    });
    await act(async () => undefined);
    expect(calls.save).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'First edit' }),
      { title: 'The Bear' },
    );
    expect(screen.getByDisplayValue('The Bear')).toBeTruthy();
    expect(screen.getByText('All changes saved')).toBeTruthy();
  });
});

it('does not certify an address without its required Place name as saved', async () => {
  vi.useFakeTimers();
  mount(item(), list({ featureConfig: { place: { enabled: true } } }));
  fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'Saved note' } });
  await act(async () => vi.advanceTimersByTime(350));
  fireEvent.change(screen.getByLabelText('Address'), {
    target: { value: '48 Cedar Lane' },
  });
  await act(async () => vi.advanceTimersByTime(350));
  expect(screen.getByText('Name is required when an address is present.')).toBeTruthy();
  expect(screen.queryByText('All changes saved')).toBeNull();
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ember' } });
  await act(async () => vi.advanceTimersByTime(350));
  expect(calls.save).toHaveBeenLastCalledWith(expect.anything(), {
    features: { place: { label: 'Ember', address: '48 Cedar Lane' } },
  });
  expect(screen.getByText('All changes saved')).toBeTruthy();
});

it.each(['abc', '-1', '2.5', '1001'])(
  'retains invalid Season %s without acknowledging a coerced value',
  async (value) => {
    vi.useFakeTimers();
    mount(
      item({ features: { progress: { kind: 'episode', season: 2, episode: 4 } } }),
      list({ featureConfig: { progress: { enabled: true, kind: 'episode' } } }),
    );
    fireEvent.change(screen.getByLabelText('Season'), { target: { value } });
    await act(async () => vi.advanceTimersByTime(350));
    expect(screen.getByDisplayValue(value)).toBeTruthy();
    expect(screen.getByText('Use a whole number from 0 to 1000.')).toBeTruthy();
    expect(calls.save).not.toHaveBeenCalled();
    expect(screen.queryByText('All changes saved')).toBeNull();
  },
);

it('flushes and dismisses before navigating through item provenance', async () => {
  vi.useFakeTimers();
  const onClose = vi.fn();
  const onSource = vi.fn();
  const subject = item({
    sourceLabel: 'Sunday dinner',
    sourceActivityId: 'act_01J8XKQ2M4N5P6R7S8T9V0W1X3',
  });
  render(
    <ThemeProvider scheme="light">
      <ItemSheet
        open
        item={subject}
        list={list()}
        onClose={onClose}
        onChanged={vi.fn()}
        onRemoved={vi.fn()}
        onOpenSource={onSource}
      />
    </ThemeProvider>,
  );
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'Changed before navigation' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'From Sunday dinner' }));
  await act(async () => undefined);
  expect(onClose).toHaveBeenCalledOnce();
  expect(onSource).toHaveBeenCalledWith(subject.sourceActivityId);
  expect(calls.save).toHaveBeenCalledWith(subject, {
    title: 'Changed before navigation',
  });
});
