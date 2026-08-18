import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ActivityType, AgendaItem } from '@od/shared/types';
import { colors, space, ThemeProvider } from '@od/ui';
import { fireEvent, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IntentLog, type IntentLogStorage } from '@/lib/intentLog';
import { setActiveIntentLog } from '@/lib/intentReplay';
import { AgendaRow } from './AgendaRow';
import { RowBadges } from './RowBadges';

const TYPES: ActivityType[] = ['task', 'meal', 'watch', 'event', 'custom'];

const cssColor = (hex: string): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
};

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

  it('keeps a future recurring task visible but prevents completing it early', () => {
    const onToggleComplete = vi.fn();
    mount(
      <AgendaRow
        item={item('task', {
          title: 'Tomorrow stand-up',
          isRecurring: true,
          occurrenceDate: '2026-08-12',
        })}
        today="2026-08-11"
        onOpen={() => {}}
        onToggleComplete={onToggleComplete}
      />,
    );

    const checkbox = screen.getByRole('checkbox', {
      name: 'Tomorrow stand-up, not completed',
    });
    expect(checkbox.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(checkbox);
    expect(onToggleComplete).not.toHaveBeenCalled();
  });

  it("allows completing today's recurring occurrence", () => {
    mount(
      <AgendaRow
        item={item('task', {
          isRecurring: true,
          occurrenceDate: '2026-08-11',
        })}
        today="2026-08-11"
        onOpen={() => {}}
        onToggleComplete={() => {}}
      />,
    );

    expect(
      screen
        .getByRole('checkbox', { name: 'Evening plan, not completed' })
        .getAttribute('aria-disabled'),
    ).toBeNull();
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
  /**
   * **Four slots, not five** — recurrence and snooze merged into one metadata line on
   * 2026-08-17. A recurring row used to spend a whole line on a bare `↻` whose description was
   * hidden in an `accessibilityLabel`; the line now reads `↻ Repeats daily`, or
   * `↻ 6:00 PM → 8:00 PM` when a snooze has moved the occurrence, which is the more useful of the
   * two whenever there is one. The relative order of what remains is unchanged.
   */
  it('renders the badge slots in canonical order', () => {
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
    /** No `↻` here: this row is snoozed but not recurring, and the glyph means recurrence alone. */
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

/**
 * **The three columns sit on one line, and this is why there is a test for it.**
 *
 * The leading control, the time column and the overdue chip are each 44 pt targets that centre
 * their own content, while the title's first line centres at half its 21 pt leading. Every one of
 * them therefore needs the same lift, and lifting them one at a time produced four separate
 * misalignments in this task — the marker, then the time, then the connector's origin, then the
 * chip — each caught by eye on a screenshot rather than by CI.
 *
 * Asserting the geometry directly is what turns "it looks right today" into something that fails
 * when the padding or the type scale next moves.
 */
describe('the note line', () => {
  /**
   * The note is the user's own words, so it gets its own line above the metadata rather than
   * joining `Meal · Dinner · ↻ Daily` — that line is server-composed type metadata plus
   * recurrence, and merging the two would read as one sentence made of two unrelated things.
   * A row carrying both is therefore three lines, which is the founder's own sketch.
   */
  it('renders above the metadata line and is spoken in the row', () => {
    mount(
      <AgendaRow
        item={item('meal', {
          title: 'Call the dentist',
          noteExcerpt: 'Ask about the crown estimate',
          subtitle: 'Meal · Dinner',
          recurrenceDescription: 'Daily',
          isRecurring: true,
        })}
        onOpen={() => {}}
      />,
    );

    const note = screen.getByTestId('agenda-row-note');
    const meta = screen.getByTestId('agenda-badge-recurrence');
    expect(note.textContent).toBe('Ask about the crown estimate');
    expect(note.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // Spoken as well as shown — a row's accessible name carries its content.
    expect(
      screen.getByRole('button', { name: /Ask about the crown estimate/ }),
    ).toBeDefined();
  });

  it('is absent when the activity has no note', () => {
    mount(<AgendaRow item={item('task')} onOpen={() => {}} />);
    expect(screen.queryByTestId('agenda-row-note')).toBeNull();
  });

  /** One line only: the server already clamped it, and a row is not the place for a paragraph. */
  it('never wraps to a second line', () => {
    mount(
      <AgendaRow
        item={item('task', { noteExcerpt: 'A note long enough to want a second line' })}
        onOpen={() => {}}
      />,
    );
    /**
     * React Native Web renders a single line through a class rather than an inline
     * `-webkit-line-clamp`, so what is checkable is that the two-line row-title default did not
     * apply to it. Verified by asserting the note is not clamped at the title's 2.
     */
    expect(screen.getByTestId('agenda-row-note').style.webkitLineClamp).not.toBe('2');
  });
});

describe('AgendaRow vertical alignment', () => {
  /**
   * Read off the **inline styles**, not `getBoundingClientRect`.
   *
   * jsdom lays nothing out, so every rect is zero and a geometry assertion passes whatever the
   * code does — verified by breaking the lift on purpose and watching the test stay green. What
   * jsdom does expose is what React Native Web wrote, and the invariant is expressible there:
   * both columns must be lifted by the **same amount**, which is the thing that was wrong four
   * separate times in this task.
   */
  const liftOf = (element: HTMLElement, property: 'top' | 'marginTop'): number =>
    Math.abs(Number.parseFloat(element.style[property] || '0'));

  it('lifts the time column and the leading control by the same amount', () => {
    mount(
      <AgendaRow
        item={item('task', { title: 'Gym' })}
        showTime
        onOpen={() => {}}
        onToggleComplete={() => {}}
      />,
    );

    const leadingLift = liftOf(screen.getByTestId('agenda-row-leading'), 'marginTop');
    const railTop = liftOf(screen.getByTestId('agenda-row-time'), 'top');

    // The row's own padding minus the shared lift is where the rail starts.
    expect(leadingLift).toBeGreaterThan(0);
    expect(railTop + leadingLift).toBeCloseTo(space[4], 1);
  });

  /**
   * **A row with no metadata is the case that broke**, because `Touchable` centres its content in
   * the 44 pt target it guarantees: a lone title sat 11 pt low, while a title with a line beneath
   * it was tall enough for the centring to do nothing. Asserted on the body's own alignment, so
   * the two cases cannot diverge again.
   */
  it('starts the title at the top of the body rather than centring it', () => {
    const plain = item('task', { title: 'Single Task' });
    delete plain.recurrenceDescription;
    mount(
      <AgendaRow item={plain} showTime onOpen={() => {}} onToggleComplete={() => {}} />,
    );

    expect(screen.getByTestId('agenda-row-body').style.justifyContent).toBe('flex-start');
  });

  /** The chip takes the rail on an untimed row, which is the only time it renders there. */
  it('lifts the overdue chip onto the same line', () => {
    const overdue = item('task', { overdueFromDate: '2026-08-04' });
    delete overdue.time;
    mount(
      <AgendaRow
        item={overdue}
        today="2026-08-06"
        showTime
        onOpen={() => {}}
        onToggleComplete={() => {}}
      />,
    );

    const leadingLift = liftOf(screen.getByTestId('agenda-row-leading'), 'marginTop');
    const chipTop = liftOf(
      screen.getByTestId('agenda-badge-overdue').parentElement as HTMLElement,
      'top',
    );

    expect(chipTop + leadingLift).toBeCloseTo(space[4], 1);
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
    /**
     * Still `item.hasCheckbox` and still never `type` — P2-50 only adds the pending gate, and
     * the gate is named here so the guard documents both facts rather than being loosened to
     * a substring that would also pass for a type-derived checkbox.
     */
    expect(rowSource).toContain('hasCheckbox={item.hasCheckbox && !pendingCreate}');
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

/**
 * A skipped row says so (founder, 2026-08-15). `Show skipped` renders these in EARLIER TODAY
 * "de-emphasised" (`today-and-tasks.md` §3.2), and de-emphasis was all they had: a skipped row
 * and a merely past one were both 0.62 opacity and nothing else.
 *
 * **The opacity is gone as of 2026-08-17.** `interaction-contract.md` §6.4 requires de-emphasis
 * "with weight and size, not by dropping contrast below the threshold", and 0.62 did the second
 * thing — it took a `textSecondary` subtitle from 4.77:1 to roughly 3.3:1 on every resolved row.
 * The row now recedes through its title's weight and ink instead, which is both quieter and
 * compliant, so that is what these assert.
 */
describe('AgendaRow — the skipped tag', () => {
  it.each(['skipped', 'skipped_occurrence'] as const)(
    'tags a %s row and keeps it de-emphasised',
    (status) => {
      mount(<AgendaRow item={item('task', { status })} showTime onOpen={() => {}} />);

      expect(screen.getByTestId('agenda-row-skipped').textContent).toBe('Skipped');
      expect(screen.getByTestId(/^agenda-row-act_/).style.opacity).toBe('');
      expect(screen.getByText('Evening plan').style.color).toBe(
        cssColor(colors.light.textMuted),
      );
    },
  );

  it('says nothing on a row that is merely past', () => {
    mount(<AgendaRow item={item('task', { isPast: true })} showTime onOpen={() => {}} />);

    expect(screen.queryByTestId('agenda-row-skipped')).toBeNull();
  });

  /** Dimming is not a state a screen reader can hear. */
  it('speaks the state as well as showing it', () => {
    mount(
      <AgendaRow item={item('task', { status: 'skipped' })} showTime onOpen={() => {}} />,
    );

    expect(screen.getByTestId('agenda-row-body').getAttribute('aria-label')).toContain(
      'Skipped',
    );
  });
});

/**
 * A row whose create has not been acknowledged (P2-50, §5.4).
 *
 * These are **capability probes, not style probes**: the assertion is that the control does
 * not exist, because a server-directed action against an entity the server has never seen
 * has nowhere to go. A disabled-but-present checkbox would pass a style probe and still be
 * wrong.
 */
describe('a pending row', () => {
  const PENDING_ID = 'act_01J0000000000000000000000P';

  function memoryStorage(): IntentLogStorage {
    const data = new Map<string, string>();
    return {
      getItem: async (key) => data.get(key) ?? null,
      setItem: async (key, value) => {
        data.set(key, value);
      },
      removeItem: async (key) => {
        data.delete(key);
      },
    };
  }

  async function pendingLog(mutation: string, entityId = PENDING_ID) {
    const log = new IntentLog('usr_01J0000000000000000000000A', memoryStorage());
    await log.hydrate();
    await log.append({
      intentId: `intent-${mutation}`,
      mutationKey: ['activity', mutation],
      variables: { input: { activityId: entityId } },
      entityId,
    });
    return log;
  }

  afterEach(() => setActiveIntentLog(undefined));

  it('offers no checkbox at all while its create is unacknowledged', async () => {
    setActiveIntentLog(await pendingLog('create'));
    mount(
      <AgendaRow
        item={item('task', { activityId: PENDING_ID })}
        onOpen={vi.fn()}
        onToggleComplete={vi.fn()}
      />,
    );

    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says why in words, so the absence is explained rather than guessed at', async () => {
    setActiveIntentLog(await pendingLog('create'));
    mount(
      <AgendaRow
        item={item('task', { activityId: PENDING_ID })}
        onOpen={vi.fn()}
        onToggleComplete={vi.fn()}
      />,
    );

    expect(screen.getByTestId('pending-indicator').textContent).toBe('Pending');
  });

  it('keeps the checkbox when only a completion is queued', async () => {
    /**
     * The distinction §5.4 turns on. This activity exists on the server; a queued completion
     * says nothing about whether it can be acted on, and freezing it would break every
     * offline tick.
     */
    setActiveIntentLog(await pendingLog('complete'));
    mount(
      <AgendaRow
        item={item('task', { activityId: PENDING_ID })}
        onOpen={vi.fn()}
        onToggleComplete={vi.fn()}
      />,
    );

    expect(screen.queryByRole('checkbox')).not.toBeNull();
  });

  it('returns to normal on acknowledgement, without a remount', async () => {
    const log = await pendingLog('create');
    setActiveIntentLog(log);
    mount(
      <AgendaRow
        item={item('task', { activityId: PENDING_ID })}
        onOpen={vi.fn()}
        onToggleComplete={vi.fn()}
      />,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();

    // The 201 lands. The row is subscribed to the log, so it re-renders in place.
    await act(async () => {
      await log.acknowledge('intent-create');
    });

    expect(screen.queryByRole('checkbox')).not.toBeNull();
    expect(screen.queryByTestId('pending-indicator')).toBeNull();
  });
});
