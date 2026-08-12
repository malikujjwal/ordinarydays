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

    expect(screen.getByTestId('repeat-option-monthly').getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByTestId('repeat-summary').textContent).toContain(
      'Monthly on the 5th',
    );
    expect(screen.getByTestId('repeat-summary').textContent).not.toContain('Daily');
  });

  it('disables commit when Selected weekdays has no day selected', () => {
    mount();

    fireEvent.click(screen.getByTestId('repeat-option-selected_weekdays'));

    expect(
      screen.getByRole('button', { name: 'Apply repeat' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain(
      'Choose at least one weekday',
    );
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

    fireEvent.click(screen.getByTestId('repeat-option-monthly'));
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

    fireEvent.click(screen.getByTestId('repeat-option-never'));
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

    fireEvent.click(screen.getByTestId('repeat-option-never'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply repeat' }));

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(undefined));
    expect(screen.queryByTestId('repeat-never-confirmation')).toBeNull();
  });
});
