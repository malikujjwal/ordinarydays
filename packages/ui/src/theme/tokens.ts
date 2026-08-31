/**
 * The scalar tokens: spacing, type, radius, motion, layout (`design-system.md` §2–§4, §9).
 *
 * > **No screen, component, or style introduces a colour, spacing value, radius, font size,
 * > shadow, or duration that is not in this document.** (§10)
 *
 * If a design genuinely needs a value that is not here, it is added here in the same PR with
 * a one-line reason — never written inline "just this once". That is how a token system dies.
 */

/**
 * A 4-point base. Every margin, padding and gap in the product is one of these; there are no
 * intermediate values.
 */
export const space = {
  0: 0,
  1: 2, // hairline separation, icon-to-text nudges
  2: 4, // inside a chip, between stacked metadata lines
  3: 8, // minimum gap between adjacent hit targets
  4: 12, // between a row's leading control and its title
  5: 16, // standard horizontal screen gutter, standard row vertical padding
  6: 20, // card padding
  7: 24, // between sections
  8: 32, // above a screen's first section, around an empty state
  9: 40,
  10: 48, // between a sheet's header and its body
  11: 64, // empty-state top offset
} as const;

export type SpaceToken = keyof typeof space;

/**
 * Nine text styles, and a tenth is a decision rather than a preference.
 *
 * `family` is resolved to a real font stack by the theme: `serif` becomes Newsreader once the
 * app has loaded it and the platform serif until then, so **text never blocks on a font**.
 */
export const type = {
  /**
   * 29/34, down from 34/38 — the size the founder's `Activity Detail Restructure` frames draw
   * their screen titles at, adopted 2026-08-13. At 34 a two-word plan title took two lines on a
   * 390 pt phone and the header ate a third of the screen before saying anything.
   *
   * Weight stays 500: the frames set 600, but `apps/mobile` loads one Newsreader weight and a
   * second is a font-loading change rather than a token one. Flagged, not silently taken.
   */
  display: {
    family: 'serif',
    size: 29,
    lineHeight: 34,
    weight: '500',
    letterSpacing: -0.4,
  },
  title: {
    family: 'serif',
    size: 24,
    lineHeight: 29,
    weight: '500',
    letterSpacing: -0.2,
  },
  /**
   * **16/21, down from 17/22 — founder, 2026-08-17.** The report was that "the screen feels
   * visually large", with the agenda row spelled out as 16 pt semibold over 13–14 pt.
   *
   * Changed on the scale rather than at the row, because §10 admits no font size that is not
   * here and a one-off `rowTitle` token would have left every other body string at the old
   * measure — the complaint was about the screen, not about one component. 17 was the iOS body
   * convention; 16 is a deliberate step away from it and reads tighter at the same line count.
   * No contrast threshold moves: 16 is still normal text at 4.5:1, well under §6.4's 19 pt bold
   * / 24 pt large-text boundary.
   */
  heading: {
    family: 'sans',
    size: 16,
    lineHeight: 21,
    weight: '600',
    letterSpacing: -0.1,
  },
  body: { family: 'sans', size: 16, lineHeight: 21, weight: '400', letterSpacing: -0.1 },
  bodyStrong: {
    family: 'sans',
    size: 16,
    lineHeight: 21,
    weight: '600',
    letterSpacing: -0.1,
  },
  subhead: { family: 'sans', size: 15, lineHeight: 20, weight: '400', letterSpacing: 0 },
  footnote: { family: 'sans', size: 13, lineHeight: 18, weight: '400', letterSpacing: 0 },
  footnoteStrong: {
    family: 'sans',
    size: 13,
    lineHeight: 18,
    weight: '600',
    letterSpacing: 0,
  },
  /** Today screen's Schedule, Anytime and Tomorrow labels. */
  sectionLabel: {
    family: 'sans',
    size: 12,
    lineHeight: 15,
    weight: '600',
    letterSpacing: 0.8,
  },
  /** Uppercase; the mock tracks its section labels wide. */
  caption: {
    family: 'sans',
    size: 11,
    lineHeight: 14,
    weight: '600',
    letterSpacing: 0.8,
  },
} as const;

export type TypeVariant = keyof typeof type;

/**
 * Only cards, sheets and the hero surface are rounded. Rows on Today are not cards and have
 * no radius — rounding everything produces the corporate-dashboard look this product avoids.
 */
export const radius = {
  none: 0,
  sm: 8, // chips, checkbox, small controls
  md: 12, // buttons, fields, icon squircles, segmented-control track
  lg: 16, // cards, the People search field
  xl: 22, // the UP NEXT card — the one hero surface
  sheet: 28, // sheets (top corners), dialogs on web
  pill: 999, // avatars, RSVP pills, filter chips, the Add button
} as const;

export type RadiusToken = keyof typeof radius;

/** Nothing exceeds 300 ms (`interaction-contract.md` §6.5). */
export const motion = {
  duration: { instant: 0, fast: 120, base: 180, switch: 180, slow: 260, max: 300 },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0, 1)',
    accelerate: 'cubic-bezier(0.3, 0, 1, 1)',
  },
  spring: { damping: 20, stiffness: 260, mass: 1 },
} as const;

export type DurationToken = keyof typeof motion.duration;

/**
 * Input-recognition and persistence quiet periods are not animation durations.
 *
 * They stay active under Reduce Motion: shortening one would turn a hold into a tap, allow a
 * physical double activation through, or increase writes while somebody is still typing.
 */
export const interactionTiming = {
  fieldAutosave: 350,
  longPress: 500,
  duplicateActivationWindow: 500,
} as const;

/**
 * Accessibility requirements, encoded as values so they are the default rather than
 * something to remember (`design-system.md` §9).
 */
export const layout = {
  /** Minimum hit target, applied unconditionally by every interactive primitive. */
  hitTarget: 44,
  /** Focus ring width. Never overridable by a prop. */
  focusRingWidth: 2,
  /** Content rows are sized by what they hold, above this floor. */
  rowMinHeight: 56,
  /** Centred destructive alerts keep a readable measure on every viewport. */
  alertDialogMaxWidth: 380,
  /**
   * **`SettingRow`'s own floor** (founder's decision, 2026-08-13). Named rather than smuggled
   * into the component as an unexplained 72.
   *
   * Two row families, two deliberate densities — not one system fighting itself. A settings
   * group is a regular configuration measure, and at the generic 56 its rhythm would be decided
   * by content length: `Repeat` alone at ~56 beside `Notes` with its summary at ~72. At 72 both
   * belong unmistakably to the same family, which is the whole benefit the gallery demonstrated.
   *
   * The number is what a two-line row needs — `subhead` 20 + `space[1]` + `footnote` 18 inside
   * `space[5]` top and bottom. **A minimum, never a fixed height**: longer content, and larger
   * text, make the row taller.
   */
  settingRowMinHeight: 72,
  switchTrackWidth: 48,
  switchTrackHeight: 28,
  switchThumbSize: 24,
  switchInset: 2,
  /** Minimum gap between adjacent interactive elements. */
  minTargetGap: space[3],
} as const;

/**
 * The three breakpoints from `tech-stack.md` §3.5. **Not extended** — a fourth is a
 * product decision, not a convenience.
 */
export const breakpoints = { compact: 0, medium: 768, expanded: 1200 } as const;

export type Breakpoint = keyof typeof breakpoints;
