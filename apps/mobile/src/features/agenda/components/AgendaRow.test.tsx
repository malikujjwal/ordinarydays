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

  it('speaks a supplied date for an untimed Plans row and drops its list divider in a card', () => {
    const untimed = item('event');
    delete untimed.time;
    mount(
      <AgendaRow
        item={untimed}
        untimedContextLabel="Wed, Aug 19"
        divider={false}
        onOpen={() => {}}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Evening plan, Wed, Aug 19, no time' }),
    ).toBeDefined();
    expect(screen.getByTestId(/^agenda-row-act_/).style.borderBottomWidth).toBe('0px');
  });

  it.each([
    ['task', 'Done?'],
    ['meal', 'How did it go?'],
    ['watch', 'How did it go?'],
    ['event', 'How did it go?'],
    ['custom', 'Done?'],
  ] as const)(
    'opens the exact %s resolution prompt without navigating',
    (type, prompt) => {
      const onOpen = vi.fn();
      const onOpenResolution = vi.fn();
      mount(
        <AgendaRow
          item={item(type, { isPast: true })}
          onOpen={onOpen}
          onOpenResolution={onOpenResolution}
        />,
      );

      fireEvent.click(
        screen.getByRole('button', {
          name: `${prompt} Choose an outcome for Evening plan`,
        }),
      );

      expect(onOpenResolution).toHaveBeenCalledWith(expect.objectContaining({ type }));
      expect(onOpen).not.toHaveBeenCalled();
    },
  );

  it('renders no resolution prompt for an unauthorized participant', () => {
    mount(
      <AgendaRow
        item={item('event', {
          isPast: true,
          capabilities: { complete: false, skip: false, snooze: false },
        })}
        onOpen={() => {}}
        onOpenResolution={() => {}}
      />,
    );

    expect(screen.queryByTestId('agenda-resolution-prompt')).toBeNull();
  });

  /**
   * `today-and-tasks.md` §4: "Completed items render with their outcome verb (`Had it`,
   * `Watched`, `Attended`, `Done`)" — `Complete` is not on that list. It belongs to §4's
   * passed-plan sheet table, which is the *action* a task offers, not the state it ends in.
   * One mapping was serving both, so a finished task announced an instruction.
   */
  it.each([
    ['task', 'Done'],
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
        today="2026-08-06"
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
    /**
     * `textMuted`, not `textDisabled` (P2-40). The pre-snooze time is the only thing on the
     * row that says what the time *was*, so it carries meaning — and §5.1 states `textDisabled`
     * never does. De-emphasis is still asserted; it is just asserted against the readable
     * tertiary token rather than the exempt one.
     */
    const colorProbe = document.createElement('span');
    colorProbe.style.color = colors.light.textMuted;
    expect(badge.textContent).toBe('6:00 PM → 8:00 PM');
    expect(original.style.color).toBe(colorProbe.style.color);
    expect(colors.light.textMuted).not.toBe(colors.light.textPrimary);
  });

  it('renders the compact overdue date with its full label and warning tokens', () => {
    const onOpenOverdue = vi.fn();
    mount(
      <RowBadges
        overdueFromDate="2026-08-05"
        today="2026-08-06"
        participantAvatars={[]}
        onOpenOverdue={onOpenOverdue}
      />,
    );

    const chip = screen.getByRole('button', {
      name: 'Overdue from Wednesday 5 August',
    });
    const label = screen.getByText('Yesterday');
    const foreground = document.createElement('span');
    const background = document.createElement('span');
    foreground.style.color = colors.light.warning;
    background.style.backgroundColor = colors.light.warningSurface;

    expect(label.style.color).toBe(foreground.style.color);
    expect(label.parentElement?.style.backgroundColor).toBe(
      background.style.backgroundColor,
    );
    fireEvent.click(chip);
    expect(onOpenOverdue).toHaveBeenCalledOnce();
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
