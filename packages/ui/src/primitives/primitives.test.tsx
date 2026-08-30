import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AccessibilityInfo, Animated } from 'react-native';
import { describe, expect, it, vi } from 'vitest';
import { Bowl, Plus } from '../icons/index';
import { ThemeProvider } from '../theme/ThemeProvider';
import { layout } from '../theme/tokens';
import { Avatar, AvatarStack, initialsOf } from './Avatar';
import { Button } from './Button';
import { Card } from './Card';
import { Checkbox } from './Checkbox';
import { Chip } from './Chip';
import { EmptyState, SectionHeader, Skeleton, Toast } from './Feedback';
import { Field } from './Field';
import { IconButton } from './IconButton';
import { IconTile } from './IconTile';
import { ProgressBar } from './ProgressBar';
import { Row } from './Row';
import { SegmentedControl } from './SegmentedControl';
import { Text } from './Text';
import { Touchable } from './Touchable';

/**
 * `definition-of-done.md` §3 sets the bar for `packages/ui` in behaviour rather than
 * percentage: **each primitive renders, each interactive one gets one interaction test and
 * one accessibility assertion.**
 *
 * Queries are by role and accessible name throughout — `testing.md` §5 says `getByTestId`
 * should be necessary nowhere, and a suite that reached for it would be hiding exactly the
 * problem these tests exist to catch.
 */
const wrap = (ui: ReactNode) =>
  render(<ThemeProvider scheme="light">{ui}</ThemeProvider>);

describe('every primitive renders', () => {
  it('Text', () => {
    wrap(<Text>Buy milk</Text>);
    expect(screen.getByText('Buy milk')).toBeDefined();
  });

  it('Button', () => {
    wrap(<Button label="Save task" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Save task' })).toBeDefined();
  });

  it('Button can announce the result behind shorthand copy', () => {
    wrap(
      <Button
        label="15 minutes"
        accessibilityLabel="Snooze until 3:25 PM"
        onPress={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Snooze until 3:25 PM' })).toBeDefined();
  });

  it('Touchable preserves its focus ring while forwarding focus callbacks', () => {
    const onFocus = vi.fn();
    const onBlur = vi.fn();
    wrap(
      <Touchable accessibilityRole="button" onFocus={onFocus} onBlur={onBlur}>
        <Text>Move</Text>
      </Touchable>,
    );
    const control = screen.getByRole('button', { name: 'Move' });

    fireEvent.focus(control);
    expect(onFocus).toHaveBeenCalledOnce();
    expect(control.getAttribute('style')).toContain('outline-width: 2px');
    fireEvent.blur(control);
    expect(onBlur).toHaveBeenCalledOnce();
  });

  it('IconButton', () => {
    wrap(<IconButton icon={Plus} label="Add" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Add' })).toBeDefined();
  });

  it('IconButton keeps its accessible name when it carries the accent tone', () => {
    wrap(<IconButton icon={Plus} label="Back" tone="accent" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Back' })).toBeDefined();
  });

  it('Row', () => {
    wrap(<Row title="Gym" subtitle="6:00 PM" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Gym' })).toBeDefined();
    expect(screen.getByText('6:00 PM')).toBeDefined();
  });

  it('Card', () => {
    wrap(
      <Card>
        <Text>Dinner at Zahav</Text>
      </Card>,
    );
    expect(screen.getByText('Dinner at Zahav')).toBeDefined();
  });

  it('Card resolves a collection surface through the theme', () => {
    wrap(
      <Card surfaceTone="collectionRose" testID="collection-card">
        <Text>Groceries</Text>
      </Card>,
    );
    expect(screen.getByTestId('collection-card').getAttribute('style')).toContain(
      'background-color: rgb(242, 223, 226)',
    );
  });

  it('IconTile', () => {
    wrap(<IconTile icon={Bowl} tint="meal" testID="tile" />);
    expect(screen.getByTestId('tile')).toBeDefined();
  });

  it('SegmentedControl', () => {
    wrap(
      <SegmentedControl
        segments={[{ label: 'Needs a date', count: 2 }, { label: 'Upcoming' }]}
        selectedIndex={0}
      />,
    );
    expect(screen.getByRole('tab', { name: 'Needs a date, 2' })).toBeDefined();
  });

  it('ProgressBar', () => {
    wrap(<ProgressBar value={0.5} label="2 of 4 done" />);
    expect(screen.getByRole('progressbar', { name: '2 of 4 done' })).toBeDefined();
  });

  it('Checkbox', () => {
    wrap(<Checkbox checked={false} label="Gym" />);
    expect(screen.getByRole('checkbox', { name: 'Gym' })).toBeDefined();
  });

  it('Field', () => {
    wrap(<Field label="Title" value="" onChangeText={() => {}} />);
    expect(screen.getByLabelText('Title')).toBeDefined();
  });

  it('keeps optionality in the label row instead of the placeholder', () => {
    wrap(<Field label="Note" value="" optional multiline />);

    expect(screen.getByLabelText('Note').getAttribute('placeholder')).toBeNull();
    expect(screen.getByText('Optional')).toBeDefined();
  });

  it('keeps bare multiline content compact without shrinking boxed form fields', () => {
    wrap(
      <>
        <Field label="Notes" value="" multiline appearance="bare" />
        <Field label="Description" value="" multiline />
      </>,
    );

    expect(
      Number.parseInt(getComputedStyle(screen.getByLabelText('Notes')).minHeight, 10),
    ).toBe(layout.hitTarget);
    expect(
      Number.parseInt(
        getComputedStyle(screen.getByLabelText('Description')).minHeight,
        10,
      ),
    ).toBe(96);
  });

  it('Chip', () => {
    wrap(<Chip label="From screenshot" />);
    const chip = screen.getByText('From screenshot');
    expect(chip).toBeDefined();
    expect(chip.closest('[aria-label]')).toBeNull();
  });

  it('Avatar and AvatarStack', () => {
    wrap(<Avatar displayName="Alex Rivera" />);
    expect(screen.getByLabelText('Alex Rivera')).toBeDefined();
  });

  /**
   * The accessible name is `Up next`, **not** `UP NEXT`: the caption variant uppercases
   * through CSS `textTransform`, which is presentation and never reaches the accessibility
   * tree. A screen reader should say "Up next", not spell the letters — so this asserts the
   * name a user hears rather than the one they see.
   */
  it('SectionHeader', () => {
    wrap(<SectionHeader title="Up next" />);
    expect(screen.getByRole('heading', { name: 'Up next' })).toBeDefined();
  });

  it('EmptyState', () => {
    wrap(<EmptyState heading="Nothing today" body="Add something when you decide." />);
    expect(screen.getByText('Nothing today')).toBeDefined();
  });

  it('Toast', () => {
    wrap(
      <Toast message="Task completed" action={{ label: 'Undo', onPress: () => {} }} />,
    );
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDefined();
  });

  it('renders an API request id as selectable support text', () => {
    wrap(<Toast message="Could not save" tone="error" requestId="req_toast" />);

    const requestId = screen.getByText('req_toast');
    expect(requestId.textContent).toBe('req_toast');
    expect(requestId.getAttribute('user-select')).not.toBe('none');
  });

  it('Skeleton', () => {
    wrap(<Skeleton shape="row" count={2} />);
    expect(screen.getByRole('progressbar', { name: 'Loading' })).toBeDefined();
  });
});

/**
 * The rule that has to hold on every interactive primitive: **44 × 44 minimum, whatever the
 * visual size**. `Checkbox` is the one that would fail it naturally — its visual is 24 — so
 * it is the one worth asserting hardest.
 */
describe('hit targets are at least 44 × 44', () => {
  it.each([
    ['Button', <Button key="b" label="Save" onPress={() => {}} />, 'Save'],
    [
      'IconButton',
      <IconButton key="i" icon={Plus} label="Add" onPress={() => {}} />,
      'Add',
    ],
  ])('%s', (_name, ui, name) => {
    wrap(ui);
    const style = getComputedStyle(screen.getByRole('button', { name }));
    expect(Number.parseInt(style.minHeight, 10)).toBeGreaterThanOrEqual(layout.hitTarget);
  });

  it('Checkbox, whose visual is only 24', () => {
    wrap(<Checkbox checked={false} label="Gym" />);
    const style = getComputedStyle(screen.getByRole('checkbox', { name: 'Gym' }));
    expect(Number.parseInt(style.minHeight, 10)).toBeGreaterThanOrEqual(layout.hitTarget);
    expect(Number.parseInt(style.minWidth, 10)).toBeGreaterThanOrEqual(layout.hitTarget);
  });
});

describe('interaction', () => {
  it('Button fires, and does not when disabled', () => {
    const onPress = vi.fn();
    const { unmount } = wrap(<Button label="Save" onPress={onPress} />);
    screen.getByRole('button', { name: 'Save' }).click();
    expect(onPress).toHaveBeenCalledOnce();
    unmount();

    const onPressDisabled = vi.fn();
    wrap(<Button label="Save" onPress={onPressDisabled} disabled />);
    screen.getByRole('button', { name: 'Save' }).click();
    expect(onPressDisabled).not.toHaveBeenCalled();
  });

  it('Checkbox toggles and announces its state', () => {
    const onChange = vi.fn();
    wrap(<Checkbox checked={false} label="Gym" onChange={onChange} />);

    const box = screen.getByRole('checkbox', { name: 'Gym' });
    expect(box.getAttribute('aria-checked')).toBe('false');

    box.click();
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('animates only a changed committed Checkbox value with the fast motion token', () => {
    const timing = vi.spyOn(Animated, 'timing');
    const mounted = wrap(<Checkbox checked={false} label="Gym" testID="gym-check" />);
    timing.mockClear();

    mounted.rerender(
      <ThemeProvider scheme="light">
        <Checkbox checked label="Gym" testID="gym-check" />
      </ThemeProvider>,
    );

    expect(timing).toHaveBeenCalledTimes(2);
    expect(timing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ duration: 120, useNativeDriver: true }),
    );
    timing.mockRestore();
  });

  it('settles a changed Checkbox instantly when Reduce Motion is enabled', async () => {
    const reduceMotion = vi
      .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
      .mockResolvedValue(true);
    const timing = vi.spyOn(Animated, 'timing');
    const mounted = wrap(<Checkbox checked={false} label="Gym" />);
    await act(async () => undefined);
    timing.mockClear();

    mounted.rerender(
      <ThemeProvider scheme="light">
        <Checkbox checked label="Gym" />
      </ThemeProvider>,
    );

    expect(timing).not.toHaveBeenCalled();
    timing.mockRestore();
    reduceMotion.mockRestore();
  });

  it('shares one Reduce Motion listener across a list of Checkboxes', () => {
    const addListener = vi.spyOn(AccessibilityInfo, 'addEventListener');
    wrap(
      <>
        <Checkbox checked={false} label="First task" />
        <Checkbox checked={false} label="Second task" />
      </>,
    );

    expect(addListener).toHaveBeenCalledOnce();
    addListener.mockRestore();
  });

  it('SegmentedControl reports which tab is selected', () => {
    const onChange = vi.fn();
    wrap(
      <SegmentedControl
        segments={[{ label: 'Upcoming' }, { label: 'Past' }]}
        selectedIndex={0}
        onChange={onChange}
      />,
    );

    expect(
      screen.getByRole('tab', { name: 'Upcoming' }).getAttribute('aria-selected'),
    ).toBe('true');

    screen.getByRole('tab', { name: 'Past' }).click();
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('a Row body opens and never mutates — the checkbox is a separate target', () => {
    const onOpen = vi.fn();
    const onCheck = vi.fn();

    wrap(
      <Row
        title="Gym"
        onPress={onOpen}
        leading={
          <Checkbox checked={false} label="Gym, not completed" onChange={onCheck} />
        }
      />,
    );

    screen.getByRole('checkbox', { name: 'Gym, not completed' }).click();
    expect(onCheck).toHaveBeenCalledWith(true);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('accessibility details that are easy to get wrong', () => {
  /** Its meaning is already in the row's label; announcing "bowl" adds noise. */
  it('IconTile is hidden from assistive tech', () => {
    wrap(<IconTile icon={Bowl} tint="meal" testID="tile" />);
    expect(screen.getByTestId('tile').getAttribute('aria-hidden')).toBe('true');
  });

  it('ProgressBar reports its value, not just a bar', () => {
    wrap(<ProgressBar value={0.5} label="2 of 4 done" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
  });

  it('ProgressBar clamps a NaN from done / total at zero', () => {
    wrap(<ProgressBar value={Number.NaN} label="0 of 0 done" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  /**
   * Colour is never the only carrier of meaning (`design-system.md` §5.1). Two things carry
   * a field error besides the red border: the input is marked invalid, and the message is
   * real rendered text a screen reader reaches — not a `title` attribute or a tooltip.
   */
  it('a Field surfaces its error to assistive tech, not only in red', () => {
    wrap(
      <Field
        label="Title"
        value=""
        onChangeText={() => {}}
        error="A title is required"
      />,
    );

    expect(screen.getByLabelText('Title').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('A title is required')).toBeDefined();
  });

  /**
   * A selected filter chip has to say so, not just look so (`design-system.md` §5.1). React
   * Native Web drops `accessibilityState.selected` on `role="button"`, so `Chip` states it as
   * `aria-pressed` — the attribute ARIA gives a toggle button — as well.
   */
  it('a selected Chip announces its state, not only its accent fill', () => {
    wrap(<Chip label="Personal" selected onPress={() => {}} />);
    expect(
      screen.getByRole('button', { name: 'Personal' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('AvatarStack names everyone once, rather than four focus stops', () => {
    wrap(
      <AvatarStack
        people={[{ displayName: 'Alex Rivera' }, { displayName: 'Sarah Mendes' }]}
      />,
    );
    expect(screen.getByLabelText('Alex Rivera, Sarah Mendes')).toBeDefined();
  });

  it('Toast is a polite live region, so it never steals focus', () => {
    wrap(
      <Toast message="Task completed" action={{ label: 'Undo', onPress: () => {} }} />,
    );
    expect(screen.getByRole('alert').getAttribute('aria-live')).toBe('polite');
    expect(
      screen.getByRole('button', { name: 'Undo' }).getAttribute('tabindex'),
    ).not.toBe('-1');
  });
});

/**
 * The two-line clamp belongs to the **row-title role**, not to one variant name. It was written
 * against `body` alone, so moving the agenda row's title to `bodyStrong` silently dropped it and
 * long titles ran to four lines — `interaction-contract.md` §6.1 allows two. Both are asserted so
 * the next variant switch fails here rather than on screen.
 */
describe('row titles clamp to two lines', () => {
  it.each(['body', 'bodyStrong'] as const)('%s clamps by default', (variant) => {
    wrap(<Text variant={variant}>A title long enough to wrap several times over</Text>);
    expect(screen.getByText(/A title long enough/).style.webkitLineClamp).toBe('2');
  });

  it('lets a caller override it', () => {
    wrap(
      <Text variant="bodyStrong" numberOfLines={1}>
        Single line only
      </Text>,
    );
    /**
     * React Native Web renders a single line through a class rather than an inline
     * `-webkit-line-clamp`, so what is checkable here is that the two-line default did **not**
     * win. That is the property worth pinning: an explicit `numberOfLines` is honoured.
     */
    expect(screen.getByText('Single line only').style.webkitLineClamp).not.toBe('2');
  });

  it('leaves a subtitle unclamped', () => {
    wrap(<Text variant="footnote">Meal · Dinner</Text>);
    expect(screen.getByText('Meal · Dinner').style.webkitLineClamp).toBe('');
  });
});

describe('initials', () => {
  it.each([
    ['Alex Rivera', 'AR'],
    ['Mika', 'M'],
    ['  sarah   mendes  ', 'SM'],
    ['Ujjwal Malik Singh', 'UM'],
  ])('%s → %s', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });
});
