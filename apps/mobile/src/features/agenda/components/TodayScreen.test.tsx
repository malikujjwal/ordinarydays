import type { AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TodayScreen } from './TodayScreen';

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

function response(items: AgendaItem[]) {
  return {
    data: {
      days: [
        {
          date: '2026-08-06',
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

function mount(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, networkMode: 'always' } },
  });
  return render(
    <SafeAreaProvider>
      <ThemeProvider scheme="light">
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('TodayScreen', () => {
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
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
        currentMinute="15:10"
        now={new Date('2026-08-06T15:10:00Z')}
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
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
        currentMinute="15:10"
        now={new Date('2026-08-07T15:10:00Z')}
      />,
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
    mount(
      <TodayScreen
        onOpenAnytime={onOpenAnytime}
        onOpenAgendaItem={() => {}}
        currentMinute="15:10"
        now={new Date('2026-08-06T15:10:00Z')}
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
        onOpenAnytime={() => {}}
        onOpenAgendaItem={() => {}}
        currentMinute="15:10"
        now={new Date('2026-08-06T15:10:00Z')}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('today-earlier')).toBeDefined());
    expect(screen.getAllByTestId(/^agenda-row-act_/)).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getAllByTestId(/^agenda-row-act_/)).toHaveLength(12);
  });
});
