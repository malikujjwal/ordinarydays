import { fixedClock, type Instant } from '@od/shared/time';
import type { Activity, AgendaItem } from '@od/shared/types';
import { colors, ThemeProvider } from '@od/ui';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

const cssColor = (hex: string): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
};

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

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function recurringActivity(activityId: string): Activity {
  return {
    activityId,
    ownerId: 'usr_01J0000000000000000000000B',
    objectKind: 'task',
    type: 'task',
    status: 'scheduled',
    title: 'Recurring standup',
    schedule: { date: '2026-08-01', time: '15:30', timezone: 'UTC' },
    recurrence: {
      mode: 'fixed',
      segments: [{ freq: 'daily', effectiveFrom: '2026-08-01', time: '15:30' }],
    },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'task' },
    icsSequence: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActivityAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    schemaVersion: 1,
  };
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

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await AsyncStorage.clear();
});

describe('TodayScreen', () => {
  it('cold-renders from one Today agenda request and never requests reminders', async () => {
    const transport = vi.fn((_url: string) => Promise.resolve(okResponse(response([]))));
    vi.stubGlobal('fetch', transport);

    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('today-empty')).toBeDefined());
    expect(transport).toHaveBeenCalledOnce();
    expect(String(transport.mock.calls[0]?.[0])).toContain(
      'include=anytime_unscheduled%2Coverdue',
    );
    expect(String(transport.mock.calls[0]?.[0])).not.toContain('reminders');
  });

  it('uses the server UP NEXT row for the initial paint', async () => {
    const serverUpNext = row(1, {
      title: 'Server snapshot',
      subtitle: 'Morning routine',
      time: '15:00',
    });
    stubFetch(
      response(
        [serverUpNext, row(2, { title: 'Local next', time: '15:30' })],
        serverUpNext,
      ),
    );
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('up-next-card')).toBeDefined());
    expect(
      within(screen.getByTestId('up-next-card')).getByText('Server snapshot'),
    ).toBeDefined();
    expect(screen.getByTestId('up-next-relative').style.color).toBe(
      cssColor(colors.light.textAction),
    );
    expect(
      within(screen.getByTestId('up-next-card')).getByTestId('agenda-row-subtitle').style
        .color,
    ).toBe(cssColor(colors.light.textPrimary));
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
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
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
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByText('Only anytime')).toBeDefined());
    expect(screen.queryByRole('heading', { name: 'Schedule' })).toBeNull();
    second.unmount();
  });

  it('shows the fully empty Today state with one global Add action', async () => {
    const onAdd = vi.fn();
    stubFetch(response([]));
    mount(
      <TodayScreen
        onAdd={onAdd}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('today-empty')).toBeDefined());
    expect(screen.getByText('Nothing planned today')).toBeDefined();
    expect(
      screen.getByText('Add something you want to do, or check your Lists.'),
    ).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Schedule' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Anytime' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Earlier today' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open Lists' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add something' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it('reveals skipped occurrences from More and restores the device-local choice', async () => {
    const skipped = row(1, {
      title: 'Skipped standup',
      status: 'skipped_occurrence',
      occurrenceDate: '2026-08-06',
      time: '20:00',
    });
    const transport = vi.fn(() => Promise.resolve(okResponse(response([skipped]))));
    vi.stubGlobal('fetch', transport);
    const first = mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('today-empty')).toBeDefined());
    expect(screen.queryByText('Skipped standup')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const toggle = screen.getByRole('checkbox', { name: 'Show skipped' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(
        within(screen.getByTestId('today-earlier')).getByText('Skipped standup'),
      ).toBeDefined(),
    );
    expect(
      screen.getByRole('checkbox', { name: 'Show skipped' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(await AsyncStorage.getItem('ordinarydays-today-show-skipped-v1')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.pointerEnter(screen.getByTestId(/^swipeable-row-/));
    expect(screen.getByRole('button', { name: 'Undo skip' })).toBeDefined();
    expect(transport).toHaveBeenCalledOnce();

    first.unmount();
    stubFetch(response([skipped]));
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        within(screen.getByTestId('today-earlier')).getByText('Skipped standup'),
      ).toBeDefined(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(
      screen.getByRole('checkbox', { name: 'Show skipped' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('keeps Show skipped off when device preference storage is unavailable', async () => {
    vi.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('storage offline'));
    stubFetch(
      response([
        row(1, {
          title: 'Hidden skipped row',
          status: 'skipped_occurrence',
          occurrenceDate: '2026-08-06',
        }),
      ]),
    );
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('today-empty')).toBeDefined());
    expect(screen.queryByText('Hidden skipped row')).toBeNull();
  });

  it('keeps the contextual Add a task action at the list foot and supplies today', async () => {
    const onAddTask = vi.fn();
    stubFetch(response([row(1, { title: 'Scheduled plan', time: '18:00' })]));
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={onAddTask}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('button', { name: '+ Add a task' })).toBeDefined(),
    );
    expect(screen.queryByRole('heading', { name: 'Anytime' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '+ Add a task' }));

    expect(onAddTask).toHaveBeenCalledExactlyOnceWith('2026-08-06');
  });

  it('notes an otherwise empty day above undated tasks', async () => {
    stubFetch(response([row(1, { title: 'File the form', status: 'saved' })]));
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId('today-unscheduled-note')).toBeDefined(),
    );
    expect(screen.getByText('Nothing scheduled today.')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Anytime' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Schedule' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Earlier today' })).toBeNull();
  });

  it('renders the empty Schedule row when Anytime and Earlier today remain', async () => {
    stubFetch(
      response([
        row(1, { title: 'File the form', status: 'saved' }),
        row(2, { title: 'Morning call', time: '10:00', isPast: true }),
      ]),
    );
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('today-schedule')).toBeDefined());
    expect(screen.getByRole('heading', { name: 'Schedule' })).toBeDefined();
    expect(screen.getByText('Nothing left scheduled today.')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Anytime' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Earlier today' })).toBeDefined();
    expect(screen.queryByText('Nothing scheduled today.')).toBeNull();
  });

  it('shows the all-completed note above Earlier today', async () => {
    stubFetch(
      response([
        row(1, {
          title: 'Finished task',
          status: 'completed',
          time: '10:00',
          isPast: true,
        }),
      ]),
    );
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('today-all-done-note')).toBeDefined());
    expect(screen.getByText('All done for today.')).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Earlier today' })).toBeDefined();
    expect(screen.queryByRole('heading', { name: 'Schedule' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Anytime' })).toBeNull();
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
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={onOpenAnytime}
        onOpenAgendaItem={() => {}}
      />,
    );

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
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('today-earlier')).toBeDefined());
    expect(screen.getAllByTestId(/^agenda-row-act_/)).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getAllByTestId(/^agenda-row-act_/)).toHaveLength(12);
  });

  it('collapses six overdue rows to three and expands in place without I/O or navigation', async () => {
    const onOpenAgendaItem = vi.fn();
    const overdue = Array.from({ length: 6 }, (_, index) =>
      row(index, {
        title: `Overdue ${index + 1}`,
        overdueFromDate: `2026-${index < 1 ? '07-31' : `08-0${index}`}`,
      }),
    );
    const transport = vi.fn(() => Promise.resolve(okResponse(response(overdue))));
    vi.stubGlobal('fetch', transport);
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={onOpenAgendaItem}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('today-anytime')).toBeDefined());
    expect(screen.getAllByTestId(/^agenda-row-act_/)).toHaveLength(3);
    expect(screen.getByText('+3 more overdue')).toBeDefined();
    const collapse = screen.getByRole('button', { name: '3 more overdue' });
    expect(collapse.getAttribute('aria-expanded')).toBe('false');
    const transportCalls = transport.mock.calls.length;

    fireEvent.click(collapse);

    expect(screen.getAllByTestId(/^agenda-row-act_/)).toHaveLength(6);
    expect(onOpenAgendaItem).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(transportCalls);
    expect(
      screen
        .getByRole('button', { name: '3 more overdue' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('opens an overdue chip in the shared reschedule sheet pre-set to today', async () => {
    const overdue = row(1, {
      title: 'File the return',
      overdueFromDate: '2026-08-04',
    });
    const { recurrence: _recurrence, ...activity } = recurringActivity(
      overdue.activityId,
    );
    const agendaBody = response([overdue]);
    const detailBody = {
      data: {
        activity: {
          ...activity,
          title: overdue.title,
          schedule: { date: '2026-08-04', timezone: 'UTC' },
        },
        capabilities: { complete: true, skip: false, snooze: true },
        reminders: [],
      },
      meta: { requestId: 'req_overdue_detail' },
    };
    vi.stubGlobal('fetch', (input: RequestInfo | URL) =>
      Promise.resolve(
        okResponse(String(input).includes('/agenda') ? agendaBody : detailBody),
      ),
    );
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Overdue from Tuesday 4 August' }),
      ).toBeDefined(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Overdue from Tuesday 4 August' }),
    );

    await waitFor(() =>
      expect(screen.getByTestId('reschedule-occurrence-editor')).toBeDefined(),
    );
    /**
     * `aria-pressed`, not `aria-selected`: ARIA does not allow the latter on `button`, and axe
     * rejects it as critical — caught by the e2e accessibility sweep, not by this suite.
     */
    expect(screen.getByTestId('quick-date-today').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('removes a completed overdue row without projecting it into Earlier today', async () => {
    vi.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const overdue = row(1, {
      title: 'Old paperwork',
      overdueFromDate: '2026-08-04',
    });
    stubFetch(response([overdue]));
    const client = createClient();
    const onToggleComplete = vi.fn((changed: AgendaItem) => {
      client.setQueriesData({ queryKey: ['agenda'] }, (cached: unknown) => {
        const data = cached as { days?: Array<{ anytime?: AgendaItem[] }> } | undefined;
        if (data?.days?.[0]?.anytime === undefined) return cached;
        return {
          ...data,
          days: data.days.map((day) => ({
            ...day,
            anytime: day.anytime?.filter(
              (item) => item.activityId !== changed.activityId,
            ),
          })),
        };
      });
    });
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
        onToggleComplete={onToggleComplete}
      />,
      client,
    );

    await waitFor(() =>
      expect(
        screen.getByRole('checkbox', { name: 'Old paperwork, not completed' }),
      ).toBeDefined(),
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Old paperwork, not completed' }),
    );

    await waitFor(() => expect(screen.queryByText('Old paperwork')).toBeNull());
    expect(screen.queryByTestId('today-anytime')).toBeNull();
    expect(screen.queryByTestId('today-earlier')).toBeNull();
  });

  it('opens the neutral passed-item chooser and returns the exact selected outcome', async () => {
    const onResolvePassed = vi.fn();
    stubFetch(
      response([
        row(1, {
          type: 'event',
          title: 'Dentist appointment',
          hasCheckbox: false,
          time: '10:00',
          isPast: true,
        }),
      ]),
    );
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
        onResolvePassed={onResolvePassed}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('today-earlier')).toBeDefined());
    fireEvent.click(
      screen.getByRole('button', {
        name: 'How did it go? Choose an outcome for Dentist appointment',
      }),
    );
    expect(screen.getByTestId('passed-plan-resolution-sheet')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: "Didn't go" }));

    expect(onResolvePassed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: 'Dentist appointment' }),
      'didnt_go',
    );
    expect(screen.queryByTestId('passed-plan-resolution-sheet')).toBeNull();
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
        onAdd={() => {}}
        onAddTask={() => {}}
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
        onAdd={() => {}}
        onAddTask={() => {}}
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
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

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

  it('opens the shared reschedule editor when a rendered time is tapped, and asks for the scope after the edit', async () => {
    const scheduled = row(1, {
      title: 'Recurring standup',
      time: '15:30',
      occurrenceDate: '2026-08-06',
      isRecurring: true,
    });
    const agendaBody = response([scheduled]);
    const detailBody = {
      data: {
        activity: recurringActivity(scheduled.activityId),
        capabilities: { complete: true, skip: true, snooze: true },
        reminders: [],
      },
      meta: { requestId: 'req_detail' },
    };
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = String(input);
      return Promise.resolve(
        okResponse(url.includes('/agenda') ? agendaBody : detailBody),
      );
    });
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getAllByRole('button', { name: '3:30 PM, change time' }),
      ).not.toHaveLength(0),
    );
    fireEvent.click(
      screen.getAllByRole('button', { name: '3:30 PM, change time' })[0] as Element,
    );

    // P2-42: the editor is the opening state; the scope question follows the edit.
    await waitFor(() =>
      expect(screen.getByTestId('reschedule-occurrence-editor')).toBeDefined(),
    );
    expect(screen.queryByRole('button', { name: 'This occurrence only' })).toBeNull();

    fireEvent.click(screen.getByTestId('quick-date-today'));

    expect(screen.getByRole('button', { name: 'This occurrence only' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'All future occurrences' })).toBeDefined();
  });
});
