import type { Activity } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { describe, expect, it, vi } from 'vitest';
import { TypeDetailsSheet } from './TypeDetailsSheet';

const activity = (patch: Record<string, unknown> = {}): Activity =>
  ({
    activityId: 'act_01J0000000000000000000000A',
    ownerId: 'usr_01J0000000000000000000000B',
    objectKind: 'plan',
    type: 'meal',
    status: 'saved',
    title: 'Tacos',
    participantCount: 0,
    childCount: 0,
    expenseTotalCents: 0,
    visibility: 'private',
    details: { kind: 'meal', mealSlot: 'dinner' },
    icsSequence: 0,
    createdAt: '2026-08-08T10:00:00.000Z',
    lastActivityAt: '2026-08-08T10:00:00.000Z',
    updatedAt: '2026-08-08T10:00:00.000Z',
    schemaVersion: 1,
    ...patch,
  }) as Activity;

function mount(current: Activity, mode: 'type' | 'link' = 'type') {
  const onSave = vi.fn(async () => true);
  const onClose = vi.fn();
  const wrap = (ui: ReactNode) => (
    <SafeAreaProvider>
      <ThemeProvider scheme="light">{ui}</ThemeProvider>
    </SafeAreaProvider>
  );
  render(
    wrap(
      <TypeDetailsSheet
        open
        mode={mode}
        activity={current}
        onClose={onClose}
        onSave={onSave}
      />,
    ),
  );
  return { onSave, onClose };
}

describe('TypeDetailsSheet', () => {
  it('clears the meal slot when the chosen segment is tapped again', async () => {
    const { onSave } = mount(activity());
    fireEvent.click(screen.getByRole('tab', { name: 'Dinner' }));
    fireEvent.click(screen.getByTestId('type-details-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toEqual({ details: { kind: 'meal' } });
  });

  it('hides season and episode for a movie without wiping stored values', async () => {
    const { onSave } = mount(
      activity({
        type: 'watch',
        details: {
          kind: 'watch',
          mediaTitle: 'Past Lives',
          mediaKind: 'show',
          season: 2,
          episode: 4,
          service: 'Netflix',
        },
      }),
    );

    expect(screen.getByLabelText('Season')).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: 'Movie' }));
    expect(screen.queryByLabelText('Season')).toBeNull();
    expect(
      screen.getByText('Season and episode are not shown for a movie.'),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('tab', { name: 'Show' }));
    expect((screen.getByLabelText('Season') as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByRole('tab', { name: 'Movie' }));
    fireEvent.click(screen.getByTestId('type-details-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      details: {
        kind: 'watch',
        mediaTitle: 'Past Lives',
        mediaKind: 'movie',
        season: 2,
        episode: 4,
        service: 'Netflix',
      },
    });
  });
});
