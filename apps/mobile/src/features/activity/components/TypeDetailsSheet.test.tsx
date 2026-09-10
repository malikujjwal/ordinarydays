import type { Activity } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AccessibilityInfo } from 'react-native';
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

function mount(
  current: Activity,
  mode: 'type' | 'link' = 'type',
  options: {
    onSave?: ReturnType<typeof vi.fn>;
    error?: string;
    busy?: boolean;
  } = {},
) {
  const onSave = options.onSave ?? vi.fn(async () => true);
  const onClose = vi.fn();
  const wrap = (ui: ReactNode) => (
    <SafeAreaProvider>
      <ThemeProvider scheme="light">{ui}</ThemeProvider>
    </SafeAreaProvider>
  );
  const view = render(
    wrap(
      <TypeDetailsSheet
        open
        mode={mode}
        activity={current}
        onClose={onClose}
        onSave={onSave}
        {...(options.busy === undefined ? {} : { busy: options.busy })}
        {...(options.error === undefined ? {} : { error: options.error })}
      />,
    ),
  );
  return { onSave, onClose, wrap, ...view };
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

  it('keeps a failed draft for retry after the activity refreshes', async () => {
    const announce = vi.spyOn(AccessibilityInfo, 'announceForAccessibility');
    const onSave = vi.fn(async () => false);
    const current = activity({
      details: {
        kind: 'meal',
        mealSlot: 'dinner',
        recipeUrl: 'https://www.bbcgoodfood.com/recipes/chicken-tacos',
      },
    });
    const { onClose, rerender, wrap } = mount(current, 'type', { onSave });

    fireEvent.change(screen.getByLabelText('Recipe link'), {
      target: { value: 'https://www.example.com/tacos' },
    });
    fireEvent.click(screen.getByTestId('type-details-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Recipe link') as HTMLInputElement).value).toBe(
      'https://www.example.com/tacos',
    );

    rerender(
      wrap(
        <TypeDetailsSheet
          open
          mode="type"
          activity={{
            ...current,
            updatedAt: '2026-08-08T11:00:00.000Z',
            details: {
              kind: 'meal',
              mealSlot: 'lunch',
              recipeUrl: 'https://www.theirs.example/tacos',
            },
          }}
          onClose={onClose}
          onSave={onSave}
          error="Something went wrong."
        />,
      ),
    );

    expect((screen.getByLabelText('Recipe link') as HTMLInputElement).value).toBe(
      'https://www.example.com/tacos',
    );
    expect(screen.getByText('Something went wrong.')).toBeDefined();
    expect(announce).toHaveBeenCalledWith('Something went wrong.');
    fireEvent.click(screen.getByTestId('type-details-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0]).toEqual({
      details: {
        kind: 'meal',
        mealSlot: 'dinner',
        recipeUrl: 'https://www.example.com/tacos',
      },
    });
    expect(onClose).not.toHaveBeenCalled();
    announce.mockRestore();
  });

  it('cancels unchanged details immediately and confirms a dirty draft', () => {
    const { onClose } = mount(
      activity({
        details: {
          kind: 'meal',
          mealSlot: 'dinner',
          recipeUrl: 'https://www.bbcgoodfood.com/recipes/chicken-tacos',
        },
      }),
    );

    fireEvent.click(screen.getByTestId('type-details-cancel'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Keep editing' })).toBeNull();

    onClose.mockClear();
    fireEvent.change(screen.getByLabelText('Recipe link'), {
      target: { value: 'https://www.example.com/tacos' },
    });
    fireEvent.click(screen.getByTestId('type-details-cancel'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Keep editing' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Discard changes' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect((screen.getByLabelText('Recipe link') as HTMLInputElement).value).toBe(
      'https://www.example.com/tacos',
    );
    fireEvent.click(screen.getByTestId('type-details-sheet-scrim'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('asks before discarding a dirty link via Close', () => {
    const { onClose } = mount(activity(), 'link');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Keep editing' })).toBeNull();

    onClose.mockClear();
    fireEvent.change(screen.getByTestId('type-details-source-url'), {
      target: { value: 'https://www.thetrainline.com/book' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Your link has unsaved changes.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(
      (screen.getByTestId('type-details-source-url') as HTMLInputElement).value,
    ).toBe('https://www.thetrainline.com/book');
  });
});
