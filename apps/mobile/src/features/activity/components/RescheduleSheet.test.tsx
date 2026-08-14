import type { Activity, RecurrenceSegment } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RescheduleSheet } from './RescheduleSheet';

const TODAY = '2026-08-12';

const activity = (patch: Record<string, unknown> = {}): Activity =>
  ({
    activityId: 'act_01J0000000000000000000000A',
    ownerId: 'usr_01J0000000000000000000000B',
    objectKind: 'plan',
    type: 'event',
    status: 'scheduled',
    title: 'Gym',
    schedule: {
      date: '2026-08-01',
      time: '09:00',
      timezone: 'America/New_York',
    },
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'event' },
    icsSequence: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    lastActivityAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    schemaVersion: 1,
    ...patch,
  }) as Activity;

const firstSegment: RecurrenceSegment = {
  freq: 'daily',
  effectiveFrom: '2026-08-01',
  time: '09:00',
};

const recurring = (segments: RecurrenceSegment[] = [firstSegment]): Activity =>
  activity({ recurrence: { mode: 'fixed', segments } });

function mount(
  source: Activity,
  options: {
    occurrenceDate?: string;
    onSchedule?: ReturnType<typeof vi.fn>;
    onPatch?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onSchedule = options.onSchedule ?? vi.fn(async () => true);
  const onPatch = options.onPatch ?? vi.fn(async () => true);
  const onClose = vi.fn();
  render(
    <ThemeProvider scheme="light">
      <RescheduleSheet
        open
        onClose={onClose}
        today={TODAY}
        activity={source}
        {...(options.occurrenceDate === undefined
          ? {}
          : { occurrenceDate: options.occurrenceDate })}
        onSchedule={onSchedule}
        onPatch={onPatch}
      />
    </ThemeProvider>,
  );
  return { onSchedule, onPatch, onClose };
}

describe('RescheduleSheet', () => {
  it('requires an explicit scope before rescheduling a recurring occurrence', () => {
    mount(recurring(), { occurrenceDate: TODAY });

    expect(screen.getByRole('button', { name: 'This occurrence only' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'All future occurrences' })).toBeDefined();
    expect(screen.queryByTestId('reschedule-occurrence-editor')).toBeNull();
  });

  it('sends a same-day occurrence reschedule through the sole schedule path', async () => {
    const { onSchedule, onPatch } = mount(recurring(), { occurrenceDate: TODAY });

    fireEvent.click(screen.getByRole('button', { name: 'This occurrence only' }));
    fireEvent.click(screen.getByTestId('quick-date-today'));

    await waitFor(() => expect(onSchedule).toHaveBeenCalledOnce());
    expect(onSchedule).toHaveBeenCalledWith({
      date: TODAY,
      time: '09:00',
      timezone: 'America/New_York',
      occurrenceDate: TODAY,
    });
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('sends the nominal occurrence and moved date for a cross-day choice', async () => {
    const { onSchedule } = mount(recurring(), { occurrenceDate: TODAY });

    fireEvent.click(screen.getByRole('button', { name: 'This occurrence only' }));
    fireEvent.click(screen.getByTestId('quick-date-tomorrow'));

    await waitFor(() => expect(onSchedule).toHaveBeenCalledOnce());
    expect(onSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-08-13', occurrenceDate: TODAY }),
    );
  });

  it('keeps the time wheel inside the one reschedule sheet', () => {
    mount(activity());

    fireEvent.click(screen.getByRole('button', { name: '9:00 AM' }));

    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDefined();
    expect(screen.getByLabelText('Time')).toBeDefined();
  });

  it('appends one all-future segment with editedFromDate outside recurrence', async () => {
    const { onPatch, onSchedule } = mount(recurring(), { occurrenceDate: TODAY });

    fireEvent.click(screen.getByRole('button', { name: 'All future occurrences' }));
    fireEvent.click(screen.getByRole('button', { name: '9:00 AM' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(onPatch).toHaveBeenCalledOnce());
    const sent = onPatch.mock.calls[0]?.[0];
    expect(sent.editedFromDate).toBe(TODAY);
    expect(sent.recurrence.segments).toHaveLength(2);
    expect(sent.recurrence.segments[0]).toEqual(firstSegment);
    expect(sent.recurrence.segments[1]).toEqual({
      ...firstSegment,
      effectiveFrom: TODAY,
      time: '10:30',
    });
    expect(sent.recurrence.segments[0]).toBe(firstSegment);
    expect(onSchedule).not.toHaveBeenCalled();
  });

  it('omits editedFromDate when all-future reschedule opens from series detail', async () => {
    const { onPatch } = mount(recurring());

    expect(screen.queryByTestId('reschedule-scope')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '9:00 AM' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() => expect(onPatch).toHaveBeenCalledOnce());
    expect(onPatch.mock.calls[0]?.[0]).not.toHaveProperty('editedFromDate');
  });

  it('turns a rejected 21st segment into the explanatory series-limit state', async () => {
    const segments = Array.from(
      { length: 20 },
      (_, index): RecurrenceSegment => ({
        freq: 'daily',
        effectiveFrom: `2026-07-${String(index + 1).padStart(2, '0')}`,
        time: '09:00',
      }),
    );
    const onPatch = vi.fn(async () => false);
    mount(recurring(segments), { occurrenceDate: TODAY, onPatch });

    fireEvent.click(screen.getByRole('button', { name: 'All future occurrences' }));
    fireEvent.click(screen.getByRole('button', { name: '9:00 AM' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    await waitFor(() =>
      expect(screen.getByTestId('reschedule-series-limit')).toBeDefined(),
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'End this series and start a new one',
    );
  });

  it('warns before clearing a shared plan date and names what stays', async () => {
    const { onSchedule } = mount(activity({ participantCount: 3 }));

    fireEvent.click(screen.getByTestId('reschedule-clear'));

    expect(onSchedule).not.toHaveBeenCalled();
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
    expect(
      screen.getByText(
        'This takes it off everyone’s day and moves it back to Needs a date.',
      ),
    ).toBeDefined();
    expect(
      screen.getByText('Keeps: the plan, everyone on it, and their replies.'),
    ).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Remove the date' }));
    await waitFor(() => expect(onSchedule).toHaveBeenCalledWith({ date: null }));
  });
});
