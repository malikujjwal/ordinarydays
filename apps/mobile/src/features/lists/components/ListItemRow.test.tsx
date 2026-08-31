import type { List, ListItemView } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ListItemRow } from './ListItemRow';

const list = (
  overrides: Partial<Pick<List, 'itemStateMode' | 'featureConfig'>> = {},
) => ({
  itemStateMode: { mode: 'checkbox' } as List['itemStateMode'],
  featureConfig: {} as List['featureConfig'],
  ...overrides,
});

const item = (overrides: Partial<ListItemView> = {}): ListItemView => ({
  listId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1X2',
  itemId: 'itm_01J8XKQ2M4N5P6R7S8T9V0W1X3',
  rank: 'a0',
  title: 'The Bear',
  state: 'open',
  ...overrides,
});

function mount(
  subject: ListItemView,
  subjectList = list(),
  handlers = {
    onToggleChecked: vi.fn(async () => true),
    onOpenLocation: vi.fn(),
  },
) {
  render(
    <ThemeProvider scheme="light">
      <ListItemRow
        list={subjectList}
        item={subject}
        onToggleChecked={handlers.onToggleChecked}
        onOpenLocation={handlers.onOpenLocation}
        testID="row"
      />
    </ThemeProvider>,
  );
  return handlers;
}

describe('the canonical list item shell', () => {
  it('maps only done to a checked checkbox and writes the requested next value', () => {
    const handlers = mount(item({ state: 'done' }));
    const checkbox = screen.getByTestId('row-checkbox');

    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(checkbox);
    expect(handlers.onToggleChecked).toHaveBeenCalledWith(false);
  });

  it('turns two rapid presses into check then uncheck before the parent rerenders', () => {
    const handlers = mount(item({ state: 'open' }));
    const checkbox = screen.getByTestId('row-checkbox');

    fireEvent.click(checkbox);
    fireEvent.click(checkbox);

    expect(handlers.onToggleChecked.mock.calls).toEqual([[true], [false]]);
  });

  it('does not let an intermediate commit overwrite a newer rapid tap', () => {
    const onToggleChecked = vi.fn(() => new Promise<boolean>(() => undefined));
    const rendered = render(
      <ThemeProvider scheme="light">
        <ListItemRow
          list={list()}
          item={item({ state: 'open' })}
          onToggleChecked={onToggleChecked}
          testID="row"
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'The Bear, not checked' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'The Bear, not checked' }));
    rendered.rerender(
      <ThemeProvider scheme="light">
        <ListItemRow
          list={list()}
          item={item({ state: 'done' })}
          onToggleChecked={onToggleChecked}
          testID="row"
        />
      </ThemeProvider>,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'The Bear, checked' }));

    expect(onToggleChecked.mock.calls).toEqual([[true], [false], [true]]);
  });

  it('adopts a bulk uncheck that lands while an earlier checkbox write is settling', async () => {
    let settle: ((accepted: boolean) => void) | undefined;
    const onToggleChecked = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
    );
    const rendered = render(
      <ThemeProvider scheme="light">
        <ListItemRow
          list={list()}
          item={item({ state: 'open' })}
          onToggleChecked={onToggleChecked}
          testID="row"
        />
      </ThemeProvider>,
    );

    fireEvent.click(screen.getByTestId('row-checkbox'));
    expect(screen.getByTestId('row-checkbox').getAttribute('aria-checked')).toBe('true');

    // The individual write acknowledges, then Uncheck all changes the committed row again
    // before the original promise has retired from the optimistic toggle queue.
    rendered.rerender(
      <ThemeProvider scheme="light">
        <ListItemRow
          list={list()}
          item={item({ state: 'done' })}
          onToggleChecked={onToggleChecked}
          testID="row"
        />
      </ThemeProvider>,
    );
    rendered.rerender(
      <ThemeProvider scheme="light">
        <ListItemRow
          list={list()}
          item={item({ state: 'open' })}
          onToggleChecked={onToggleChecked}
          testID="row"
        />
      </ThemeProvider>,
    );

    await act(async () => settle?.(true));

    expect(screen.getByTestId('row-checkbox').getAttribute('aria-checked')).toBe('false');
  });

  it.each(['open', 'active'] as const)(
    'renders %s unchecked in checkbox mode',
    (state) => {
      mount(item({ state }));
      expect(screen.getByTestId('row-checkbox').getAttribute('aria-checked')).toBe(
        'false',
      );
    },
  );

  it('uses configured stage vocabulary without a preset branch', () => {
    mount(
      item({ state: 'active' }),
      list({
        itemStateMode: {
          mode: 'stages',
          labels: { open: 'Queued', active: 'Building', done: 'Shipped' },
          groupByState: true,
        },
      }),
    );

    expect(screen.getByText('Building')).toBeTruthy();
    expect(screen.queryByTestId('row-checkbox')).toBeNull();
  });

  it('renders only populated enabled typed feature summaries', () => {
    mount(
      item({
        features: {
          progress: { kind: 'episode', season: 2, episode: 4 },
          place: { label: 'Joe Coffee', address: '9 W 19th St' },
          subItems: { entries: [{ id: 'sub_1', title: 'Milk', rank: 'a0' }] },
        },
      }),
      list({
        featureConfig: {
          progress: { enabled: true, kind: 'episode' },
          place: { enabled: true },
          subItems: {
            enabled: true,
            sectionLabel: 'Ingredients',
            singularLabel: 'Ingredient',
          },
        },
      }),
    );

    expect(screen.getByText('S2 E4')).toBeTruthy();
    expect(screen.getByText('1 Ingredient')).toBeTruthy();
    expect(screen.getByText('9 W 19th St')).toBeTruthy();
  });

  it('retains but hides disabled values and emits no empty metadata', () => {
    mount(
      item({
        features: {
          progress: { kind: 'text', value: 'Page 143' },
          subItems: { entries: [] },
        },
      }),
      list({
        featureConfig: {
          progress: { enabled: false, kind: 'text' },
          subItems: {
            enabled: true,
            sectionLabel: 'Materials',
            singularLabel: 'Material',
          },
        },
      }),
    );

    expect(screen.queryByText('Page 143')).toBeNull();
    expect(screen.queryByText(/No materials/i)).toBeNull();
    expect(screen.queryByTestId('row-metadata')).toBeNull();
  });
});
