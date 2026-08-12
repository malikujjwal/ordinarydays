import type { AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SnoozeSheet } from './SnoozeSheet';

const timed: AgendaItem = {
  activityId: 'act_01J0000000000000000000000A',
  type: 'task',
  title: 'Call the dentist',
  status: 'scheduled',
  time: '15:00',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
};

function mount(item: AgendaItem = timed, currentMinute = '15:10') {
  const onClose = vi.fn();
  const onSnooze = vi.fn();
  const onTomorrow = vi.fn();
  const rendered = render(
    <ThemeProvider scheme="light">
      <SnoozeSheet
        open
        item={item}
        currentMinute={currentMinute}
        onClose={onClose}
        onSnooze={onSnooze}
        onTomorrow={onTomorrow}
      />
    </ThemeProvider>,
  );
  return { ...rendered, onClose, onSnooze, onTomorrow };
}

describe('SnoozeSheet', () => {
  it('announces every one-off option with its resulting time', () => {
    mount();

    expect(screen.getByRole('heading', { name: 'Snooze' })).toBeDefined();
    expect(
      screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Close',
      'Snooze until 3:25 PM',
      'Snooze until 4:10 PM',
      'Snooze until 6:10 PM',
      'Snooze until 6:00 PM',
      'Move to tomorrow at 3:00 PM',
      'Pick a time',
    ]);
  });

  it('dispatches a fixed snooze and closes', () => {
    const callbacks = mount();

    fireEvent.click(screen.getByRole('button', { name: 'Snooze until 4:10 PM' }));

    expect(callbacks.onSnooze).toHaveBeenCalledExactlyOnceWith(timed, '16:10');
    expect(callbacks.onTomorrow).not.toHaveBeenCalled();
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it('omits Tomorrow for a recurring occurrence', () => {
    mount({ ...timed, isRecurring: true, occurrenceDate: '2026-08-11' });

    expect(screen.queryByText('Tomorrow')).toBeNull();
    expect(screen.queryByRole('button', { name: /tomorrow/i })).toBeNull();
  });

  it('does not render for an untimed task or when the server denies snooze', () => {
    const { time: _time, ...untimed } = timed;
    const first = mount(untimed);
    expect(screen.queryByTestId('snooze-sheet')).toBeNull();
    expect(first.onSnooze).not.toHaveBeenCalled();
    first.unmount();

    const second = mount({
      ...timed,
      capabilities: { ...timed.capabilities, snooze: false },
    });
    expect(screen.queryByTestId('snooze-sheet')).toBeNull();
    expect(second.onSnooze).not.toHaveBeenCalled();
  });

  it('hides the evening option at 19:00', () => {
    mount(timed, '19:00');
    expect(screen.queryByText('This evening (6 PM)')).toBeNull();
  });

  it('keeps a picked past time inline and does not dispatch it', () => {
    const callbacks = mount(timed, '19:00');

    fireEvent.click(screen.getByRole('button', { name: 'Pick a time' }));
    fireEvent.change(screen.getByLabelText('Snooze time'), {
      target: { value: '18:55' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.getByRole('alert').textContent).toBe('Choose a time later than now.');
    expect(callbacks.onSnooze).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
  });
});
