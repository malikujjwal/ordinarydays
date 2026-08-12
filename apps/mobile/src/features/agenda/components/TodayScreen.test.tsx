import { fixedClock, type Instant } from '@od/shared/time';
import type { AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import { TodayScreen } from './TodayScreen';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'idem-test-key' }));

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const row = (index: number, patch: Partial<AgendaItem> = {}): AgendaItem => ({
  activityId: `act_01J8SEED${'0'.repeat(16)}${CROCKFORD[index % CROCKFORD.length]}${CROCKFORD[(index * 7) % CROCKFORD.length]}`,
  type: 'task',
  title: `Row ${index}`,
  status: 'scheduled',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
  ...patch,
});

function response(items: AgendaItem[], upNext?: AgendaItem) {
  return {
    data: {
      days: [
        {
          date: '2026-08-06',
          ...(upNext === undefined ? {} : { upNext }),
          schedule: items.filter((item) => item.time !== undefined),
          anytime: items.filter((item) => item.time === undefined),
          earlier: [],
        },
      ],
      warnings: [],
    },
    meta: { requestId: 'req_today' },
  };
}

function stubFetch(body: unknown) {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    }),
  );
}

function createClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always' } },
  });
  client.setQueryData(['me'], { timezone: 'UTC' });
  return client;
}

function mount(ui: ReactNode, client = createClient()) {
  const mounted = render(
    <SafeAreaProvider>
      <ClockProvider clock={fixedClock('2026-08-06T15:10:00.000Z' as Instant)}>
        <ThemeProvider scheme="light">
          <QueryClientProvider client={client}>{ui}</QueryClientProvider>
        </ThemeProvider>
      </ClockProvider>
    </SafeAreaProvider>,
  );
  return { ...mounted, client };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TodayScreen', () => {
  it('uses the server UP NEXT row for the initial paint', async () => {
    const serverUpNext = row(1, { title: 'Server snapshot', time: '15:00' });
    stubFetch(
      response(
        [serverUpNext, row(2, { title: 'Local next', time: '15:30' })],
        serverUpNext,
      ),
    );
    mount(<TodayScreen onOpenAnytime={() => {}} onOpenAgendaItem={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('up-next-card')).toBeDefined());
    expect(
      within(screen.getByTestId('up-next-card')).getByText('Server snapshot'),
    ).toBeDefined();
  });

  it('renders non-empty sections in fixed order and omits an empty section', async () => {
    stubFetch(
      response([
        row(1, { title: 'Later', time: '18:00' }),
        row(2, { title: 'Any task' }),
        row(3, { title: 'Passed', time: '10:00', isPast: true }),
      ]),
    );
    const first = mount(
      <TodayScreen onOpenAnytime={() => {}} onOpenAgendaItem={() => {}} />,
    );

    await waitFor(() => expect(screen.getByTestId('today-agenda')).toBeDefined());
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings).toEqual([
      'Today',
      'Up next',
      'Schedule',
      'Anytime',
      'Earlier today',
    ]);

    first.unmount();
    stubFetch(response([row(4, { title: 'Only anytime' })]));
    const second = mount(
      <TodayScreen onOpenAnytime={() => {}} onOpenAgendaItem={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText('Only anytime')).toBeDefined());
    expect(screen.queryByRole('heading', { name: 'Schedule' })).toBeNull();
    second.unmount();
  });

  it('caps saved rows at 20 and routes the exact total through See all', async () => {
    const onOpenAnytime = vi.fn();
    const saved = Array.from({ length: 25 }, (_, index) =>
      row(index, {
        title: `Saved ${String(index).padStart(2, '0')}`,
        status: 'saved',
      }),
    );
    stubFetch(response(saved));
    mount(<TodayScreen onOpenAnytime={onOpenAnytime} onOpenAgendaItem={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('today-anytime')).toBeDefined());
    expect(screen.getAllByTestId(/^agenda-row-act_/)).toHaveLength(20);
    fireEvent.click(screen.getByRole('button', { name: 'See all (25)' }));
    expect(onOpenAnytime).toHaveBeenCalledOnce();
  });

  it('collapses Earlier today to 10 rows and expands locally', async () => {
    const passed = Array.from({ length: 12 }, (_, index) =>
      row(index, {
        title: `Passed ${String(index).padStart(2, '0')}`,
        time: `${String(index + 1).padStart(2, '0')}:00`,
        isPast: true,
      }),
    );
    stubFetch(response(passed));
    mount(<TodayScreen onOpenAnytime={() => {}} onOpenAgendaItem={() => {}} />);

    await waitFor(() => expect(screen.getByTestId('today-earlier')).toBeDefined());
    expect(screen.getAllByTestId(/^agenda-row-act_/)).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getAllByTestId(/^agenda-row-act_/)).toHaveLength(12);
  });

  it('strikes a completed row in place before revealing its Earlier today projection', async () => {
    vi.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
    stubFetch(
      response([
        row(1, { title: 'First task', time: '15:30' }),
        row(2, { title: 'Second task', time: '16:00' }),
      ]),
    );
    const client = createClient();
    const onToggleComplete = vi.fn((changed: AgendaItem, checked: boolean) => {
      client.setQueriesData({ queryKey: ['agenda'] }, (cached: unknown) => {
        const data = cached as { days?: Array<{ schedule?: AgendaItem[] }> } | undefined;
        if (data?.days?.[0]?.schedule === undefined) return cached;
        return {
          ...data,
          days: data.days.map((day) => ({
            ...day,
            schedule: day.schedule?.map((item) =>
              item.activityId === changed.activityId
                ? { ...item, status: checked ? 'completed' : 'scheduled' }
                : item,
            ),
          })),
        };
      });
    });
    mount(
      <TodayScreen
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
        onToggleComplete={onToggleComplete}
      />,
      client,
    );

    await waitFor(() =>
      expect(
        screen.getAllByRole('checkbox', { name: 'First task, not completed' }),
      ).toHaveLength(2),
    );
    fireEvent.click(
      screen.getAllByRole('checkbox', {
        name: 'First task, not completed',
      })[0] as Element,
    );

    expect(onToggleComplete).toHaveBeenCalledOnce();
    expect(onToggleComplete).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'First task' }),
      true,
    );
    expect(
      within(screen.getByTestId('today-schedule')).getByRole('checkbox', {
        name: 'First task, completed',
      }),
    ).toBeDefined();
    expect(screen.getByTestId('completion-transition-row')).toBeDefined();
    expect(screen.queryByTestId('today-earlier')).toBeNull();

    await waitFor(
      () => expect(screen.queryByTestId('completion-transition-row')).toBeNull(),
      { timeout: 1_000 },
    );
    expect(
      within(screen.getByTestId('today-earlier')).getByRole('checkbox', {
        name: 'First task, completed',
      }),
    ).toBeDefined();
    expect(screen.getAllByText('Second task')).toHaveLength(2);
  });

  it('removes the completion hold when Reduce Motion is enabled', async () => {
    const reduceMotion = vi
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(true);
    stubFetch(response([row(1, { title: 'Quiet transition', time: '15:30' })]));
    const client = createClient();
    const onToggleComplete = vi.fn((changed: AgendaItem, checked: boolean) => {
      client.setQueriesData({ queryKey: ['agenda'] }, (cached: unknown) => {
        const data = cached as { days?: Array<{ schedule?: AgendaItem[] }> } | undefined;
        if (data?.days?.[0]?.schedule === undefined) return cached;
        return {
          ...data,
          days: data.days.map((day) => ({
            ...day,
            schedule: day.schedule?.map((item) =>
              item.activityId === changed.activityId
                ? { ...item, status: checked ? 'completed' : 'scheduled' }
                : item,
            ),
          })),
        };
      });
    });
    mount(
      <TodayScreen
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
        onToggleComplete={onToggleComplete}
      />,
      client,
    );

    await waitFor(() => expect(reduceMotion).toHaveBeenCalled());
    fireEvent.click(
      screen.getAllByRole('checkbox', {
        name: 'Quiet transition, not completed',
      })[0] as Element,
    );

    expect(onToggleComplete).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('completion-transition-row')).toBeNull();
    expect(
      within(screen.getByTestId('today-earlier')).getByRole('checkbox', {
        name: 'Quiet transition, completed',
      }),
    ).toBeDefined();
  });

  it('opens the snooze sheet from the shared timed-row action', async () => {
    stubFetch(response([row(1, { title: 'Call the dentist', time: '15:30' })]));
    mount(<TodayScreen onOpenAnytime={() => {}} onOpenAgendaItem={() => {}} />);

    await waitFor(() => expect(screen.getAllByText('Call the dentist')).toHaveLength(2));
    fireEvent.pointerEnter(screen.getAllByTestId(/^swipeable-row-/)[0] as Element);
    fireEvent.click(
      screen.getAllByRole('button', {
        name: 'More actions for Call the dentist',
      })[0] as Element,
    );
    fireEvent.click(screen.getAllByRole('menuitem', { name: 'Snooze' })[0] as Element);

    expect(screen.getByRole('heading', { name: 'Snooze' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Snooze until 3:25 PM' })).toBeDefined();
  });
});
