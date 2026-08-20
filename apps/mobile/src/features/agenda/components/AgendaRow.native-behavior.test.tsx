import type { AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AgendaRow } from './AgendaRow';

vi.mock('@/hooks/usePendingIntents', () => ({
  pendingCreateAllowsOpen: true,
  useAgendaRowIntentState: () => ({
    pendingCreate: {
      pending: true,
      canCancel: true,
      intentId: 'intent-create',
      status: 'queued',
    },
    recurrenceEdit: { inert: false, message: undefined, status: 'idle' },
    mutationInert: true,
  }),
  usePendingCreate: () => ({
    pending: true,
    canCancel: true,
    intentId: 'intent-create',
    status: 'queued',
  }),
}));

const pendingTask: AgendaItem = {
  activityId: 'act_01J8SEED000000000000000000',
  type: 'task',
  title: 'Offline task',
  status: 'scheduled',
  time: '20:00',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
};

it('opens native committed detail while keeping a pending create mutation-inert', () => {
  const onOpen = vi.fn();
  const onToggleComplete = vi.fn();
  render(
    <ThemeProvider scheme="light">
      <AgendaRow item={pendingTask} onOpen={onOpen} onToggleComplete={onToggleComplete} />
    </ThemeProvider>,
  );

  fireEvent.click(screen.getByTestId('agenda-row-body'));

  expect(onOpen).toHaveBeenCalledExactlyOnceWith(pendingTask);
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(onToggleComplete).not.toHaveBeenCalled();
  expect(screen.getByTestId('pending-indicator')).toBeDefined();
});
