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

    fireEvent.click(screen.getByText('Add Material'));

    expect(screen.getByText('Materials')).toBeTruthy();
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
    expect(screen.getByRole('button', { name: 'More actions for Paper' })).toBeTruthy();
    expect(screen.getByDisplayValue('Paper')).toBeTruthy();
    expect(screen.getByDisplayValue('2 sheets')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Up' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Down' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Paper' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Paper' }));
    expect(calls.save).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'The Bear' }),
      {
        features: { subItems: { entries: [{ id: 'sub_2', title: 'Tape', rank: 'b0' }] } },
      },
    );
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

    fireEvent.click(screen.getByTestId('item-sheet-delete'));

    expect(calls.remove).toHaveBeenCalledWith(subject);
    expect(screen.getByTestId('item-sheet-delete').getAttribute('style')).not.toContain(
      'background-color',
    );
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
