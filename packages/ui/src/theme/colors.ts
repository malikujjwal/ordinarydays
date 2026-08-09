/**
 * Semantic colour tokens (`design-system.md` §5.1).
 *
 * **Components never reference a hex value.** They reference a semantic token, and the token
 * resolves differently per scheme. That is the whole mechanism: there is no `isDark` branch
 * in any component, because there is nothing for one to choose between.
 *
 * Light values come from the founder's design mock, contrast-checked; the two that failed AA
 * were nudged and are marked. **Dark values are derived, not designed** — same hues, inverted
 * value — and the P1-22 token gallery is where they get looked at by a human before any
 * screen is built on them.
 *
 * Every pair is asserted programmatically in `contrast.test.ts`, so a token change that
 * breaks AA fails CI rather than shipping.
 */

/** The scheme a surface is rendered in. */
export type ColorScheme = 'light' | 'dark';

export interface SemanticColors {
  surface: string;
  surfaceRaised: string;
  surfaceRaised2: string;
  surfaceOverlay: string;
  surfaceSunken: string;
  scrim: string;

  textDisplay: string;
  textPrimary: string;
  textSecondary: string;
  textDisabled: string;
  textInverse: string;

  border: string;
  borderStrong: string;

  accent: string;
  accentDeep: string;
  accentSurface: string;

  success: string;
  successSurface: string;
  warning: string;
  warningSurface: string;
  danger: string;

  focusRing: string;
}

const light: SemanticColors = {
  surface: '#FBF9F3',
  surfaceRaised: '#FFFFFF',
  surfaceRaised2: '#FFFFFF',
  surfaceOverlay: '#FFFFFF',
  /**
   * Nudged from the mock's `#F1EEE5`, which put `textSecondary` at 4.48:1 — a hair under AA.
   * This surface carries real text: the rail's active nav label (§8) and the inactive labels
   * on a `SegmentedControl` track (§6). At `#F3F0E8` that pair is 4.56:1.
   *
   * Found by the contrast gate in P1-22, which is the first thing to have measured this pair
   * — §5.1's stated promise covers `surface` and `surfaceRaised`, and `surfaceSunken` was
   * never checked against the text that sits on it.
   */
  surfaceSunken: '#F3F0E8',
  scrim: 'rgba(38,42,40,0.40)',

  textDisplay: '#252521',
  textPrimary: '#4A4841',
  /** Nudged from the mock's `#77756C`, which was 4.39:1 against `surface`. */
  textSecondary: '#6F6D63',
  textDisabled: '#9B988D',
  textInverse: '#FFFFFF',

  border: '#E5E2D9',
  borderStrong: '#6F6D63',

  accent: '#965D78',
  accentDeep: '#744158',
  accentSurface: '#F9F1F5',

  success: '#667747',
  successSurface: '#EDF0E2',
  warning: '#8A6520',
  warningSurface: '#F6F0E2',
  danger: '#B3261E',

  focusRing: '#965D78',
};

const dark: SemanticColors = {
  surface: '#151412',
  surfaceRaised: '#1F1E1B',
  surfaceRaised2: '#282722',
  surfaceOverlay: '#2E2D28',
  surfaceSunken: '#100F0D',
  scrim: 'rgba(0,0,0,0.60)',

  textDisplay: '#F0EEE8',
  textPrimary: '#E4E2DA',
  textSecondary: '#B0ADA2',
  textDisabled: '#6E6C63',
  textInverse: '#1B1A17',

  border: '#33322C',
  borderStrong: '#8A887E',

  accent: '#C9A3B7',
  accentDeep: '#D8A0BC',
  accentSurface: '#31242B',

  success: '#9DBA6E',
  successSurface: '#232A1C',
  warning: '#E0B25A',
  warningSurface: '#2A2317',
  danger: '#F08579',

  focusRing: '#C9A3B7',
};

export const colors: Record<ColorScheme, SemanticColors> = { light, dark };

/**
 * One accent per stored activity type (`design-system.md` §5.2).
 *
 * Drawn from the refreshed families — mulberry, olive, ochre, rosewood, stone. **No blues.**
 * Used for a row's type marker, a card's icon squircle and the detail header tint; never as
 * a row background.
 */
export type ActivityTypeName = 'task' | 'meal' | 'watch' | 'event' | 'outing' | 'custom';

export interface TypeAccent {
  /** The glyph and marker colour. */
  accent: string;
  /** The squircle fill behind it. */
  surface: string;
}

export const typeAccents: Record<ColorScheme, Record<ActivityTypeName, TypeAccent>> = {
  light: {
    task: { accent: '#6F6D63', surface: '#F1EEE5' },
    meal: { accent: '#8A6520', surface: '#F6F0E2' },
    watch: { accent: '#667747', surface: '#EDF0E2' },
    event: { accent: '#965D78', surface: '#F9F1F5' },
    outing: { accent: '#8C4A5E', surface: '#F9F1F5' },
    /**
     * 4.4:1 — **large-glyph only**, as the design system marks it. It is used for a 16 pt
     * marker and a 24 pt squircle glyph, never for body text, so it is exempt from the 4.5:1
     * body rule and meets the 3:1 large-text/graphics rule comfortably.
     */
    custom: { accent: '#77756C', surface: '#F1EEE5' },
  },
  dark: {
    task: { accent: '#B0ADA2', surface: '#100F0D' },
    meal: { accent: '#E0B25A', surface: '#2A2317' },
    watch: { accent: '#9DBA6E', surface: '#232A1C' },
    event: { accent: '#C9A3B7', surface: '#31242B' },
    outing: { accent: '#D8A0BC', surface: '#31242B' },
    custom: { accent: '#A8A599', surface: '#100F0D' },
  },
};

/**
 * A stable per-person tint for the `Avatar` initials fallback, drawn from the `*Surface`
 * family so a wall of avatars stays quiet.
 *
 * Stable rather than random: the same person is the same colour on every screen and every
 * launch, which is what makes an initials disc recognisable at all.
 */
export function avatarTint(
  displayName: string,
  scheme: ColorScheme,
): { background: string; foreground: string } {
  const palette = typeAccents[scheme];
  const names: ActivityTypeName[] = [
    'event',
    'watch',
    'meal',
    'outing',
    'task',
    'custom',
  ];

  let hash = 0;
  for (let i = 0; i < displayName.length; i += 1) {
    hash = (hash * 31 + displayName.charCodeAt(i)) >>> 0;
  }

  const picked = palette[names[hash % names.length] as ActivityTypeName];
  return { background: picked.surface, foreground: picked.accent };
}
