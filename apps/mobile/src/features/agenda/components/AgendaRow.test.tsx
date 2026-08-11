import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActivityType, AgendaItem } from '@od/shared/types';
import { colors, ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgendaRow } from './AgendaRow';
import { RowBadges } from './RowBadges';

const TYPES: ActivityType[] = ['task', 'meal', 'watch', 'event', 'custom'];

function item(type: ActivityType, patch: Partial<AgendaItem> = {}): AgendaItem {
  return {
    activityId: 'act_01J8SEED000000000000000000',
    type,
    title: 'Evening plan',
    status: 'scheduled',
    time: '20:00',
    isRecurring: false,
    isSnoozed: false,
    hasCheckbox: type === 'task',
    capabilities: { complete: true, skip: false, snooze: true },
    participantAvatars: [],
    participantCount: 0,
    isPast: false,
    ...patch,
  };
}

function mount(row: React.ReactNode) {
  return render(<ThemeProvider scheme="light">{row}</ThemeProvider>);
}

afterEach(() => vi.restoreAllMocks());

describe('AgendaRow affordances', () => {
  it.each(TYPES)('opens %s detail from the body without mutating', (type) => {
    const onOpen = vi.fn();
    const onToggleComplete = vi.fn();
    mount(
      <AgendaRow item={item(type)} onOpen={onOpen} onToggleComplete={onToggleComplete} />,
    );

    fireEvent.click(screen.getByTestId('agenda-row-body'));

    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ type }));
    expect(onToggleComplete).not.toHaveBeenCalled();
  });

  it('checks a task without navigating and gives timed controls the required reading order', () => {
    const onOpen = vi.fn();
    const onToggleComplete = vi.fn();
    const onOpenReschedule = vi.fn();
    mount(
      <AgendaRow
        item={item('task', {
          title: 'Gym',
          recurrenceDescription: 'repeats on weekdays',
          isRecurring: true,
        })}
        showTime
        onOpen={onOpen}
        onToggleComplete={onToggleComplete}
        onOpenReschedule={onOpenReschedule}
      />,
    );

    const checkbox = screen.getByRole('checkbox', { name: 'Gym, not completed' });
    const body = screen.getByRole('button', {
      name: 'Gym, 8:00 PM, repeats on weekdays',
    });
    const time = screen.getByRole('button', { name: '8:00 PM, change time' });
    fireEvent.click(checkbox);

    expect(onToggleComplete).toHaveBeenCalledWith(expect.any(Object), true);
    expect(onOpen).not.toHaveBeenCalled();
    expect(
      checkbox.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(body.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(time);
    expect(onOpenReschedule).toHaveBeenCalledWith(expect.any(Object));
  });

  it('renders a plan marker as hidden, roleless, and non-interactive', () => {
    const onOpen = vi.fn();
    const { container } = mount(<AgendaRow item={item('event')} onOpen={onOpen} />);
    const marker = screen.getByTestId('agenda-leading-marker');

    expect(marker.getAttribute('role')).toBeNull();
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(marker);

    expect(onOpen).not.toHaveBeenCalled();
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
  });

  it('renders the server subtitle verbatim even when it contradicts the type', () => {
    mount(
      <AgendaRow
        item={item('meal', { subtitle: 'Season 2, episode 4' })}
        onOpen={() => {}}
      />,
    );

    expect(screen.getByText('Season 2, episode 4')).toBeDefined();
  });

  it.each([
    ['task', 'Complete'],
    ['meal', 'Had it'],
    ['watch', 'Watched'],
    ['event', 'Attended'],
    ['custom', 'Done'],
  ] as const)('renders the completed %s outcome verb', (type, verb) => {
    mount(
      <AgendaRow
        item={item(type, { status: 'completed', hasCheckbox: false })}
        onOpen={() => {}}
      />,
    );

    expect(
      screen.getByRole('button', { name: new RegExp(`Evening plan, ${verb}`) }),
    ).toBeDefined();
    expect(screen.queryByLabelText(verb)).toBeNull();
  });
});

describe('RowBadges', () => {
  it('renders all five badge slots in canonical order', () => {
    mount(
      <RowBadges
        recurrenceDescription="Weekdays"
        originalTime="18:00"
        effectiveTime="20:00"
        overdueFromDate="2026-08-04"
        participantAvatars={[
          { personId: 'per_1', displayName: 'Alice' },
          { personId: 'per_2', displayName: 'Ben' },
          { personId: 'per_3', displayName: 'Casey' },
          { personId: 'per_4', displayName: 'Devon' },
        ]}
        pendingRsvpLabel="Awaiting reply"
      />,
    );

    const order = [
      'agenda-badge-recurrence',
      'agenda-badge-snooze',
      'agenda-badge-overdue',
      'agenda-badge-participants',
      'agenda-badge-pending-rsvp',
    ].map((testID) => screen.getByTestId(testID));

    for (let index = 0; index < order.length - 1; index += 1) {
      const current = order[index] as HTMLElement;
      const next = order[index + 1] as HTMLElement;
      expect(
        current.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
    expect(screen.getByText('+1')).toBeDefined();
  });

  it('pins snooze copy, original-time de-emphasis, and its accessible label', () => {
    mount(
      <RowBadges originalTime="18:00" effectiveTime="20:00" participantAvatars={[]} />,
    );

    const badge = screen.getByLabelText('Snoozed from 6:00 PM to 8:00 PM');
    const original = screen.getByTestId('agenda-snooze-original');
    const colorProbe = document.createElement('span');
    colorProbe.style.color = colors.light.textDisabled;
    expect(badge.textContent).toBe('6:00 PM → 8:00 PM');
    expect(original.style.color).toBe(colorProbe.style.color);
  });
});

describe('AgendaRow structural guards', () => {
  it('selects the leading control only from hasCheckbox', () => {
    const leadingSource = readFileSync(
      resolve(process.cwd(), 'src/features/agenda/components/RowLeading.tsx'),
      'utf8',
    );
    const rowSource = readFileSync(
      resolve(process.cwd(), 'src/features/agenda/components/AgendaRow.tsx'),
      'utf8',
    );

    expect(leadingSource).toContain('if (hasCheckbox)');
    expect(leadingSource).not.toMatch(/\btype\b/);
    expect(rowSource).toContain('hasCheckbox={item.hasCheckbox}');
  });

  it('keeps long scaled titles in a content-sized, shrinkable row', () => {
    mount(
      <AgendaRow
        item={item('task', {
          title:
            'A deliberately long title that wraps under the largest accessibility text size',
        })}
        showTime
        onOpen={() => {}}
      />,
    );

    const row = screen.getByTestId(/^agenda-row-act_/);
    const body = screen.getByTestId('agenda-row-body');
    expect(row.style.height).toBe('');
    expect(row.style.minHeight).toBe('56px');
    expect(body.parentElement?.style.minWidth).toBe('0px');
    expect(
      screen.getByText(/A deliberately long title/).getAttribute('style'),
    ).not.toContain('font-size: 0');
  });
});
