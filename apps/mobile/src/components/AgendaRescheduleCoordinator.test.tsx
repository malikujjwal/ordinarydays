import type { Activity, AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ActivityDetailView } from '@/features/activity/hooks/useActivity';
import { AgendaRescheduleCoordinator } from './AgendaRescheduleCoordinator';

const mockUseActivityDetail = vi.hoisted(() =>
  vi.fn<(activityId: string) => ActivityDetailView>(),
);

vi.mock('@/features/activity/hooks/useActivity', () => ({
  useActivityDetail: mockUseActivityDetail,
}));

const item: AgendaItem = {
  activityId: 'act_01J0000000000000000000000A',
  type: 'event',
  title: 'Dentist appointment',
  status: 'scheduled',
  time: '14:30',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: false,
  capabilities: { complete: true, skip: true, snooze: false },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
};

const activity: Activity = {
  activityId: item.activityId,
  ownerId: 'usr_01J0000000000000000000000B',
  objectKind: 'plan',
  type: 'event',
  status: 'scheduled',
  title: item.title,
  schedule: {
    date: '2026-08-12',
    time: '14:30',
    timezone: 'America/New_York',
  },
  participantCount: 0,
  childCount: 0,
  expenseTotalCents: 0,
  visibility: 'private',
  details: { kind: 'event' },
  icsSequence: 0,
  createdAt: '2026-08-12T12:00:00.000Z',
  lastActivityAt: '2026-08-12T12:00:00.000Z',
  updatedAt: '2026-08-12T12:00:00.000Z',
  schemaVersion: 1,
};

const sharedActions = {
  refetch: vi.fn(),
  isSaving: false,
  isSavingReminder: false,
  patch: vi.fn(async () => true),
  schedule: vi.fn(async () => true),
  addReminder: vi.fn(async () => true),
  removeReminder: vi.fn(async () => true),
  acknowledgeConflict: vi.fn(),
};

it('keeps one native sheet mounted while activity detail finishes loading', () => {
  let view: ActivityDetailView = { status: 'pending', ...sharedActions };
  mockUseActivityDetail.mockImplementation(() => view);

  const rendered = render(
    <ThemeProvider scheme="light">
      <AgendaRescheduleCoordinator item={item} today="2026-08-12" onClose={() => {}} />
    </ThemeProvider>,
  );
  const originalSheet = screen.getByTestId('reschedule-sheet');

  view = {
    status: 'success',
    detail: { activity, reminders: [] },
    ...sharedActions,
  };
  rendered.rerender(
    <ThemeProvider scheme="light">
      <AgendaRescheduleCoordinator item={item} today="2026-08-12" onClose={() => {}} />
    </ThemeProvider>,
  );

  expect(screen.getByTestId('reschedule-sheet')).toBe(originalSheet);
  expect(screen.getByTestId('reschedule-occurrence-editor')).toBeDefined();
});

it('passes the rendered future date into the shared reschedule editor', () => {
  mockUseActivityDetail.mockReturnValue({
    status: 'success',
    detail: { activity, reminders: [] },
    ...sharedActions,
  });

  render(
    <ThemeProvider scheme="light">
      <AgendaRescheduleCoordinator
        item={item}
        today="2026-08-12"
        renderedDate="2026-08-20"
        onClose={() => {}}
      />
    </ThemeProvider>,
  );

  fireEvent.click(screen.getByTestId('quick-date-pick'));
  expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-08-20');
});
