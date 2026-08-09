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
  display: {
    family: 'serif',
    size: 34,
    lineHeight: 38,
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
  heading: {
    family: 'sans',
    size: 17,
    lineHeight: 22,
    weight: '600',
    letterSpacing: -0.1,
  },
  body: { family: 'sans', size: 17, lineHeight: 22, weight: '400', letterSpacing: -0.1 },
  bodyStrong: {
    family: 'sans',
    size: 17,
    lineHeight: 22,
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
  duration: { instant: 0, fast: 120, base: 180, slow: 260, max: 300 },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
    decelerate: 'cubic-bezier(0, 0, 0, 1)',
    accelerate: 'cubic-bezier(0.3, 0, 1, 1)',
  },
  spring: { damping: 20, stiffness: 260, mass: 1 },
} as const;

export type DurationToken = keyof typeof motion.duration;

/**
 * Accessibility requirements, encoded as values so they are the default rather than
 * something to remember (`design-system.md` §9).
 */
export const layout = {
  /** Minimum hit target, applied unconditionally by every interactive primitive. */
  hitTarget: 44,
  /** Focus ring width. Never overridable by a prop. */
  focusRingWidth: 2,
  /** Rows are content-sized above this. Fixed-height rows do not exist. */
  rowMinHeight: 56,
  /** Minimum gap between adjacent interactive elements. */
  minTargetGap: space[3],
} as const;

/**
 * The three breakpoints from `tech-stack.md` §3.5. **Not extended** — a fourth is a
 * product decision, not a convenience.
 */
export const breakpoints = { compact: 0, medium: 768, expanded: 1200 } as const;

export type Breakpoint = keyof typeof breakpoints;
