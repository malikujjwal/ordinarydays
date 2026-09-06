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
  it('opens details from every supporting line while Maps and checkbox stay independent', () => {
    const onOpen = vi.fn();
    const onOpenLocation = vi.fn();
    const onToggleChecked = vi.fn(async () => true);
    render(
      <ThemeProvider scheme="light">
        <ListItemRow
          list={list({
            featureConfig: {
              progress: { enabled: true, kind: 'episode' },
              place: { enabled: true },
              subItems: {
                enabled: true,
                sectionLabel: 'Ingredients',
                singularLabel: 'Ingredient',
              },
            },
          })}
          item={item({
            note: 'Watch over coffee',
            features: {
              progress: { kind: 'episode', season: 2, episode: 4 },
              place: { label: 'Joe Coffee', address: '9 W 19th St' },
              subItems: { entries: [{ id: 'sub_1', title: 'Milk', rank: 'a0' }] },
            },
          })}
          onOpen={onOpen}
          onOpenLocation={onOpenLocation}
          onToggleChecked={onToggleChecked}
        />
      </ThemeProvider>,
    );

    for (const text of [
      'The Bear',
      'Watch over coffee',
      'S2 E4',
      '9 W 19th St',
      '1 Ingredient',
    ]) {
      fireEvent.click(screen.getByText(text));
    }
    expect(onOpen).toHaveBeenCalledTimes(5);
    expect(onOpenLocation).not.toHaveBeenCalled();
    expect(onToggleChecked).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '9 W 19th St, open in Maps' }));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onOpenLocation).toHaveBeenCalledOnce();
    expect(onToggleChecked).toHaveBeenCalledWith(true);
    expect(onOpen).toHaveBeenCalledTimes(5);
  });

  it('maps only done to a checked checkbox and writes the requested next value', () => {
    const handlers = mount(item({ state: 'done' }));
    const checkbox = screen.getByRole('checkbox', { name: 'The Bear, checked' });

    expect(checkbox.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(checkbox);
    expect(handlers.onToggleChecked).toHaveBeenCalledWith(false);
  });

  it('turns two rapid presses into check then uncheck before the parent rerenders', () => {
    const handlers = mount(item({ state: 'open' }));
    const checkbox = screen.getByRole('checkbox', { name: 'The Bear, not checked' });

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
    fireEvent.click(screen.getByRole('checkbox', { name: 'The Bear, checked' }));
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
    fireEvent.click(screen.getByRole('checkbox', { name: 'The Bear, not checked' }));

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

    fireEvent.click(screen.getByRole('checkbox', { name: 'The Bear, not checked' }));
    expect(
      screen
        .getByRole('checkbox', { name: 'The Bear, checked' })
        .getAttribute('aria-checked'),
    ).toBe('true');

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

    expect(
      screen
        .getByRole('checkbox', { name: 'The Bear, not checked' })
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  it.each(['open', 'active'] as const)(
    'renders %s unchecked in checkbox mode',
    (state) => {
      mount(item({ state }));
      expect(
        screen
          .getByRole('checkbox', { name: 'The Bear, not checked' })
          .getAttribute('aria-checked'),
      ).toBe('false');
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

    expect(screen.queryByText('Building')).toBeNull();
    expect(screen.queryByTestId('row-checkbox')).toBeNull();
    expect(screen.getByTestId('row-leading-marker')).toBeTruthy();
  });

  it('gives checkbox rows a stable leading column and strong, roomy row typography', () => {
    mount(item());

    expect(getComputedStyle(screen.getByTestId('row')).minHeight).toBe('72px');
    expect(getComputedStyle(screen.getByTestId('row-title')).fontWeight).toBe('600');
  });

  it('keeps a simple row clean without reserving an empty leading-control column', () => {
    mount(item(), list({ itemStateMode: { mode: 'none' } }));

    expect(screen.queryByTestId('row-checkbox')).toBeNull();
    expect(screen.queryByTestId('row-leading-marker')).toBeNull();
    expect(getComputedStyle(screen.getByTestId('row')).minHeight).toBe('72px');
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

/**
 * The caller-scoped Plan state line (P3-35, `interaction-contract.md` §6.2): two separate
 * accessibility elements with the contract's labels, and two separate destinations.
 */
describe('the Plan state line', () => {
  const scheduled = {
    type: 'event',
    status: 'scheduled',
    schedule: { date: '2026-08-15', time: '19:00', timezone: 'America/New_York' },
  } as const;

  function mountWithPlan(
    viewerPlan: Parameters<typeof ListItemRow>[0]['viewerPlan'],
    planStateLine?: string,
    planStateLineSpoken?: string,
  ) {
    const onOpen = vi.fn();
    const onOpenPlan = vi.fn();
    render(
      <ThemeProvider scheme="light">
        <ListItemRow
          list={list({ itemStateMode: { mode: 'none' } })}
          item={item({ title: 'Zahav' })}
          {...(viewerPlan === undefined ? {} : { viewerPlan })}
          {...(planStateLine === undefined ? {} : { planStateLine })}
          {...(planStateLineSpoken === undefined ? {} : { planStateLineSpoken })}
          onOpen={onOpen}
          onOpenPlan={onOpenPlan}
          testID="row"
        />
      </ThemeProvider>,
    );
    return { onOpen, onOpenPlan };
  }

  it('renders the title and the state line as two separate targets with two destinations', () => {
    const handlers = mountWithPlan(
      scheduled,
      'Planned Saturday · 7 PM',
      'Planned Saturday 7:00 PM',
    );

    const body = screen.getByRole('button', { name: 'Zahav' });
    const line = screen.getByRole('link', {
      name: 'Planned Saturday 7:00 PM, open plan',
    });

    fireEvent.click(body);
    expect(handlers.onOpen).toHaveBeenCalledOnce();
    expect(handlers.onOpenPlan).not.toHaveBeenCalled();

    fireEvent.click(line);
    expect(handlers.onOpenPlan).toHaveBeenCalledOnce();
    expect(handlers.onOpen).toHaveBeenCalledOnce();
  });

  it('renders Cancelled with the same tap target and no date suffix', () => {
    const handlers = mountWithPlan(
      { type: 'event', status: 'cancelled' },
      'Cancelled',
      'Cancelled',
    );
    fireEvent.click(screen.getByRole('link', { name: 'Cancelled, open plan' }));
    expect(handlers.onOpenPlan).toHaveBeenCalledOnce();
  });

  it('renders no line for a saved plan even when a caller passes one', () => {
    mountWithPlan({ type: 'event', status: 'saved' }, 'Planned Saturday');
    expect(screen.queryByTestId('row-plan-state')).toBeNull();
  });

  it('renders no line for a stale skipped projection, defensively', () => {
    mountWithPlan({ ...scheduled, status: 'skipped' }, 'Planned Saturday');
    expect(screen.queryByTestId('row-plan-state')).toBeNull();
  });
});
