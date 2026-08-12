import type { AgendaItem } from '@od/shared/types';
import { ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SwipeableRow } from './SwipeableRow';

const item = (patch: Partial<AgendaItem> = {}): AgendaItem => ({
  activityId: 'act_01J8SEED000000000000000000',
  type: 'task',
  title: 'Water the plants',
  status: 'scheduled',
  isRecurring: false,
  isSnoozed: false,
  hasCheckbox: true,
  capabilities: { complete: true, skip: false, snooze: true },
  participantAvatars: [],
  participantCount: 0,
  isPast: false,
  ...patch,
});

const mount = (ui: React.ReactNode) =>
  render(<ThemeProvider scheme="light">{ui}</ThemeProvider>);

describe('SwipeableRow web equivalents', () => {
  it('reveals the positive and overflow controls on hover', () => {
    mount(<SwipeableRow item={item()} onOpen={() => {}} />);
    const wrapper = screen.getByTestId(/^swipeable-row-/);
    const positive = screen.getByTestId('agenda-web-positive-action');
    const controls = positive.parentElement;

    expect(controls?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.pointerEnter(wrapper);
    expect(controls?.getAttribute('aria-hidden')).not.toBe('true');
    expect(screen.getByRole('button', { name: 'Complete' })).toBeDefined();
    expect(
      screen.getByRole('button', { name: 'More actions for Water the plants' }),
    ).toBeDefined();
  });

  it('keeps a passed resolution prompt clear of the hover-action overlay', () => {
    const onAction = vi.fn();
    const onOpenResolution = vi.fn();
    mount(
      <SwipeableRow
        item={item({
          type: 'event',
          title: 'Coffee with Sam',
          hasCheckbox: false,
          isPast: true,
        })}
        onOpen={() => {}}
        onAction={onAction}
        onOpenResolution={onOpenResolution}
      />,
    );

    fireEvent.pointerEnter(screen.getByTestId(/^swipeable-row-/));
    expect(screen.queryByTestId('agenda-web-controls')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'How did it go? Choose an outcome for Coffee with Sam',
      }),
    );
    expect(onOpenResolution).toHaveBeenCalledOnce();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('keeps the hover controls keyboard reachable and dispatches the focused-row shortcut', () => {
    const onAction = vi.fn();
    mount(<SwipeableRow item={item()} onOpen={() => {}} onAction={onAction} />);

    const body = screen.getByTestId('agenda-row-body');
    fireEvent.focus(body);
    fireEvent.keyDown(document, { key: 'e' });
    expect(onAction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ name: 'complete', label: 'Complete' }),
    );

    const positive = screen.getByTestId('agenda-web-positive-action');
    fireEvent.blur(body);
    fireEvent.focus(positive);
    expect(positive.parentElement?.getAttribute('aria-hidden')).not.toBe('true');
  });

  it('opens the exact secondary-action menu and dispatches its destructive button', () => {
    const onAction = vi.fn();
    mount(
      <SwipeableRow
        item={item({ time: '18:00' })}
        onOpen={() => {}}
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByTestId('agenda-web-more-actions'));
    expect(screen.getByTestId('agenda-web-action-menu')).toBeDefined();
    expect(
      screen.getAllByRole('menuitem').map((button) => button.getAttribute('aria-label')),
    ).toEqual(['Snooze', 'Reschedule', 'Delete']);

    fireEvent.click(screen.getByTestId('agenda-menu-delete'));
    expect(onAction).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ name: 'delete', destructive: true }),
    );
  });
});
