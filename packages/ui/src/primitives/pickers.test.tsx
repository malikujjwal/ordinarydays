import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme/ThemeProvider';
import { layout } from '../theme/tokens';
import { DatePicker } from './DatePicker';
import { TimePicker } from './TimePicker';

/**
 * `DatePicker` and `TimePicker` (`design-system.md` §6, `activities.md` §3.4).
 *
 * Everything here runs against the **web** fork of `pickerSurface`, which is what
 * `vitest.config.ts` resolves and what the browser actually loads. The native wheel is a
 * platform view with nothing for jsdom to render; it is asserted by Maestro on the simulator
 * (P1-29). The one thing this file does check about the native fork is that it exports the
 * same surface — see the last block.
 *
 * 2026-08-11 is a Tuesday throughout.
 */
const TODAY = '2026-08-11';

const wrap = (ui: ReactNode) =>
  render(<ThemeProvider scheme="light">{ui}</ThemeProvider>);

describe('DatePicker', () => {
  it('renders the five quick chips, with the exact copy and order of activities.md §3.4', () => {
    wrap(<DatePicker label="Date" value={null} onChange={() => {}} today={TODAY} />);

    expect(
      screen.getAllByRole('button').map((element) => element.getAttribute('aria-label')),
    ).toEqual(['Today', 'Tomorrow', 'This weekend', 'Next week', 'Pick a date']);
  });

  it('a chip writes the date it names, and nothing before it is tapped', () => {
    const onChange = vi.fn();
    wrap(<DatePicker label="Date" value={null} onChange={onChange} today={TODAY} />);

    expect(onChange).not.toHaveBeenCalled();

    screen.getByRole('button', { name: 'Tomorrow' }).click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-08-12');
  });

  it('shows which chip the current value corresponds to', () => {
    wrap(
      <DatePicker label="Date" value="2026-08-15" onChange={() => {}} today={TODAY} />,
    );

    expect(
      screen.getByRole('button', { name: 'This weekend' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Today' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  /**
   * A date the chips cannot express — chosen from the calendar — still leaves the row looking
   * touched, by selecting `Pick a date`. Otherwise the whole control reads as empty while
   * carrying a value.
   */
  it('falls back to Pick a date for a value no chip accounts for', () => {
    wrap(
      <DatePicker label="Date" value="2026-11-03" onChange={() => {}} today={TODAY} />,
    );

    expect(
      screen.getByRole('button', { name: 'Pick a date' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('renders the chosen date and clears it to null, never to a substitute date', () => {
    const onChange = vi.fn();
    wrap(
      <DatePicker label="Date" value="2026-08-08" onChange={onChange} today={TODAY} />,
    );

    expect(screen.getByText('Sat, Aug 8')).toBeDefined();

    screen.getByRole('button', { name: 'Clear Date' }).click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('has no clear affordance while there is nothing to clear', () => {
    wrap(<DatePicker label="Date" value={null} onChange={() => {}} today={TODAY} />);
    expect(screen.queryByRole('button', { name: 'Clear Date' })).toBeNull();
  });

  it('opens the calendar only when Pick a date is tapped, and writes what it returns', () => {
    const onChange = vi.fn();
    wrap(<DatePicker label="Date" value={null} onChange={onChange} today={TODAY} />);

    expect(screen.queryByLabelText('Date')).toBeNull();

    // `fireEvent`, not `.click()`: opening the sheet is a state change, and only the
    // act-wrapped helper flushes the re-render this assertion then reads.
    fireEvent.click(screen.getByRole('button', { name: 'Pick a date' }));

    const calendar = screen.getByLabelText('Date');
    fireEvent.change(calendar, { target: { value: '2026-11-03' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-11-03');
  });

  /**
   * Out of the caller's window the chip does nothing rather than writing the nearest legal
   * date. Clamping would put a date on the activity that the user did not choose — the same
   * failure as inferring one, wearing a helpful hat.
   */
  it('a chip outside min/max is inert rather than clamped', () => {
    const onChange = vi.fn();
    wrap(
      <DatePicker
        label="Date"
        value={null}
        onChange={onChange}
        today={TODAY}
        min="2026-08-14"
      />,
    );

    screen.getByRole('button', { name: 'Today' }).click();
    expect(onChange).not.toHaveBeenCalled();

    screen.getByRole('button', { name: 'This weekend' }).click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-08-15');
  });

  it('fires nothing while disabled', () => {
    const onChange = vi.fn();
    wrap(
      <DatePicker label="Date" value={null} onChange={onChange} today={TODAY} disabled />,
    );

    screen.getByRole('button', { name: 'Today' }).click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('honours a caller that offers fewer chips', () => {
    wrap(
      <DatePicker
        label="Date"
        value={null}
        onChange={() => {}}
        today={TODAY}
        quickOptions={['today', 'tomorrow']}
      />,
    );

    expect(screen.getAllByRole('button')).toHaveLength(2);
  });
});

describe('TimePicker', () => {
  it('invites a time when there is none, and shows it once there is', () => {
    const { unmount } = wrap(
      <TimePicker label="Time" value={null} onChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Set a time' })).toBeDefined();
    unmount();

    wrap(<TimePicker label="Time" value="19:30" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: '7:30 PM' })).toBeDefined();
  });

  it('opens the wheel in 5-minute steps and writes what it returns', () => {
    const onChange = vi.fn();
    wrap(<TimePicker label="Time" value={null} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Set a time' }));

    const wheel = screen.getByLabelText('Time');
    expect(wheel.getAttribute('step')).toBe('300');

    fireEvent.change(wheel, { target: { value: '19:30' } });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('19:30');
  });

  /** Cleared means all-day. What the screen calls that is the screen's business. */
  it('clears to null', () => {
    const onChange = vi.fn();
    wrap(<TimePicker label="Time" value="19:30" onChange={onChange} />);

    screen.getByRole('button', { name: 'Clear Time' }).click();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('hides the clear affordance when the caller forbids it', () => {
    wrap(
      <TimePicker label="Time" value="19:30" onChange={() => {}} allowClear={false} />,
    );
    expect(screen.queryByRole('button', { name: 'Clear Time' })).toBeNull();
  });

  /**
   * The form disables Time until a date is set (`activities.md` §3.4). The picker does not go
   * looking for a sibling date field — it is told.
   */
  it('fires nothing while disabled', () => {
    const onChange = vi.fn();
    wrap(<TimePicker label="Time" value="19:30" onChange={onChange} disabled />);

    screen.getByRole('button', { name: 'Clear Time' }).click();
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * Both pickers are built from `Chip` and `IconButton`, which enforce the target through
 * `Touchable` — so this asserts the composition kept it rather than re-testing `Touchable`.
 */
describe('hit targets are at least 44 × 44', () => {
  it.each(['Today', 'Pick a date'])('the %s chip', (name) => {
    wrap(<DatePicker label="Date" value={null} onChange={() => {}} today={TODAY} />);
    const style = getComputedStyle(screen.getByRole('button', { name }));
    expect(Number.parseInt(style.minHeight, 10)).toBeGreaterThanOrEqual(layout.hitTarget);
  });

  it('the clear button', () => {
    wrap(
      <DatePicker label="Date" value="2026-08-08" onChange={() => {}} today={TODAY} />,
    );
    const style = getComputedStyle(screen.getByRole('button', { name: 'Clear Date' }));
    expect(Number.parseInt(style.minHeight, 10)).toBeGreaterThanOrEqual(layout.hitTarget);
    expect(Number.parseInt(style.minWidth, 10)).toBeGreaterThanOrEqual(layout.hitTarget);
  });
});

/**
 * `coding-standards.md` §8.6: every fork exports the same names with the same signatures, and
 * a test asserts the export sets match. Without it, a prop added to the web surface renders on
 * web and is silently dropped on iOS — the exact divergence roadmap §8 R4 is about.
 *
 * Loaded through `import.meta.glob` rather than two `import` statements because the config
 * resolves an extensionless specifier to the `.web.tsx` fork, so `'./pickerSurface'` cannot
 * name the native one. The glob keys are real paths and can.
 */
describe('the platform fork', () => {
  const modules = import.meta.glob('./pickerSurface*.tsx', { eager: true }) as Record<
    string,
    Record<string, unknown>
  >;

  const exportsOf = (path: string): string[] => {
    const found = modules[path];
    if (found === undefined) throw new Error(`${path} was not loaded`);
    return Object.keys(found).sort();
  };

  it('exports the same names from both files', () => {
    expect(exportsOf('./pickerSurface.tsx')).toEqual(['DateSurface', 'TimeSurface']);
    expect(exportsOf('./pickerSurface.web.tsx')).toEqual(
      exportsOf('./pickerSurface.tsx'),
    );
  });
});
