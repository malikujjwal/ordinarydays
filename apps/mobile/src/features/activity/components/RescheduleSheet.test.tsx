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
    onSkipOccurrence?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onSchedule = options.onSchedule ?? vi.fn(async () => true);
  const onPatch = options.onPatch ?? vi.fn(async () => true);
  const onSkipOccurrence = options.onSkipOccurrence ?? vi.fn(async () => true);
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
        onSkipOccurrence={onSkipOccurrence}
      />
    </ThemeProvider>,
  );
  return { onSchedule, onPatch, onSkipOccurrence, onClose };
}

describe('RescheduleSheet', () => {
  it('asks for the series scope after the edit, never as the opening state', () => {
    mount(recurring(), { occurrenceDate: TODAY });

    // The editor is what opens; the question has nothing to scope until an edit exists.
    expect(screen.getByTestId('reschedule-occurrence-editor')).toBeDefined();
    expect(screen.queryByTestId('reschedule-scope')).toBeNull();
    expect(screen.queryByRole('button', { name: 'This occurrence only' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'All future occurrences' })).toBeNull();

    fireEvent.click(screen.getByTestId('quick-date-today'));

    expect(screen.getByTestId('reschedule-scope')).toBeDefined();
    expect(screen.getByRole('button', { name: 'This occurrence only' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'All future occurrences' })).toBeDefined();
  });

  it('never asks for a scope on a one-off, which has no other occurrences', () => {
    const { onSchedule } = mount(activity());

    fireEvent.click(screen.getByTestId('quick-date-tomorrow'));

    expect(screen.queryByTestId('reschedule-scope')).toBeNull();
    expect(onSchedule).toHaveBeenCalledOnce();
  });

  it('carries the pending edit into the scope question as a before → after line', () => {
    mount(recurring(), { occurrenceDate: TODAY });

    fireEvent.click(screen.getByRole('button', { name: '9:00 AM' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '19:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.getByTestId('reschedule-scope-summary').textContent).toBe(
      '9:00 AM → 7:00 PM',
    );
  });

  it('sends a same-day occurrence reschedule through the sole schedule path', async () => {
    const { onSchedule, onPatch } = mount(recurring(), { occurrenceDate: TODAY });

    fireEvent.click(screen.getByTestId('quick-date-today'));
    fireEvent.click(screen.getByRole('button', { name: 'This occurrence only' }));

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

    fireEvent.click(screen.getByTestId('quick-date-tomorrow'));

    // A move to another day is occurrence-scoped by construction: an appended rule segment
    // carries a time, not a date, so there is no second reading of it to ask about.
    expect(screen.queryByTestId('reschedule-scope')).toBeNull();
    await waitFor(() => expect(onSchedule).toHaveBeenCalledOnce());
    expect(onSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-08-13', occurrenceDate: TODAY }),
    );
  });

  it('resolves every quick date against the injected today, on its own row', () => {
    mount(activity());

    expect(screen.getByTestId('quick-date-today').getAttribute('aria-label')).toBe(
      'Today, Wed, Aug 12',
    );
    expect(screen.getByTestId('quick-date-tomorrow').getAttribute('aria-label')).toBe(
      'Tomorrow, Thu, Aug 13',
    );
    expect(screen.getByTestId('quick-date-weekend').getAttribute('aria-label')).toBe(
      'Saturday, Sat, Aug 15',
    );
    expect(screen.getByTestId('quick-date-nextWeek').getAttribute('aria-label')).toBe(
      'Next Monday, Mon, Aug 17',
    );
  });

  it('offers a one-off task Move to Anytime', () => {
    mount(activity({ objectKind: 'task', type: 'task' }));

    expect(screen.getByTestId('reschedule-clear').getAttribute('aria-label')).toBe(
      'Move to Anytime. Keeps the task, drops the date',
    );
  });

  it('offers a plan the Needs a date wording', () => {
    mount(activity());

    expect(screen.getByTestId('reschedule-clear').getAttribute('aria-label')).toBe(
      'Remove date. Moves this plan to “Needs a date”',
    );
  });

  it('offers a recurring occurrence Skip this occurrence, and dispatches it', async () => {
    const { onSkipOccurrence, onSchedule, onClose } = mount(recurring(), {
      occurrenceDate: TODAY,
    });

    expect(screen.getByTestId('reschedule-clear').getAttribute('aria-label')).toBe(
      'Skip this occurrence. Keeps the series, drops this day',
    );

    fireEvent.click(screen.getByTestId('reschedule-clear'));

    await waitFor(() => expect(onSkipOccurrence).toHaveBeenCalledOnce());
    expect(onSchedule).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('offers no removal action on a series reached without an occurrence', () => {
    mount(recurring());

    expect(screen.queryByTestId('reschedule-clear')).toBeNull();
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

    fireEvent.click(screen.getByRole('button', { name: '9:00 AM' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'All future occurrences' }));

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

  it('replaces a segment that already starts today instead of appending a duplicate date', async () => {
    const activeToday = { ...firstSegment, effectiveFrom: TODAY };
    const { onPatch } = mount(recurring([activeToday]), { occurrenceDate: TODAY });

    fireEvent.click(screen.getByRole('button', { name: '9:00 AM' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'All future occurrences' }));

    await waitFor(() => expect(onPatch).toHaveBeenCalledOnce());
    expect(onPatch).toHaveBeenCalledWith({
      recurrence: {
        mode: 'fixed',
        segments: [{ ...activeToday, time: '10:30' }],
      },
    });
  });

  it('explains why an all-future edit cannot precede a later append-only segment', async () => {
    const { onPatch } = mount(
      recurring([
        firstSegment,
        { ...firstSegment, effectiveFrom: '2026-08-15', time: '10:00' },
      ]),
      { occurrenceDate: TODAY },
    );

    fireEvent.click(screen.getByRole('button', { name: '9:00 AM' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'All future occurrences' }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        'Future schedule changes already start on this date or later.',
      ),
    );
    expect(onPatch).not.toHaveBeenCalled();
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

    fireEvent.click(screen.getByRole('button', { name: '9:00 AM' }));
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'All future occurrences' }));

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
