import type { Recurrence, RecurrenceSegment } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RepeatSheet } from './RepeatSheet';

const TODAY = '2026-08-12';

function mount(
  value?: Recurrence,
  options: {
    completedOccurrenceCount?: number;
    onCommit?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const onCommit = options.onCommit ?? vi.fn(async () => true);
  const onClose = vi.fn();
  render(
    <ThemeProvider scheme="light">
      <RepeatSheet
        open
        onClose={onClose}
        anchorDate={TODAY}
        {...(value === undefined ? {} : { value })}
        activityForConfirmation={{ title: 'Gym' }}
        completedOccurrenceCount={options.completedOccurrenceCount ?? 0}
        onCommit={onCommit}
      />
    </ThemeProvider>,
  );
  return { onCommit, onClose };
}

describe('RepeatSheet', () => {
  it('opens a two-segment series on the active segment only', () => {
    mount({
      mode: 'fixed',
      segments: [
        { freq: 'daily', effectiveFrom: '2026-08-01' },
        { freq: 'monthly', byMonthDay: [5], effectiveFrom: '2026-08-05' },
      ],
    });

    expect((screen.getByTestId('repeat-option') as HTMLSelectElement).value).toBe(
      'monthly',
    );
    expect(screen.getByTestId('repeat-summary').textContent).toContain(
      'Monthly on the 5th',
    );
    expect(screen.getByTestId('repeat-summary').textContent).not.toContain('Daily');
  });

  it('shows typed Days for Custom and validates 2 through 365', () => {
    mount();

    fireEvent.change(screen.getByTestId('repeat-option'), {
      target: { value: 'custom' },
    });
    fireEvent.change(screen.getByTestId('repeat-interval'), { target: { value: '1' } });

    expect(
      screen.getByRole('button', { name: 'Apply repeat' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(screen.getByText('Enter a number from 2 to 365.')).toBeDefined();

    fireEvent.change(screen.getByTestId('repeat-interval'), { target: { value: '17' } });
    expect(
      screen.getByRole('button', { name: 'Apply repeat' }).getAttribute('aria-disabled'),
    ).not.toBe('true');
    expect(screen.getByTestId('repeat-summary').textContent).toContain('Every 17 days');
  });

  it('uses a dropdown for Ends and reveals only its detail control', () => {
    mount();
    fireEvent.change(screen.getByTestId('repeat-option'), { target: { value: 'daily' } });
    expect((screen.getByTestId('repeat-ends') as HTMLSelectElement).value).toBe('never');

    fireEvent.change(screen.getByTestId('repeat-ends'), { target: { value: 'date' } });
    expect(screen.getByTestId('repeat-end-date')).toBeDefined();
    expect(screen.queryByTestId('repeat-count')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Pick a date' }));
    expect(screen.getByLabelText('End date').getAttribute('type')).toBe('date');
  });

  it('commits a same-day correction without appending a duplicate anchor', async () => {
    const onCommit = vi.fn(async (_value: Recurrence | undefined) => true);
    mount(
      {
        mode: 'fixed',
        segments: [{ freq: 'daily', interval: 1, effectiveFrom: TODAY }],
      },
      { onCommit },
    );

    fireEvent.change(screen.getByTestId('repeat-option'), {
      target: { value: 'weekdays' },
    });
    expect(screen.getByTestId('repeat-summary').textContent).toContain('Every weekday');
    fireEvent.click(screen.getByRole('button', { name: 'Apply repeat' }));

    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(1));
    expect(onCommit.mock.calls[0]?.[0]?.segments).toEqual([
      { freq: 'weekdays', effectiveFrom: TODAY },
    ]);
  });

  it('turns a rejected 21st rule into an explanation with an End series path', async () => {
    const segments = Array.from(
      { length: 20 },
      (_, index): RecurrenceSegment => ({
        freq: 'daily',
        effectiveFrom: `2026-07-${String(index + 1).padStart(2, '0')}`,
      }),
    );
    const onCommit = vi.fn(async (_value: Recurrence | undefined) => false);
    mount({ mode: 'fixed', segments }, { onCommit });

    fireEvent.change(screen.getByTestId('repeat-option'), {
      target: { value: 'monthly' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Apply repeat' }));

    await waitFor(() => expect(screen.getByTestId('repeat-series-limit')).toBeDefined());
    expect(onCommit.mock.calls[0]?.[0]?.segments).toHaveLength(21);
    expect(screen.getByRole('alert').textContent).toContain('20 rule changes');
    fireEvent.click(screen.getByRole('button', { name: 'End series' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledTimes(2));
    expect(onCommit.mock.calls[1]?.[0]).toMatchObject({
      endDate: TODAY,
      segments,
    });
  });

  it('confirms Never with the real stored completion count and names End series', async () => {
    const onCommit = vi.fn(async (_value: Recurrence | undefined) => true);
    mount(
      {
        mode: 'fixed',
        segments: [{ freq: 'daily', interval: 1, effectiveFrom: '2026-08-01' }],
      },
      { completedOccurrenceCount: 40, onCommit },
    );

    fireEvent.change(screen.getByTestId('repeat-option'), { target: { value: 'never' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply repeat' }));

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText(/40 past completions from view/)).toBeDefined();
    expect(screen.getByText(/End series instead/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Stop repeating' }));
    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(undefined));
  });

  it('applies Never immediately when no completion history exists', async () => {
    const { onCommit } = mount({
      mode: 'fixed',
      segments: [{ freq: 'daily', interval: 1, effectiveFrom: '2026-08-01' }],
    });

    fireEvent.change(screen.getByTestId('repeat-option'), { target: { value: 'never' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply repeat' }));

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(undefined));
    expect(screen.queryByTestId('repeat-never-confirmation')).toBeNull();
  });
});
