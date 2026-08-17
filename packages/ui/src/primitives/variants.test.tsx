import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { describe, expect, it, vi } from 'vitest';
import {
  Bowl,
  Diamond,
  type IconProps,
  ListLines,
  MapPin,
  navIcons,
  PlayRect,
  Sun,
  typeIcons,
} from '../icons/index';
import type { ColorScheme } from '../theme/colors';
import { colors } from '../theme/colors';
import { elevation } from '../theme/elevation';
import { ThemeProvider, useBreakpoint, useTheme } from '../theme/ThemeProvider';
import { space } from '../theme/tokens';
import { Avatar } from './Avatar';
import { Button, type ButtonVariant } from './Button';
import { Card } from './Card';
import { Chip, type ChipTone } from './Chip';
import { IconButton } from './IconButton';
import { IconTile } from './IconTile';
import { ProgressBar } from './ProgressBar';
import { Row } from './Row';
import { ScreenShell } from './ScreenShell';
import { SettingRow } from './SettingRow';
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

const cssRgb = (hex: string): string => {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgb(${value >> 16}, ${(value >> 8) & 255}, ${value & 255})`;
};

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
      expect(screen.getByText('Overdue')).toBeDefined();
    },
  );

  it.each<TextColor>([
    'textDisplay',
    'textPrimary',
    'textSecondary',
    'textDisabled',
    'textAction',
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

describe.each(schemes)('%s scheme uses only readable action text', (scheme) => {
  it('gives a ghost button the semantic action-text token', () => {
    wrap(<Button label="Back" variant="ghost" />, scheme);

    expect(getComputedStyle(screen.getByText('Back')).color).toBe(
      cssRgb(colors[scheme].textAction),
    );
  });

  it('uses primary text on an accent-surface chip', () => {
    wrap(<Chip label="Tomorrow" tone="accent" />, scheme);

    expect(getComputedStyle(screen.getByText('Tomorrow')).color).toBe(
      cssRgb(colors[scheme].textPrimary),
    );
  });
});

describe.each(schemes)('%s scheme renders accent icon actions', (scheme) => {
  it('uses the semantic accent token', () => {
    const ColorProbe = ({ color }: IconProps) => <span data-color={color} />;
    wrap(<IconButton icon={ColorProbe} label="Back" tone="accent" />, scheme);

    expect(
      screen
        .getByRole('button', { name: 'Back' })
        .querySelector('[data-color]')
        ?.getAttribute('data-color'),
    ).toBe(colors[scheme].accent);
  });
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
    wrap(<Row title="Dinner" accent="event" onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'Dinner' })).toBeDefined();
  });

  /**
   * Two subtitle roles (P2-43). An agenda row's subtitle is the user's own data and §7.1 pins
   * it at `textSecondary`; a chooser row's is copy explaining the control, which §0 calls
   * information. In dark the difference is real — 11.01:1 against 6.33:1 — which is the
   * founder's report that the subtext read almost as loud as the label.
   */
  it.each(['light', 'dark'] as const)(
    '%s: content subtitles stay textSecondary',
    (scheme) => {
      wrap(
        <Row title="Chicken tacos" subtitle="Meal · Dinner" onPress={() => {}} />,
        scheme,
      );
      expect(getComputedStyle(screen.getByText('Meal · Dinner')).color).toBe(
        cssRgb(colors[scheme].textSecondary),
      );
    },
  );

  it.each(['light', 'dark'] as const)('%s: explanatory subtitles step down', (scheme) => {
    wrap(
      <Row
        title="Task"
        subtitle="Something you need to do"
        subtitleTone="explanatory"
        onPress={() => {}}
      />,
      scheme,
    );
    expect(getComputedStyle(screen.getByText('Something you need to do')).color).toBe(
      cssRgb(colors[scheme].textMuted),
    );
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

/**
 * The selected tint (P2-43). Two carriers, never one: the fill **and** the check, so the state
 * survives a user who cannot tell the two surfaces apart. The ink on the tint is asserted in
 * both schemes because light `textSecondary` measures 4.45:1 against `accentSurface` and must
 * step up to `textPrimary` there — the rule `design-system.md` §0 states and
 * `contrast.test.ts` pins.
 */
describe.each(schemes)('%s scheme — a selected SettingRow', (scheme) => {
  it('carries the accent tint and readable ink', () => {
    wrap(
      <SettingRow label="Tomorrow" value="Thu, Aug 13" selected onPress={() => {}} />,
      scheme,
    );

    const value = screen.getByText('Thu, Aug 13');
    expect(getComputedStyle(value).color).toBe(cssRgb(colors[scheme].textPrimary));
    expect(getComputedStyle(value.parentElement as HTMLElement).backgroundColor).toBe(
      cssRgb(colors[scheme].accentSurface),
    );
  });

  it('leaves an unselected row on the page surface, with its own ink', () => {
    wrap(<SettingRow label="Today" value="Wed, Aug 12" onPress={() => {}} />, scheme);

    const value = screen.getByText('Wed, Aug 12');
    expect(getComputedStyle(value).color).toBe(cssRgb(colors[scheme].textSecondary));
    expect(getComputedStyle(value.parentElement as HTMLElement).backgroundColor).toBe(
      'rgba(0, 0, 0, 0)',
    );
  });
});

/**
 * §0's affordance table, applied to the value slot (P2-43): accent text means an action. A row
 * that **opens** is offering to change the value beside it; a row that **commits** — the
 * reschedule sheet's date rows, which render no chevron — is only reporting one.
 */
describe.each(schemes)(
  '%s scheme — the value slot says whether it is editable',
  (scheme) => {
    it('inks the value of a row that opens as an action', () => {
      wrap(
        <SettingRow label="Repeat" value="Every 3 days" opens onPress={() => {}} />,
        scheme,
      );
      expect(getComputedStyle(screen.getByText('Every 3 days')).color).toBe(
        cssRgb(colors[scheme].textAction),
      );
    });

    it('leaves the value of a row that commits as a state report', () => {
      wrap(<SettingRow label="Today" value="Wed, Aug 12" onPress={() => {}} />, scheme);
      expect(getComputedStyle(screen.getByText('Wed, Aug 12')).color).toBe(
        cssRgb(colors[scheme].textSecondary),
      );
    });

    /** An inert row is not a control, so its value is never an action either. */
    it('leaves an inert row alone', () => {
      wrap(<SettingRow label="People" value="Coming later" opens />, scheme);
      expect(getComputedStyle(screen.getByText('Coming later')).color).toBe(
        cssRgb(colors[scheme].textSecondary),
      );
    });
  },
);

/**
 * `flush` (P2-43): the ghost button's invisible padding stops indenting its label out of the
 * text column, and becomes hit target reaching into the gutter instead. The 44 pt floor is why
 * the padding is offset rather than removed.
 */
describe('a flush ghost button', () => {
  it('offsets exactly its own horizontal padding', () => {
    wrap(<Button label="Back" variant="ghost" flush onPress={() => {}} />);
    const style = getComputedStyle(screen.getByRole('button', { name: 'Back' }));
    expect(style.paddingLeft).toBe(`${space[6]}px`);
    expect(style.marginLeft).toBe(`-${space[6]}px`);
    expect(style.minHeight).toBe('44px');
  });

  it('leaves an ordinary ghost button indented', () => {
    wrap(<Button label="Change" variant="ghost" onPress={() => {}} />);
    expect(
      getComputedStyle(screen.getByRole('button', { name: 'Change' })).marginLeft,
    ).toBe('0px');
  });
});

/**
 * The selected pill's rim (P2-43). Unselected pills carry the same width in transparent, so
 * choosing one does not move the row under the finger.
 */
describe.each(schemes)('%s scheme — a selected Chip', (scheme) => {
  it('rims the selected pill and reserves the width on the rest', () => {
    wrap(<Chip label="Tomorrow" selected onPress={() => {}} />, scheme);
    const selected = screen.getByText('Tomorrow').parentElement as HTMLElement;
    expect(getComputedStyle(selected).borderColor).toBe(
      cssRgb(colors[scheme].accentBorder),
    );
    expect(getComputedStyle(selected).borderWidth).toBe('1px');

    wrap(<Chip label="Today" onPress={() => {}} />, scheme);
    const plain = screen.getByText('Today').parentElement as HTMLElement;
    expect(getComputedStyle(plain).borderColor).toBe('rgba(0, 0, 0, 0)');
    expect(getComputedStyle(plain).borderWidth).toBe('1px');
  });
});

/**
 * `ScreenShell`'s footer slot (P2-43): the container owns where a named write sits, so no
 * screen has to answer it and answer it differently.
 */
describe('ScreenShell', () => {
  it('renders the footer outside the scrolling body', () => {
    wrap(
      <SafeAreaProvider>
        <ScreenShell
          testID="shell"
          footer={<Button label="Save task" onPress={() => {}} />}
        >
          <Text variant="body">A form</Text>
        </ScreenShell>
      </SafeAreaProvider>,
    );

    const save = screen.getByRole('button', { name: 'Save task' });
    expect(screen.getByTestId('shell-footer').contains(save)).toBe(true);
    expect(screen.getByTestId('shell-body').contains(save)).toBe(false);
  });

  it('renders no footer chrome when a screen supplies none', () => {
    wrap(
      <SafeAreaProvider>
        <ScreenShell testID="shell">
          <Text variant="body">A list</Text>
        </ScreenShell>
      </SafeAreaProvider>,
    );

    expect(screen.queryByTestId('shell-footer')).toBeNull();
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
    const modal = document.querySelector('[aria-modal="true"]');
    expect(modal?.getAttribute('aria-label')).toBe('Reschedule');
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
