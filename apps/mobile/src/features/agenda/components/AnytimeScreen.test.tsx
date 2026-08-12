import type { ActivityListItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnytimeScreen } from './AnytimeScreen';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-test-key' }));

const state = vi.hoisted(() => ({
  view: {
    status: 'pending' as 'pending' | 'success' | 'error',
    items: [] as ActivityListItem[],
    timezone: 'UTC',
    refetch: vi.fn(),
    isLoadingMore: false,
    isOffline: false,
    hasMore: false,
    loadMore: vi.fn(),
  },
  toggleComplete: vi.fn(),
  onAgendaAction: vi.fn(),
}));

vi.mock('@/features/agenda/hooks/useAnytime', () => ({
  useAnytime: () => state.view,
}));
vi.mock('@/features/agenda/hooks/useAgendaActivityActions', () => ({
  useAgendaActivityActions: () => ({
    toggleComplete: state.toggleComplete,
    onAgendaAction: state.onAgendaAction,
  }),
}));

const row = (activityId: string, title: string): ActivityListItem => ({
  activityId,
  type: 'task',
  title,
  status: 'saved',
  isRecurring: false,
  participantCount: 0,
});

function mount(onBack = vi.fn(), onOpenAgendaItem = vi.fn()) {
  return {
    ...render(
      <SafeAreaProvider>
        <ThemeProvider scheme="light">
          <AnytimeScreen onBack={onBack} onOpenAgendaItem={onOpenAgendaItem} />
        </ThemeProvider>
      </SafeAreaProvider>,
    ),
    onBack,
    onOpenAgendaItem,
  };
}

beforeEach(() => {
  state.view.status = 'pending';
  state.view.items = [];
  state.view.isLoadingMore = false;
  state.view.isOffline = false;
  state.view.hasMore = false;
  state.view.refetch.mockReset();
  state.view.loadMore.mockReset();
  state.toggleComplete.mockReset();
  state.onAgendaAction.mockReset();
});

describe('AnytimeScreen', () => {
  it('renders its route chrome and initial five-row skeleton', () => {
    const mounted = mount();

    expect(screen.getByRole('heading', { name: 'Anytime' })).toBeDefined();
    expect(screen.getByRole('progressbar', { name: 'Loading' }).children).toHaveLength(5);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(mounted.onBack).toHaveBeenCalledOnce();
  });

  it('renders the exact empty state with no empty-state action', () => {
    state.view.status = 'success';
    mount();

    const empty = screen.getByTestId('anytime-empty');
    expect(within(empty).getByText('No anytime tasks')).toBeDefined();
    expect(within(empty).getByText('Add a task without choosing a date.')).toBeDefined();
    expect(within(empty).queryByRole('button')).toBeNull();
  });

  it('preserves row order and reuses shared gestures, accessibility and row opening', () => {
    state.view.status = 'success';
    state.view.items = [row('act_B', 'Newest'), row('act_A', 'Older')];
    const mounted = mount();

    expect(
      screen.getAllByTestId(/^agenda-row-act_/).map((entry) => entry.textContent),
    ).toEqual(['Newest', 'Older']);
    fireEvent.pointerEnter(screen.getAllByTestId(/^swipeable-row-/)[0] as Element);
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    expect(state.onAgendaAction).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Newest' }),
      expect.objectContaining({ name: 'complete' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /Newest, today, no time/ }));
    expect(mounted.onOpenAgendaItem).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Newest' }),
    );
  });

  it('loads the next page at 80% and shows one footer skeleton', async () => {
    state.view.status = 'success';
    state.view.items = [row('act_A', 'One')];
    state.view.isLoadingMore = true;
    mount();
    const list = screen.getByTestId('anytime-list');
    Object.defineProperties(list, {
      scrollTop: { value: 599, writable: true },
      offsetHeight: { value: 200 },
      scrollHeight: { value: 1000 },
    });

    fireEvent.scroll(list);
    expect(state.view.loadMore).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    list.scrollTop = 600;
    fireEvent.scroll(list);

    expect(state.view.loadMore).toHaveBeenCalledOnce();
    expect(
      within(screen.getByTestId('anytime-loading-more')).getByRole('progressbar')
        .children,
    ).toHaveLength(1);
  });

  it('renders no search, filter or group controls', () => {
    state.view.status = 'success';
    state.view.items = [row('act_A', 'One')];
    mount();

    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByText(/filter|group/i)).toBeNull();
  });
});
