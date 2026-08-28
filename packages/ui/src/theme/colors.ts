/**
 * Semantic colour tokens (`design-system.md` §5.1).
 *
 * **Components never reference a hex value.** They reference a semantic token, and the token
 * resolves differently per scheme. That is the whole mechanism: there is no `isDark` branch
 * in any component, because there is nothing for one to choose between. `accentControl` exists
 * to keep that true — see its entry below.
 *
 * **Both palettes are founder-approved and reviewed (P2-40).** They are no longer a mock plus
 * a derived dark set: light is warm paper and dusty plum, dark is warm neutral with mulberry,
 * sage and ochre. Values are used exactly as supplied except where a contrast assertion made
 * that impossible, and every such case is marked inline with its measured ratio.
 *
 * Where a supplied value cannot carry text, the resolution is **semantic, not cosmetic**: the
 * value stays and its role narrows. `accent` is the clearest case — it is a fill, icon and
 * decoration colour in both schemes and never body copy.
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
  /** Fields, selects and native/web picker surfaces. */
  surfaceInput: string;
  surfaceSunken: string;
  scrim: string;

  textDisplay: string;
  textPrimary: string;
  textSecondary: string;
  /** Readable tertiary content: hints, placeholders, metadata. **Never a disabled state.** */
  textMuted: string;
  textDisabled: string;
  textInverse: string;
  /** Readable text actions: light accentDeep, dark textPrimary. */
  textAction: string;

  border: string;
  /** Decorative field and chip outline. Never the sole control boundary or focus indicator. */
  borderSubtle: string;
  borderStrong: string;

  /** Non-text fills, icons, progress and decoration. **Never body text.** */
  accent: string;
  accentDeep: string;
  accentSurface: string;
  /** The Up Next hero fill; separate from selected-row and chip surfaces. */
  upNextSurface: string;
  /** Decorative accent-surface outline. Never a control boundary. */
  accentBorder: string;
  /**
   * The filled primary control's surface, paired with `textInverse`.
   *
   * Light uses `accent` and dark uses `accentDeep`, because the dark `accent` cannot carry a
   * label at AA (4.00:1 against `textInverse`) while `accentDeep` can (4.87:1). That is a
   * per-scheme choice, and a component resolving it with an `isDark` branch would be the first
   * in the codebase and would break the mechanism described at the top of this file. So the
   * scheme difference lives here, in the palette, where every other scheme difference lives.
   */
  accentControl: string;

  /** Shared switch treatment; never chosen by a screen. */
  switchTrackOff: string;
  switchTrackOn: string;
  switchThumb: string;

  success: string;
  successSurface: string;
  warning: string;
  warningSurface: string;
  danger: string;

  focusRing: string;
}

const light: SemanticColors = {
  surface: '#F1EDE5',
  surfaceRaised: '#F8F5EF',
  surfaceRaised2: '#FCFAF6',
  surfaceOverlay: '#FCFAF6',
  surfaceInput: '#F0EBE3',
  surfaceSunken: '#ECE7DE',
  scrim: 'rgba(38,42,40,0.40)',

  textDisplay: '#292621',
  textPrimary: '#292621',
  textSecondary: '#6E675F',
  /** The supplied secondary ink, because the supplied muted `#978F84` is 2.7:1 — decoration. */
  textMuted: '#6E675F',
  textDisabled: '#978F84',
  textInverse: '#FFFDF9',
  textAction: '#795565',

  border: '#E1DAD0',
  borderSubtle: '#D3C9BC',
  borderStrong: '#6E675F',

  accent: '#8B6374',
  accentDeep: '#795565',
  accentSurface: '#EEE3E7',
  upNextSurface: '#FBF7F9',
  accentBorder: '#C7AAB6',
  accentControl: '#8B6374',
  switchTrackOff: '#6E675F',
  switchTrackOn: '#616F45',
  switchThumb: '#FFFDF9',

  /**
   * Darkened from the founder's `#667747` on the founder's decision (2026-08-12).
   *
   * Sage carries a money figure — `Owes you $42.50` (§5.1, §7.4) — so it is body text and owes
   * AA. Against the new warmer `surface` it measured **4.19:1**, and 4.49:1 on `surfaceRaised`;
   * the previous, lighter `#FBF9F3` background was what had been carrying it. `#616F45` is the
   * smallest change that clears both (4.65:1 and 4.99:1) and stays the same sage.
   *
   * The alternative — keeping the value and dropping colour from balance figures — was
   * considered and rejected: the figure is where the colour does its work.
   */
  success: '#616F45',
  successSurface: '#EDF0E2',
  warning: '#8A6520',
  warningSurface: '#F6F0E2',
  danger: '#B3261E',

  focusRing: '#795565',
};

const dark: SemanticColors = {
  surface: '#171613',
  surfaceRaised: '#211F1B',
  surfaceRaised2: '#292620',
  surfaceOverlay: '#292620',
  surfaceInput: '#1C1B18',
  surfaceSunken: '#1C1B18',
  scrim: 'rgba(0,0,0,0.60)',

  textDisplay: '#F4F0E8',
  textPrimary: '#F4F0E8',
  textSecondary: '#D0C9BE',
  textMuted: '#9F988D',
  /** Retained: unlisted safety semantics keep their existing dark values. */
  textDisabled: '#6E6C63',
  textInverse: '#171613',
  /**
   * **Mulberry, not white — founder decision, 2026-08-16 (P2-43).**
   *
   * This was `#F4F0E8`, which made `Back`, `Change` and every other text action in dark mode
   * indistinguishable from a heading; the founder's report was that they "should not be white
   * in color". `accentDeep` `#AD748C` is the natural candidate and the one the frames draw, but
   * it is 4.06:1 on `surfaceOverlay` — a text action inside a sheet would have missed the gate,
   * and P2-40's rule is that the gate is never lowered to make a colour pass.
   *
   * `#B58298` is that same mulberry lifted 10% toward white, which is the smallest change that
   * clears 4.5:1 on **every** dark surface a text action can land on: 5.70 on `surface`, 5.18 on
   * `surfaceRaised`, 4.75 on `surfaceOverlay`, 5.42 on `surfaceInput`, 4.91 on `accentSurface`.
   * Asserted across all five in `contrast.test.ts` rather than on the two §5.1 names, because
   * the reason this value exists is the surfaces the old rule did not cover.
   */
  textAction: '#B58298',

  border: '#34312B',
  /** The supplied border serves both roles in dark; there is no second dark outline value. */
  borderSubtle: '#34312B',
  borderStrong: '#9F988D',

  /**
   * 4.00:1 on `surface` and 3.70:1 on `surfaceRaised` — **deliberately not a text colour**.
   * Fills, icons, progress, focus and decoration only, which is what §5.1 restricts it to.
   */
  accent: '#9F667F',
  accentDeep: '#AD748C',
  accentSurface: '#2D2026',
  upNextSurface: '#292620',
  accentBorder: '#5A3A49',
  accentControl: '#AD748C',
  switchTrackOff: '#6E6C63',
  switchTrackOn: '#8DB9A2',
  switchThumb: '#F4F0E8',

  success: '#A7B690',
  successSurface: '#252A20',
  warning: '#E3C07A',
  warningSurface: '#332B1C',
  danger: '#F08579',

  focusRing: '#9F667F',
};

export const colors: Record<ColorScheme, SemanticColors> = { light, dark };

/**
 * One accent per stored activity type (`design-system.md` §5.2).
 *
 * Drawn from the refreshed families — mulberry, olive, ochre, rosewood, stone. **No blues.**
 * Used for a row's type marker, a card's icon squircle and the detail header tint; never as
 * a row background.
 */
export type ActivityTypeName = 'task' | 'meal' | 'watch' | 'event' | 'custom';

export interface TypeAccent {
  /** The glyph and marker colour. */
  accent: string;
  /** The squircle fill behind it. */
  surface: string;
}

export const typeAccents: Record<ColorScheme, Record<ActivityTypeName, TypeAccent>> = {
  light: {
    task: { accent: '#6E675F', surface: '#F0EBE3' },
    meal: { accent: '#8A6520', surface: '#F6F0E2' },
    /** The same sage as `success`, and darkened with it — one colour, not two. */
    watch: { accent: '#616F45', surface: '#EDF0E2' },
    event: { accent: '#8C4A5E', surface: '#EEE3E7' },
    custom: { accent: '#6E675F', surface: '#F0EBE3' },
  },
  dark: {
    task: { accent: '#9F988D', surface: '#1C1B18' },
    meal: { accent: '#E3C07A', surface: '#332B1C' },
    watch: { accent: '#A7B690', surface: '#252A20' },
    event: { accent: '#AD748C', surface: '#2D2026' },
    custom: { accent: '#9F988D', surface: '#1C1B18' },
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
  const names: ActivityTypeName[] = ['event', 'watch', 'meal', 'task', 'custom'];

  let hash = 0;
  for (let i = 0; i < displayName.length; i += 1) {
    hash = (hash * 31 + displayName.charCodeAt(i)) >>> 0;
  }

  const picked = palette[names[hash % names.length] as ActivityTypeName];
  return { background: picked.surface, foreground: picked.accent };
}
