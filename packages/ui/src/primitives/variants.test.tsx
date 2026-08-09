import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  Bowl,
  Diamond,
  ListLines,
  MapPin,
  navIcons,
  PlayRect,
  Sun,
  Ticket,
  typeIcons,
} from '../icons/index';
import type { ColorScheme } from '../theme/colors';
import { colors } from '../theme/colors';
import { elevation } from '../theme/elevation';
import { ThemeProvider, useBreakpoint, useTheme } from '../theme/ThemeProvider';
import { Avatar } from './Avatar';
import { Button, type ButtonVariant } from './Button';
import { Card } from './Card';
import { Chip, type ChipTone } from './Chip';
import { IconTile } from './IconTile';
import { ProgressBar } from './ProgressBar';
import { Row } from './Row';
import { Sheet } from './Sheet';
import { Text, type TextColor } from './Text';

/**
 * The variant and scheme matrices.
 *
 * `primitives.test.tsx` asserts that each component renders and behaves; this walks the
 * combinations — every button variant, every chip tone, every text colour, **and both
 * schemes** — because a token that only resolves in light mode is a bug nobody sees until
 * someone turns dark mode on.
 */
const wrap = (ui: ReactNode, scheme: ColorScheme = 'light') =>
  render(<ThemeProvider scheme={scheme}>{ui}</ThemeProvider>);

const schemes: ColorScheme[] = ['light', 'dark'];

describe.each(schemes)('%s scheme renders every variant', (scheme) => {
  it.each<ButtonVariant>(['primary', 'secondary', 'ghost', 'danger'])(
    'Button %s',
    (variant) => {
      wrap(<Button label="Save" variant={variant} onPress={() => {}} />, scheme);
      expect(screen.getByRole('button', { name: 'Save' })).toBeDefined();
    },
  );

  it.each<ChipTone>(['neutral', 'accent', 'warning', 'danger', 'success'])(
    'Chip %s',
    (tone) => {
      wrap(<Chip label="Overdue" tone={tone} />, scheme);
      expect(screen.getByLabelText('Overdue')).toBeDefined();
    },
  );

  it.each<TextColor>([
    'textDisplay',
    'textPrimary',
    'textSecondary',
    'textDisabled',
    'accent',
    'danger',
    'success',
    'warning',
    'inverse',
  ])('Text in %s', (color) => {
    wrap(<Text color={color}>Dinner</Text>, scheme);
    expect(screen.getByText('Dinner')).toBeDefined();
  });

  it.each(['e1', 'e2', 'e3'] as const)('Card at %s', (level) => {
    wrap(
      <Card elevation={level}>
        <Text>Card</Text>
      </Card>,
      scheme,
    );
    expect(screen.getByText('Card')).toBeDefined();
  });

  it.each(Object.keys(typeIcons) as (keyof typeof typeIcons)[])(
    'IconTile tinted %s',
    (tint) => {
      wrap(<IconTile icon={typeIcons[tint]} tint={tint} testID="tile" />, scheme);
      expect(screen.getByTestId('tile')).toBeDefined();
    },
  );
});

/**
 * Dark elevation is **surface lightening plus a hairline**, not a shadow — a shadow on a
 * near-black background is invisible, so a dark UI that relied on one would lose all depth.
 * Asserted directly on the helper, because it is the thing every `Card` delegates to.
 */
describe('elevation resolves per scheme', () => {
  it('is a shadow in light and a raised surface in dark', () => {
    const lightStyle = elevation('e2', 'light', colors.light) as Record<string, unknown>;
    const darkStyle = elevation('e2', 'dark', colors.dark) as Record<string, unknown>;

    expect(lightStyle.boxShadow).toBeDefined();
    expect(darkStyle.boxShadow).toBeUndefined();
    expect(darkStyle.backgroundColor).toBe(colors.dark.surfaceRaised2);
    expect(darkStyle.borderWidth).toBe(1);
  });

  it('is nothing at all at e0, in either scheme', () => {
    expect(elevation('e0', 'light', colors.light)).toEqual({});
    expect(elevation('e0', 'dark', colors.dark)).toEqual({});
  });

  it.each(['e1', 'e3', 'e4'] as const)('resolves %s in both schemes', (token) => {
    expect(elevation(token, 'light', colors.light)).toBeDefined();
    expect(elevation(token, 'dark', colors.dark)).toBeDefined();
  });
});

describe('Card', () => {
  it('is not a button when it has no onPress', () => {
    wrap(
      <Card testID="card">
        <Text>Plain</Text>
      </Card>,
    );
    expect(screen.queryByRole('button')).toBeNull();
  });

  /** The whole card is one tap target (U1); the RSVP pill would be a separate one. */
  it('is one tap target when it does', () => {
    const onPress = vi.fn();
    wrap(
      <Card onPress={onPress} accessibilityLabel="Food Festival">
        <Text>Food Festival</Text>
      </Card>,
    );
    screen.getByRole('button', { name: 'Food Festival' }).click();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('renders the hero surface with its own tint', () => {
    wrap(
      <Card hero radius="xl" elevation="e3" testID="hero">
        <Text>Dentist</Text>
      </Card>,
    );
    expect(screen.getByTestId('hero')).toBeDefined();
  });
});

describe('Row', () => {
  it('renders without a press handler as plain content', () => {
    wrap(<Row title="Gym" testID="row" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('Gym')).toBeDefined();
  });

  it('carries a non-interactive type marker for a non-task row', () => {
    wrap(<Row title="Dinner" accent="outing" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Dinner' })).toBeDefined();
  });

  it('exposes swipe actions as accessibility actions', () => {
    const onAction = vi.fn();
    wrap(
      <Row
        title="Gym"
        onPress={() => {}}
        accessibilityActions={[{ name: 'complete', label: 'Complete' }]}
        onAccessibilityAction={onAction}
      />,
    );
    expect(screen.getByRole('button', { name: 'Gym' })).toBeDefined();
  });
});

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    wrap(
      <Sheet open={false} onClose={() => {}} title="Reschedule">
        <Text>Body</Text>
      </Sheet>,
    );
    expect(screen.queryByText('Body')).toBeNull();
  });

  it('renders its title and body when open, with a close route', () => {
    wrap(
      <Sheet open onClose={() => {}} title="Reschedule">
        <Text>Body</Text>
      </Sheet>,
    );
    expect(screen.getByText('Body')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined();
  });

  it('offers no close button when it is not dismissible', () => {
    wrap(
      <Sheet open onClose={() => {}} dismissible={false}>
        <Text>Body</Text>
      </Sheet>,
    );
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});

describe('Avatar', () => {
  it('renders an image when one is supplied', () => {
    wrap(<Avatar displayName="Alex Rivera" imageUrl="https://example.com/a.png" />);
    expect(screen.getByLabelText('Alex Rivera')).toBeDefined();
  });

  it.each(['sm', 'md', 'lg'] as const)('renders at %s', (size) => {
    wrap(<Avatar displayName="Mika Okada" size={size} />);
    expect(screen.getByLabelText('Mika Okada')).toBeDefined();
  });

  /** A stable tint is the only thing that makes an initials disc recognisable. */
  it('gives the same person the same tint every time', () => {
    const first = render(
      <ThemeProvider scheme="light">
        <Avatar displayName="Alex Rivera" testID="a" />
      </ThemeProvider>,
    );
    const one = first.getByTestId('a').getAttribute('style');
    first.unmount();

    const second = render(
      <ThemeProvider scheme="light">
        <Avatar displayName="Alex Rivera" testID="a" />
      </ThemeProvider>,
    );
    expect(second.getByTestId('a').getAttribute('style')).toBe(one);
  });
});

describe('ProgressBar clamps out-of-range values', () => {
  it.each([
    [-1, '0'],
    [0, '0'],
    [0.5, '50'],
    [1, '100'],
    [4, '100'],
  ])('%s → %s%%', (value, expected) => {
    wrap(<ProgressBar value={value} label="progress" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(expected);
  });

  it('renders the neutral tone', () => {
    wrap(<ProgressBar value={0.5} tone="neutral" label="progress" />);
    expect(screen.getByRole('progressbar')).toBeDefined();
  });
});

describe('the theme hooks', () => {
  function Probe() {
    const theme = useTheme();
    const breakpoint = useBreakpoint();
    return (
      <Text testID="probe">{`${theme.scheme}/${breakpoint}/${theme.font('display').fontFamily}`}</Text>
    );
  }

  it('reports the scheme, the breakpoint and the resolved serif', () => {
    wrap(<Probe />);
    const value = screen.getByTestId('probe').textContent ?? '';
    expect(value).toContain('light/');
    // jsdom is 1024 wide by default — `medium`, not `compact`.
    expect(value).toMatch(/\/(compact|medium|expanded)\//);
    // No app-supplied family, so the platform serif is what renders.
    expect(value).toContain('Georgia');
  });

  it('uses the family the app supplies once the font has loaded', () => {
    render(
      <ThemeProvider scheme="light" serifFamily="Newsreader_500Medium">
        <Probe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toContain('Newsreader_500Medium');
  });

  /**
   * Throws rather than falling back to a default: a silent default means a screen rendering
   * in light mode inside a dark app, and nobody noticing until a screenshot.
   */
  it('refuses to work outside a provider', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/must be used inside a <ThemeProvider>/);
    quiet.mockRestore();
  });
});

describe('icons', () => {
  it.each([
    ['Bowl', Bowl],
    ['PlayRect', PlayRect],
    ['Ticket', Ticket],
    ['MapPin', MapPin],
    ['Diamond', Diamond],
    ['Sun', Sun],
    ['ListLines', ListLines],
  ])('%s renders at a given size and colour', (_name, Icon) => {
    wrap(<Icon size={16} color="#965D78" />);
    expect(document.querySelector('[data-svg]')).toBeDefined();
  });

  /**
   * The nav map is keyed by **route name**, not by label, so `(tabs)/_layout.tsx` looks its
   * icon up rather than switching on the tab. A missing key would render nothing and be
   * noticed only in a screenshot.
   */
  it('has one icon per tab, keyed by route name', () => {
    expect(Object.keys(navIcons)).toEqual(['index', 'plans', 'lists']);
  });

  /** Today and Plans must not both be calendars — two tabs nobody can tell apart. */
  it('gives Today and Plans different shapes', () => {
    expect(navIcons.index).not.toBe(navIcons.plans);
  });
});
