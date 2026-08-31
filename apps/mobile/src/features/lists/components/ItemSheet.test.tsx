import type { List, ListItemView } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

function mount(subject = item(), subjectList = list()) {
  return render(
    <ThemeProvider scheme="light">
      <ItemSheet
        open
        list={subjectList}
        item={subject}
        onClose={vi.fn()}
        onChanged={vi.fn()}
        onRemoved={vi.fn()}
      />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  calls.save.mockReset();
  calls.remove.mockReset();
});

describe('the canonical item editor shell', () => {
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

  it('exposes checkbox state as one checkbox and never offers active', () => {
    const subject = item({ state: 'active' });
    mount(subject, list({ itemStateMode: { mode: 'checkbox' } }));

    expect(screen.queryByText('Active')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Done' }));
    expect(calls.save).toHaveBeenCalledWith(subject, { state: 'done' });
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

  it('renders populated episode Progress and Place editors without preset inspection', () => {
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
    expect(screen.getByRole('button', { name: 'More actions for Paper' })).toBeTruthy();
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

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Paper' }));
    expect(screen.getByRole('dialog', { name: 'Paper actions' })).toBeTruthy();
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
    fireEvent.change(screen.getByTestId('item-sheet-note'), {
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
