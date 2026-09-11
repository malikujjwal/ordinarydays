import type { Activity } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AccessibilityInfo } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { describe, expect, it, vi } from 'vitest';
import { TypeDetailsSheet, type TypeDetailsSheetProps } from './TypeDetailsSheet';

/** A new ingredient row mints its `ing_` id from the device CSPRNG; jsdom has none. */
vi.mock('expo-crypto', () => ({
  getRandomBytes: (count: number) => Uint8Array.from({ length: count }, (_, i) => i),
}));

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
  mode: 'type' | 'common' = 'type',
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

  /**
   * Founder bug 2026-09-10: ingredients could not be changed after the meal was created. The
   * sheet reuses the compose rows; existing rows keep their stored id, a new row mints one,
   * and the save sends the edited list with no server-owned `addedToListId`.
   */
  it('round-trips an ingredient rename, removal and addition into the PATCH', async () => {
    const { onSave } = mount(
      activity({
        details: {
          kind: 'meal',
          mealSlot: 'dinner',
          ingredients: [
            { ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A1', name: 'Chicken' },
            {
              ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2',
              name: 'Salsa',
              addedToListId: 'lst_01J8XKQ2M4N5P6R7S8T9V0W1B1',
            },
          ],
        },
      }),
    );

    expect((screen.getByLabelText('Ingredient 1') as HTMLInputElement).value).toBe(
      'Chicken',
    );
    fireEvent.change(screen.getByLabelText('Ingredient 2'), {
      target: { value: 'Hot salsa' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Remove ingredient 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add an ingredient' }));
    fireEvent.change(screen.getByLabelText('Ingredient 2'), {
      target: { value: 'Limes' },
    });
    fireEvent.change(screen.getByLabelText('Quantity 2'), { target: { value: '3' } });
    // A blank row is dropped on save rather than refused.
    fireEvent.click(screen.getByRole('button', { name: 'Add an ingredient' }));
    fireEvent.click(screen.getByTestId('type-details-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const sent = onSave.mock.calls[0]?.[0] as {
      details: { kind: 'meal'; ingredients: { ingredientId: string }[] };
    };
    expect(sent.details.kind).toBe('meal');
    expect(sent.details.ingredients).toHaveLength(2);
    expect(sent.details.ingredients[0]).toEqual({
      ingredientId: 'ing_01J8XKQ2M4N5P6R7S8T9V0W1A2',
      name: 'Hot salsa',
    });
    expect(sent.details.ingredients[1]).toMatchObject({ name: 'Limes', quantity: '3' });
    expect(sent.details.ingredients[1]?.ingredientId).toMatch(
      /^ing_[0-9A-HJKMNP-TV-Z]{26}$/,
    );
    expect(JSON.stringify(sent)).not.toContain('addedToListId');
  });

  /** One Edit edits every detail (2026-09-10): the type sheet ends with the Link field. */
  it('sends sourceUrl in the same PATCH as details, only when it changed', async () => {
    const onSave = vi.fn<TypeDetailsSheetProps['onSave']>(async () => false);
    mount(
      activity({
        type: 'event',
        sourceUrl: 'https://www.instagram.com/p/Cx9pQ2v',
        details: { kind: 'event', organiser: 'Barbican' },
      }),
      'type',
      { onSave },
    );

    fireEvent.click(screen.getByTestId('type-details-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      details: { kind: 'event', organiser: 'Barbican' },
    });

    fireEvent.change(screen.getByTestId('type-details-source-url'), {
      target: { value: 'https://www.barbican.org.uk/whats-on' },
    });
    fireEvent.click(screen.getByTestId('type-details-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0]).toEqual({
      details: { kind: 'event', organiser: 'Barbican' },
      sourceUrl: 'https://www.barbican.org.uk/whats-on',
    });

    fireEvent.change(screen.getByTestId('type-details-source-url'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByTestId('type-details-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(3));
    expect(onSave.mock.calls[2]?.[0]).toEqual({
      details: { kind: 'event', organiser: 'Barbican' },
      sourceUrl: null,
    });
  });

  it('refuses an invalid link in the type sheet without saving', () => {
    const { onSave } = mount(activity());
    fireEvent.change(screen.getByTestId('type-details-source-url'), {
      target: { value: 'not a link' },
    });
    fireEvent.click(screen.getByTestId('type-details-save'));
    expect(screen.getByText('Enter a valid link.')).toBeDefined();
    expect(onSave).not.toHaveBeenCalled();
  });

  /** Review 2026-09-11: the server accepts any URL scheme, so an untouched link never blocks. */
  it('saves details without re-validating an untouched non-http link', async () => {
    const { onSave } = mount(activity({ sourceUrl: 'mailto:host@venue.com' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Lunch' }));
    fireEvent.click(screen.getByTestId('type-details-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]?.[0]).toEqual({
      details: { kind: 'meal', mealSlot: 'lunch' },
    });
  });

  it('does not treat an added blank ingredient row as an unsaved change', () => {
    const { onClose } = mount(activity());
    fireEvent.click(screen.getByRole('button', { name: 'Add an ingredient' }));
    fireEvent.click(screen.getByTestId('type-details-cancel'));
    expect(onClose).toHaveBeenCalledOnce();
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
    const onSave = vi.fn<TypeDetailsSheetProps['onSave']>(async () => false);
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
    const { onClose } = mount(activity(), 'common');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Keep editing' })).toBeNull();

    onClose.mockClear();
    fireEvent.change(screen.getByTestId('type-details-source-url'), {
      target: { value: 'https://www.thetrainline.com/book' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Your details have unsaved changes.')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(
      (screen.getByTestId('type-details-source-url') as HTMLInputElement).value,
    ).toBe('https://www.thetrainline.com/book');
  });

  /** Founder decision 2026-09-11: Place is editable after creation, on every kind's sheet. */
  describe('Place and Address', () => {
    const placed = (patch: Record<string, unknown> = {}) =>
      activity({
        objectKind: 'task',
        type: 'task',
        details: { kind: 'task' },
        location: {
          label: 'Noble Rot',
          address: '51 Lamb’s Conduit St',
          lat: 51.52,
          lng: -0.12,
        },
        ...patch,
      });

    it('titles the Task / General sheet Details and seeds Place, Address and Link', () => {
      mount(placed({ sourceUrl: 'https://noblerot.co.uk' }), 'common');
      expect(screen.getByRole('heading', { name: 'Details' })).toBeDefined();
      expect((screen.getByLabelText('Place') as HTMLInputElement).value).toBe(
        'Noble Rot',
      );
      expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe(
        '51 Lamb’s Conduit St',
      );
      expect(
        (screen.getByTestId('type-details-source-url') as HTMLInputElement).value,
      ).toBe('https://noblerot.co.uk');
    });

    it('closes without a write when nothing changed', () => {
      const { onSave, onClose } = mount(placed(), 'common');
      fireEvent.click(screen.getByTestId('details-save'));
      expect(onSave).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('sends location alone when only the place changed, keeping the pin on a rename', async () => {
      const { onSave } = mount(placed(), 'common');
      fireEvent.change(screen.getByLabelText('Place'), {
        target: { value: '  Noble Rot Soho ' },
      });
      fireEvent.click(screen.getByTestId('details-save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      expect(onSave.mock.calls[0]?.[0]).toEqual({
        location: {
          label: 'Noble Rot Soho',
          address: '51 Lamb’s Conduit St',
          lat: 51.52,
          lng: -0.12,
        },
      });
    });

    it('drops the pin when the address changes', async () => {
      const { onSave } = mount(placed(), 'common');
      fireEvent.change(screen.getByLabelText('Address'), {
        target: { value: '2 Greek St' },
      });
      fireEvent.click(screen.getByTestId('details-save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      expect(onSave.mock.calls[0]?.[0]).toEqual({
        location: { label: 'Noble Rot', address: '2 Greek St' },
      });
    });

    it('clears the location with null when Place and Address are both cleared', async () => {
      const { onSave } = mount(placed(), 'common');
      fireEvent.change(screen.getByLabelText('Place'), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText('Address'), { target: { value: ' ' } });
      fireEvent.click(screen.getByTestId('details-save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      expect(onSave.mock.calls[0]?.[0]).toEqual({ location: null });
    });

    it('refuses an address with no place, as a field error, and keeps the draft', () => {
      const { onSave } = mount(placed(), 'common');
      fireEvent.change(screen.getByLabelText('Place'), { target: { value: '' } });
      fireEvent.click(screen.getByTestId('details-save'));
      expect(onSave).not.toHaveBeenCalled();
      expect(
        screen.getByText('Name the place so the address has something to belong to.'),
      ).toBeDefined();
      expect((screen.getByLabelText('Address') as HTMLInputElement).value).toBe(
        '51 Lamb’s Conduit St',
      );
    });

    it('rides in the same PATCH as details on the type sheet, only when it changed', async () => {
      const onSave = vi.fn<TypeDetailsSheetProps['onSave']>(async () => false);
      mount(
        activity({
          type: 'event',
          details: { kind: 'event', organiser: 'Barbican' },
          location: { label: 'Barbican Hall' },
        }),
        'type',
        { onSave },
      );
      fireEvent.click(screen.getByTestId('type-details-save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
      expect(onSave.mock.calls[0]?.[0]).toEqual({
        details: { kind: 'event', organiser: 'Barbican' },
      });

      fireEvent.change(screen.getByLabelText('Place'), {
        target: { value: 'Milton Court' },
      });
      fireEvent.click(screen.getByTestId('type-details-save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
      expect(onSave.mock.calls[1]?.[0]).toEqual({
        details: { kind: 'event', organiser: 'Barbican' },
        location: { label: 'Milton Court' },
      });
      // A failed save keeps the typed place for the retry.
      expect((screen.getByLabelText('Place') as HTMLInputElement).value).toBe(
        'Milton Court',
      );
    });

    it('adds a place to a meal that had none', async () => {
      const { onSave } = mount(activity());
      fireEvent.change(screen.getByLabelText('Place'), { target: { value: 'Home' } });
      fireEvent.click(screen.getByTestId('type-details-save'));
      await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
      expect(onSave.mock.calls[0]?.[0]).toEqual({
        details: { kind: 'meal', mealSlot: 'dinner' },
        location: { label: 'Home' },
      });
    });

    it('asks before discarding a changed place', () => {
      const { onClose } = mount(placed(), 'common');
      fireEvent.change(screen.getByLabelText('Place'), {
        target: { value: 'Elsewhere' },
      });
      fireEvent.click(screen.getByTestId('type-details-cancel'));
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByText('Your details have unsaved changes.')).toBeDefined();
    });
  });
});
