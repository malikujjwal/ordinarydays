import { fixedClock, type Instant, type WallTime } from '@od/shared/time';
import type { Activity, AgendaItem } from '@od/shared/types';
import { colors, ThemeProvider } from '@od/ui';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '@/hooks/useClock';
import type { AgendaRowIntentState } from '@/hooks/usePendingIntents';
import { TodayScreen } from './TodayScreen';
import { UpNextCardWithState } from './UpNextCard';

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

/**
 * `tomorrowItems` populates `days[1]`, which is what the two-day window Today now requests
 * returns (P2-45). Omitting it leaves the response one day long, exactly as before, so every
 * test written against the old shape still describes the same screen.
 */
function response(
  items: AgendaItem[],
  upNext?: AgendaItem,
  tomorrowItems: AgendaItem[] = [],
) {
  const day = (date: string, rows: AgendaItem[]) => ({
    date,
    schedule: rows.filter((item) => item.time !== undefined),
    anytime: rows.filter((item) => item.time === undefined),
    earlier: [],
  });
  return {
    data: {
      days: [
        {
          ...day('2026-08-06', items),
          ...(upNext === undefined ? {} : { upNext }),
        },
        ...(tomorrowItems.length === 0 ? [] : [day('2026-08-07', tomorrowItems)]),
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
  onlineManager.setOnline(true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await AsyncStorage.clear();
});

/**
 * EARLIER TODAY is collapsed by default (founder, 2026-08-17), so a test that asserts anything
 * about its rows opens it first. Kept as a helper rather than repeated so the default can change
 * again in one place.
 */
async function openEarlier() {
  const toggle = await screen.findByTestId('today-earlier-toggle');
  fireEvent.click(toggle);
}

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

  it('shows Done? when a recurring plan crosses into Earlier today locally', async () => {
    stubFetch(
      response([
        row(1, {
          title: 'Recurring plan',
          type: 'custom',
          occurrenceDate: '2026-08-06',
          isRecurring: true,
          hasCheckbox: false,
          time: '15:00',
          isPast: false,
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

    await openEarlier();

    expect(
      screen.getByRole('button', {
        name: 'Done? Choose an outcome for Recurring plan',
      }),
    ).toBeDefined();
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
    expect(screen.getByTestId('up-next-eyebrow').style.color).toBe(
      cssColor(colors.light.textAction),
    );
    const meta = within(screen.getByTestId('up-next-card')).getByTestId('up-next-meta');
    expect(meta.textContent).toBe('Morning routine');
    expect(meta.style.color).toBe(cssColor(colors.light.textPrimary));
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
    /**
     * **Earlier today renders second, above Schedule** — founder decision, 2026-08-17, which
     * also settled where the NOW divider goes. `today-and-tasks.md` §2 is amended to this order
     * in the same pull request; P2-44's "the P2-19 section-order test passes unmodified" could
     * not survive a deliberate reorder and is superseded rather than worked around.
     *
     * The UP NEXT card's eyebrow is no longer a `SectionHeader`, so it is not a heading here.
     */
    const headings = screen.getAllByRole('heading').map((heading) => heading.textContent);
    expect(headings).toEqual(['Today', 'Earlier today', 'Schedule', 'Anytime']);
    expect(screen.getByRole('heading', { name: 'Schedule' }).style.fontSize).toBe('12px');
    expect(screen.getByRole('heading', { name: /^Anytime/ }).style.fontSize).toBe('12px');

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

  /**
   * P3-49 — Today consumes `RowLeading` too, so the per-type markers land here as well as
   * on Plans. One row per kind: the task keeps its checkbox (the only mutating tap on a row),
   * the four Plan kinds each draw their own §5.2 glyph, and `custom` is the only diamond.
   */
  it('renders each Plan kind with its own type marker and keeps the task checkbox', async () => {
    stubFetch(
      response([
        row(1, { title: 'Renew passport', time: '19:00' }),
        row(2, {
          title: 'Chicken tacos',
          time: '19:30',
          type: 'meal',
          hasCheckbox: false,
        }),
        row(3, {
          title: 'Severance finale',
          time: '20:00',
          type: 'watch',
          hasCheckbox: false,
        }),
        row(4, {
          title: 'New York Trip',
          time: '20:30',
          type: 'event',
          hasCheckbox: false,
        }),
        row(5, {
          title: 'Standup with Priya',
          time: '21:00',
          type: 'custom',
          hasCheckbox: false,
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

    await waitFor(() => expect(screen.getByTestId('today-agenda')).toBeDefined());
    const glyphs = screen
      .getAllByTestId(/^agenda-leading-marker-/)
      .map((node) => node.getAttribute('data-testid'))
      .sort();
    expect(glyphs).toEqual([
      'agenda-leading-marker-bowl',
      'agenda-leading-marker-diamond',
      'agenda-leading-marker-map-pin',
      'agenda-leading-marker-play-rect',
    ]);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(
      screen.getByRole('checkbox', { name: 'Renew passport, not completed' }),
    ).toBeDefined();
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

    await screen.findByTestId('today-earlier');
    await openEarlier();
    expect(
      within(screen.getByTestId('today-earlier')).getByText('Skipped standup'),
    ).toBeDefined();
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

    await screen.findByTestId('today-earlier');
    await openEarlier();
    expect(
      within(screen.getByTestId('today-earlier')).getByText('Skipped standup'),
    ).toBeDefined();
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
    expect(screen.getByRole('heading', { name: /^Anytime/ })).toBeDefined();
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
    expect(screen.getByRole('heading', { name: /^Anytime/ })).toBeDefined();
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

    /**
     * Above four rows the section starts **collapsed**, because it now sits between the user and
     * the part of the day they can still act on. The header states the count and opens it; the
     * 10-row cap and `Show all` then apply inside as before.
     */
    expect(screen.queryAllByTestId(/^agenda-row-act_/)).toHaveLength(0);
    fireEvent.click(screen.getByTestId('today-earlier-toggle'));
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

  it('moves a completed overdue row into Earlier today and advances Today progress', async () => {
    vi.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const overdue = row(1, {
      title: 'Old paperwork',
      overdueFromDate: '2026-08-04',
    });
    stubFetch(response([overdue]));
    const client = createClient();
    const onToggleComplete = vi.fn((changed: AgendaItem) => {
      client.setQueriesData({ queryKey: ['agenda'] }, (cached: unknown) => {
        const data = cached as
          | { days?: Array<{ anytime?: AgendaItem[]; earlier?: AgendaItem[] }> }
          | undefined;
        if (data?.days?.[0]?.anytime === undefined) return cached;
        return {
          ...data,
          days: data.days.map((day) => ({
            ...day,
            anytime: day.anytime?.filter(
              (item) => item.activityId !== changed.activityId,
            ),
            earlier: [...(day.earlier ?? []), { ...changed, status: 'completed' }],
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

    await waitFor(() =>
      expect(screen.getByTestId('today-day-count').textContent).toBe('1 of 1 done'),
    );
    expect(screen.queryByTestId('today-anytime')).toBeNull();
    expect(screen.getByTestId('today-earlier')).toBeDefined();
    expect(screen.getByTestId('today-earlier-toggle').textContent).toContain('1 done');
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
    await openEarlier();
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

  /**
   * **A timed row keeps its slot** — founder, 2026-08-17. It used to hold, fade and reappear in
   * EARLIER TODAY; with that section now *above* SCHEDULE the relocation threw the row backwards
   * across the NOW divider. It stays where it is, struck and checked, and joins EARLIER TODAY
   * when the clock reaches it. P2-24's hold-and-fade still runs for an ANYTIME row, which has no
   * slot to keep — covered by the test below it.
   */
  it('strikes a completed timed row in place and leaves it in Schedule', async () => {
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

    /*
     * One checkbox, in the schedule row alone: the planner-frame card (2026-08-31) carries
     * no checkbox — its `Complete` text action is the completion path there.
     */
    await waitFor(() =>
      expect(
        screen.getAllByRole('checkbox', { name: 'First task, not completed' }),
      ).toHaveLength(1),
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
    /**
     * `waitFor`, because the completed state now arrives through the query cache rather than
     * through the transition row's own optimistic copy — there is no transition row any more.
     */
    await waitFor(() =>
      expect(
        within(screen.getByTestId('today-schedule')).getByRole('checkbox', {
          name: 'First task, completed',
        }),
      ).toBeDefined(),
    );
    // Nothing travels, so nothing fades, and the row does not appear behind the NOW divider.
    expect(screen.queryByTestId('completion-transition-row')).toBeNull();
    expect(screen.queryByTestId('today-earlier')).toBeNull();
  });

  /**
   * The other half of the founder's rule: an ANYTIME row has no slot to keep, so completing it
   * still moves it to EARLIER TODAY on the spot (`today-and-tasks.md` §2.3). The hold-and-fade
   * that covers that move is P2-24's and is asserted by the Reduce Motion test below, which
   * pins its removal; what matters here is the destination.
   */
  it('moves a completed untimed row to Earlier today', async () => {
    const reduceMotion = vi
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(false);
    stubFetch(response([row(1, { title: 'Loose end' })]));
    const client = createClient();
    const onToggleComplete = vi.fn((changed: AgendaItem, checked: boolean) => {
      client.setQueriesData({ queryKey: ['agenda'] }, (cached: unknown) => {
        const data = cached as { days?: Array<{ anytime?: AgendaItem[] }> } | undefined;
        if (data?.days?.[0]?.anytime === undefined) return cached;
        return {
          ...data,
          days: data.days.map((day) => ({
            ...day,
            anytime: day.anytime?.map((item) =>
              item.activityId === changed.activityId
                ? { ...item, status: checked ? 'completed' : 'saved' }
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

    // The hold only exists once `useMotion` has resolved the system setting.
    await waitFor(() => expect(reduceMotion).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'Loose end, not completed' })),
    );
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Loose end, not completed' }) as Element,
    );

    /**
     * Read through the section's own header rather than by expanding it. EARLIER TODAY is
     * collapsed by default, and what this test is about is where the row **went** — the header
     * states the count, so the move is observable without driving a disclosure.
     */
    const earlier = await screen.findByTestId('today-earlier', undefined, {
      timeout: 2_000,
    });
    await waitFor(
      () =>
        expect(within(earlier).getByTestId('today-earlier-toggle').textContent).toContain(
          '1 done',
        ),
      { timeout: 2_000 },
    );
    // And it is gone from Anytime, which is what "no slot to keep" means.
    expect(screen.queryByTestId('today-anytime')).toBeNull();
  });

  it('removes the completion hold when Reduce Motion is enabled', async () => {
    const reduceMotion = vi
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(true);
    // Untimed: the only row that still relocates, and so the only one with a hold to remove.
    stubFetch(response([row(1, { title: 'Quiet transition' })]));
    const client = createClient();
    const onToggleComplete = vi.fn((changed: AgendaItem, checked: boolean) => {
      client.setQueriesData({ queryKey: ['agenda'] }, (cached: unknown) => {
        const data = cached as { days?: Array<{ anytime?: AgendaItem[] }> } | undefined;
        if (data?.days?.[0]?.anytime === undefined) return cached;
        return {
          ...data,
          days: data.days.map((day) => ({
            ...day,
            anytime: day.anytime?.map((item) =>
              item.activityId === changed.activityId
                ? { ...item, status: checked ? 'completed' : 'saved' }
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
    const checkboxes = await screen.findAllByRole('checkbox', {
      name: 'Quiet transition, not completed',
    });
    fireEvent.click(checkboxes[0] as Element);

    expect(onToggleComplete).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('completion-transition-row')).toBeNull();
    await screen.findByTestId('today-earlier');
    await openEarlier();
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
    /**
     * 3:45, not 3:25. The clock is 3:10 and the task is at 3:30, so `15 minutes` counts from the
     * task — snoozing it to 3:25 would have moved it *earlier* than it was already due, which is
     * the defect this assertion used to pin in place.
     */
    expect(screen.getByRole('button', { name: 'Snooze until 3:45 PM' })).toBeDefined();
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

/**
 * The day header and the timeline furniture §7.1 specifies (P2-44).
 *
 * The clock is fixed at `2026-08-06T15:10:00Z`, so the caption is a fact rather than a
 * tautology — a test that formatted the date the same way the component does would pass
 * whatever either of them did.
 */
describe('TodayScreen day header', () => {
  const openToday = async (items: AgendaItem[]) => {
    stubFetch(response(items));
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('today-agenda')).toBeDefined());
  };

  it('dates the day above the title, in the user zone', async () => {
    await openToday([row(1, { title: 'Later', time: '18:00' })]);
    expect(screen.getByTestId('today-screen-caption').textContent).toBe(
      'Thursday, August 6',
    );
  });

  it('puts compact offline status between Today and the fixed completion count', async () => {
    onlineManager.setOnline(false);
    await openToday([row(1, { title: 'Later', time: '18:00' })]);

    const title = screen.getByRole('heading', { name: 'Today' });
    const status = screen.getByTestId('connectivity-status');
    const slot = screen.getByTestId('today-screen-title-accessory-slot');
    const count = screen.getByTestId('today-day-count');
    expect(status.textContent).toBe('Offline');
    expect(slot.style.flexGrow).toBe('1');
    expect(title.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(status.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  /** §7.1: information, not celebration — the bar is present and empty, never hidden. */
  it('renders an empty bar at 0 of n rather than hiding it', async () => {
    await openToday([
      row(1, { title: 'Later', time: '18:00' }),
      row(2, { title: 'Any task' }),
    ]);

    expect(screen.getByTestId('today-day-count').textContent).toBe('0 of 2 done');
    const bar = screen.getByTestId('today-progress');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.getAttribute('aria-label')).toBe('0 of 2 done');
  });

  it('moves the figure as the day is completed', async () => {
    await openToday([
      row(1, { title: 'Done one', time: '09:00', isPast: true, status: 'completed' }),
      row(2, { title: 'Later', time: '18:00' }),
    ]);

    expect(screen.getByTestId('today-day-count').textContent).toBe('1 of 2 done');
    expect(screen.getByTestId('today-progress').getAttribute('aria-valuenow')).toBe('50');
  });

  /** One number, rendered twice in one block — never a second progress figure (scope guard). */
  it('states the figure once in words and once as the bar, and nowhere else', async () => {
    await openToday([row(1, { title: 'Later', time: '18:00' })]);
    expect(screen.getAllByText('0 of 1 done')).toHaveLength(1);
    expect(screen.getAllByTestId('today-progress')).toHaveLength(1);
  });
});

/**
 * The marker connector (§7.1: "it is what makes the day read as a timeline") and the UP NEXT
 * quick actions (P2-44).
 */
/**
 * P2-45's look-ahead. Every assertion here is about what the preview **is not**: it is not a
 * second Today, it does not feed any figure Today states, and it does not exist on a quiet day.
 */
describe('Today rows carry no rule', () => {
  /**
   * The timeline already has a separator — the connector hairline between markers — and a
   * horizontal rule under every row cut across it (founder, 2026-08-17). §7.1 says the same:
   * "separator is the connector line, not a horizontal rule".
   */
  it('renders every section row without a bottom border', async () => {
    stubFetch(
      response([
        row(1, { title: 'Timed', time: '18:00' }),
        row(2, { title: 'Untimed' }),
        row(3, { title: 'Passed', time: '06:00', isPast: true }),
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
    await waitFor(() => expect(screen.getByTestId('today-agenda')).toBeDefined());
    for (const node of screen.getAllByTestId(/^agenda-row-act_/)) {
      expect(node.style.borderBottomWidth).toBe('0px');
    }
  });
});

describe('the Tomorrow preview', () => {
  it('is absent when tomorrow holds nothing', async () => {
    stubFetch(response([row(1, { title: 'Only today', time: '18:00' })]));
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('today-agenda')).toBeDefined());
    expect(screen.queryByTestId('today-tomorrow')).toBeNull();
  });

  it('renders tomorrow’s rows as time and title, with nothing to press', async () => {
    stubFetch(
      response([row(1, { title: 'Today thing', time: '18:00' })], undefined, [
        row(2, { title: 'Tomorrow thing', time: '09:00' }),
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

    const preview = within(await screen.findByTestId('today-tomorrow'));
    expect(preview.getByText('Tomorrow thing').style.fontWeight).toBe('400');
    expect(preview.getByRole('heading', { name: /^Tomorrow/ }).style.fontSize).toBe(
      '12px',
    );
    expect(preview.getByText('9:00 AM')).toBeDefined();
    /**
     * **Nothing in it is interactive** (founder, 2026-08-17: "no click and open task is required
     * on it"). Not a disabled control anywhere — no control at all, which is why this asserts
     * across every interactive role rather than on one testID.
     */
    expect(preview.queryAllByRole('checkbox')).toHaveLength(0);
    expect(preview.queryAllByRole('button')).toHaveLength(0);
    expect(preview.queryAllByRole('link')).toHaveLength(0);
  });

  it('labels an untimed row Anytime rather than leaving its column blank', async () => {
    stubFetch(
      response([row(1, { title: 'Today thing', time: '18:00' })], undefined, [
        row(2, { title: 'Dry cleaning' }),
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

    const preview = within(await screen.findByTestId('today-tomorrow'));
    expect(preview.getByText('Anytime')).toBeDefined();
    expect(preview.getByText('Dry cleaning')).toBeDefined();
  });

  /** Undated tasks are pinned to `days[0]` by the server, so they can only render once. */
  it('leaves an undated task in Anytime and out of the preview', async () => {
    stubFetch(
      response([row(1, { title: 'Loose end' })], undefined, [
        row(2, { title: 'Tomorrow thing', time: '09:00' }),
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

    await screen.findByTestId('today-tomorrow');
    expect(screen.getAllByText('Loose end')).toHaveLength(1);
    expect(
      within(screen.getByTestId('today-anytime')).getByText('Loose end'),
    ).toBeDefined();
  });

  it('changes no figure Today states', async () => {
    stubFetch(
      response([row(1, { title: 'Today thing', time: '18:00' })], undefined, [
        row(2, { title: 'Tomorrow one', time: '09:00' }),
        row(3, { title: 'Tomorrow two', time: '10:00' }),
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

    await screen.findByTestId('today-tomorrow');
    // One item today, none done — tomorrow's two are counted nowhere.
    expect(screen.getByTestId('today-day-count').textContent).toBe('0 of 1 done');
  });

  /** P2-20's rule must not start reaching into tomorrow to find a candidate. */
  it('leaves UP NEXT absent when today’s timed items are all past', async () => {
    stubFetch(
      response([row(1, { title: 'Long gone', time: '06:00', isPast: true })], undefined, [
        row(2, { title: 'Tomorrow thing', time: '09:00' }),
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

    await screen.findByTestId('today-tomorrow');
    expect(screen.queryByTestId('today-up-next')).toBeNull();
  });
});

describe('TodayScreen timeline furniture', () => {
  const openToday = async (items: AgendaItem[], upNext?: AgendaItem) => {
    stubFetch(response(items, upNext));
    mount(
      <TodayScreen
        onAdd={() => {}}
        onAddTask={() => {}}
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
        onAgendaAction={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('today-agenda')).toBeDefined());
  };

  it('runs the connector between markers and stops at a section end', async () => {
    await openToday([
      row(1, { title: 'First', time: '17:00' }),
      row(2, { title: 'Middle', time: '18:00' }),
      row(3, { title: 'Last', time: '19:00' }),
    ]);

    const schedule = within(screen.getByTestId('today-schedule'));
    /**
     * **Two halves with a halo round each marker.** Drawing only the lower half left a few
     * pixels of line on a 60 pt row and broke the thread between rows entirely; both halves are
     * back, each stopping clear of the glyph. Three rows: no `above` on the first, no `below` on
     * the last, so two of each.
     */
    expect(schedule.queryAllByTestId('agenda-row-connector-above')).toHaveLength(2);
    expect(schedule.queryAllByTestId('agenda-row-connector-below')).toHaveLength(2);
    expect(
      Number.parseFloat(
        schedule.getAllByTestId('agenda-row-connector-above')[0]?.style.height ?? '0',
      ),
    ).toBeGreaterThanOrEqual(10);
    expect(
      Number.parseFloat(
        schedule.getAllByTestId('agenda-row-connector-below')[0]?.style.top ?? '99',
      ),
    ).toBeLessThan(40);
  });

  it('draws no connector on a lone row', async () => {
    await openToday([row(1, { title: 'Only', time: '18:00' })]);
    const schedule = within(screen.getByTestId('today-schedule'));
    expect(schedule.queryAllByTestId('agenda-row-connector-above')).toHaveLength(0);
    expect(schedule.queryAllByTestId('agenda-row-connector-below')).toHaveLength(0);
  });

  it('hides the connector from the accessibility tree', async () => {
    await openToday([
      row(1, { title: 'First', time: '17:00' }),
      row(2, { title: 'Second', time: '18:00' }),
    ]);
    const connector = within(screen.getByTestId('today-schedule')).getAllByTestId(
      'agenda-row-connector-below',
    )[0] as HTMLElement;
    expect(connector.getAttribute('aria-hidden')).toBe('true');
  });

  /**
   * The card reads its actions from the same function the row does, so it can never offer one
   * the row does not — asserted by comparing the rendered labels against the row's own
   * accessibility actions rather than against a hard-coded list.
   */
  it('offers the row own quick actions on the card, with the row labels', async () => {
    const timed = row(1, { title: 'Groceries', time: '17:30' });
    await openToday([timed], timed);

    const card = within(screen.getByTestId('today-up-next'));
    const actions = card.getByTestId('up-next-quick-actions');
    const labels = Array.from(actions.querySelectorAll('[role="button"]')).map((node) =>
      node.getAttribute('aria-label'),
    );

    // Founder, 2026-08-17: the card carries the two that matter, filtered from the row's own.
    expect(labels).toEqual(['Complete', 'Snooze']);

    /**
     * The backdrop carries the card's accessible name since the planner frame removed the
     * embedded row; the two actions stay separately focusable beside it.
     */
    const body = card.getByTestId('up-next-backdrop');
    expect(body.getAttribute('aria-label')).toContain('Groceries');
    expect(actions.getAttribute('aria-hidden')).toBeNull();
  });

  it('uses one compact detail line and the serif planner title in Up Next', async () => {
    const timed = row(1, {
      title: 'Dentist appointment',
      time: '17:30',
      locationLabel: 'Jefferson Dental Center',
      noteExcerpt: 'Bring insurance card',
      subtitle: 'Annual checkup',
    });
    await openToday([timed], timed);

    expect(screen.getByTestId('up-next-meta').textContent).toBe(
      'Jefferson Dental Center · Bring insurance card · Annual checkup',
    );
    expect(screen.getByTestId('up-next-title').style.fontSize).toBe('24px');
  });

  it('keeps Up Next inspectable while recurrence topology blocks mutations', () => {
    const timed = row(1, {
      title: 'Recurring groceries',
      time: '17:30',
      occurrenceDate: '2026-08-06',
      isRecurring: true,
    });
    const onOpen = vi.fn();
    const onAction = vi.fn();
    const intentState: AgendaRowIntentState = {
      pendingCreate: {
        pending: false,
        canCancel: false,
        intentId: undefined,
        status: undefined,
      },
      recurrenceEdit: {
        inert: true,
        message: 'Updating schedule…',
        status: 'updating',
      },
      mutationInert: true,
      failedCompletionIntentIds: [],
    };

    mount(
      <UpNextCardWithState
        selection={{
          item: timed,
          time: '17:30' as WallTime,
          relativeTime: 'in 2 hours',
        }}
        intentState={intentState}
        completion={{ locked: false, checkedOverride: undefined }}
        onOpen={onOpen}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByTestId('up-next-backdrop'));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(timed);
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId('up-next-quick-actions')).toBeNull();
    expect(screen.getByTestId('up-next-recurrence-state').textContent).toBe(
      'Updating schedule…',
    );
  });

  it('locks every Up Next quick action while completion commits', () => {
    const timed = row(1, { title: 'Groceries', time: '17:30' });
    const onAction = vi.fn();
    const intentState: AgendaRowIntentState = {
      pendingCreate: {
        pending: false,
        canCancel: false,
        intentId: undefined,
        status: undefined,
      },
      recurrenceEdit: { inert: false, message: undefined, status: 'idle' },
      mutationInert: false,
      failedCompletionIntentIds: [],
    };

    mount(
      <UpNextCardWithState
        selection={{
          item: timed,
          time: '17:30' as WallTime,
          relativeTime: 'in 2 hours',
        }}
        intentState={intentState}
        completion={{ locked: true, checkedOverride: true }}
        onOpen={() => {}}
        onAction={onAction}
      />,
    );

    const actions = within(screen.getByTestId('up-next-quick-actions'));
    const complete = actions.getByRole('button', { name: 'Complete' });
    const snooze = actions.getByRole('button', { name: 'Snooze' });
    expect(complete.hasAttribute('disabled')).toBe(true);
    expect(snooze.hasAttribute('disabled')).toBe(true);

    fireEvent.click(complete);
    fireEvent.click(snooze);
    expect(onAction).not.toHaveBeenCalled();
  });
});
