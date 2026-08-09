import { describe, expect, it } from 'vitest';
import { type ActivityTypeName, type ColorScheme, colors, typeAccents } from './colors';
import { AA_BODY, AA_LARGE, contrastRatio, parseColor, ratioOf } from './contrast';

/**
 * **The CI gate behind `design-system.md` §5.1's promise.**
 *
 * The design system states that every `text*` token except `textDisabled` meets AA at 4.5:1
 * against both `surface` and `surfaceRaised` in both schemes, and that every control boundary
 * meets 3:1. This asserts it programmatically over **every pair**, so a token change that
 * breaks AA fails the build rather than shipping.
 *
 * It matters most for the dark values, which §5.1 says are **derived, not designed**. A
 * derived palette that was never measured is a palette that is wrong somewhere, and this is
 * what finds where.
 */

const schemes: ColorScheme[] = ['light', 'dark'];

/**
 * The two surfaces §5.1's promise names: *"every `text*` token except `textDisabled` meets
 * AA at 4.5:1 against both `surface` and `surfaceRaised` in both schemes"*.
 */
const textSurfaces = ['surface', 'surfaceRaised'] as const;

/** Every token that carries readable text, and the one exemption. */
const bodyTextTokens = [
  'textDisplay',
  'textPrimary',
  'textSecondary',
  'accent',
  'accentDeep',
  'success',
  'warning',
  'danger',
] as const;

describe.each(schemes)('%s scheme — body text meets AA 4.5:1', (scheme) => {
  const palette = colors[scheme];

  it.each(
    bodyTextTokens.flatMap((token) =>
      textSurfaces.map((surface) => [token, surface] as const),
    ),
  )('%s on %s', (token, surface) => {
    const ratio = contrastRatio(palette[token], palette[surface]);
    expect(
      ratio,
      `${scheme}: ${token} (${palette[token]}) on ${surface} (${palette[surface]}) is ${ratioOf(palette[token], palette[surface])}:1`,
    ).toBeGreaterThanOrEqual(AA_BODY);
  });
});

/**
 * `surfaceSunken` is not in §5.1's promise, but **text renders on it**: the rail's active
 * navigation label (§8) and the inactive labels on a `SegmentedControl` track (§6). Only the
 * two neutral inks appear there — an accent or a success figure never does — so those are
 * what is asserted, rather than every token against a surface it will never touch.
 *
 * This pair is why the light `surfaceSunken` was nudged: at the mock's `#F1EEE5`,
 * `textSecondary` measured 4.48:1.
 */
describe.each(schemes)('%s scheme — the sunken surface carries text too', (scheme) => {
  const palette = colors[scheme];

  it.each(['textPrimary', 'textSecondary'] as const)('%s on surfaceSunken', (token) => {
    const ratio = contrastRatio(palette[token], palette.surfaceSunken);
    expect(
      ratio,
      `${scheme}: ${token} on surfaceSunken is ${ratioOf(palette[token], palette.surfaceSunken)}:1`,
    ).toBeGreaterThanOrEqual(AA_BODY);
  });
});

/**
 * `textInverse` is used on a *filled* surface — an accent, olive or danger fill — never on
 * the page background, so it is measured against the fills it actually sits on.
 */
describe.each(schemes)('%s scheme — inverse text on filled surfaces', (scheme) => {
  const palette = colors[scheme];

  it.each(['accent', 'accentDeep', 'success', 'danger'] as const)(
    'textInverse on %s',
    (fill) => {
      const ratio = contrastRatio(palette.textInverse, palette[fill]);
      expect(
        ratio,
        `${scheme}: textInverse on ${fill} is ${ratioOf(palette.textInverse, palette[fill])}:1`,
      ).toBeGreaterThanOrEqual(AA_BODY);
    },
  );
});

/**
 * Control boundaries and focus rings are graphics, not text: AA asks 3:1. `focusRing` is
 * checked against every surface it can appear over, because a ring that vanishes on one
 * surface is a keyboard user stranded on that screen.
 */
describe.each(schemes)('%s scheme — boundaries and focus meet 3:1', (scheme) => {
  const palette = colors[scheme];

  it.each(
    (['borderStrong', 'focusRing'] as const).flatMap((token) =>
      textSurfaces.map((surface) => [token, surface] as const),
    ),
  )('%s on %s', (token, surface) => {
    const ratio = contrastRatio(palette[token], palette[surface]);
    expect(
      ratio,
      `${scheme}: ${token} on ${surface} is ${ratioOf(palette[token], palette[surface])}:1`,
    ).toBeGreaterThanOrEqual(AA_LARGE);
  });
});

/**
 * Type accents render as a 16 pt marker and a 24 pt squircle glyph — graphics, so 3:1. The
 * design system marks `custom` explicitly as large-glyph only at 4.4:1, which is exactly
 * this rule and exactly why the threshold here is not 4.5.
 */
describe.each(schemes)('%s scheme — type accents meet 3:1 as glyphs', (scheme) => {
  const names: ActivityTypeName[] = [
    'task',
    'meal',
    'watch',
    'event',
    'outing',
    'custom',
  ];

  it.each(names)('%s accent on its own surface tint', (name) => {
    const { accent, surface } = typeAccents[scheme][name];
    expect(
      contrastRatio(accent, surface),
      `${scheme}: ${name} accent ${accent} on ${surface} is ${ratioOf(accent, surface)}:1`,
    ).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it.each(names)('%s accent on the page surface', (name) => {
    const { accent } = typeAccents[scheme][name];
    const page = colors[scheme].surface;
    expect(
      contrastRatio(accent, page),
      `${scheme}: ${name} accent ${accent} on surface is ${ratioOf(accent, page)}:1`,
    ).toBeGreaterThanOrEqual(AA_LARGE);
  });
});

/**
 * `textDisabled` is **exempt** from AA — disabled controls are, and disabled state is never
 * the sole carrier of meaning. Asserted as an exemption rather than left unstated, so that
 * raising it to pass the gate is a deliberate act and not an accident.
 */
describe('the stated exemption', () => {
  it.each(schemes)('%s: textDisabled is below AA, and that is intended', (scheme) => {
    const palette = colors[scheme];
    expect(contrastRatio(palette.textDisabled, palette.surface)).toBeLessThan(AA_BODY);
  });
});

/**
 * The scrim is translucent, so its effective contrast depends on what is behind it. Checking
 * it composited is the difference between a true number and an optimistic one.
 */
describe('translucent tokens are measured composited, not raw', () => {
  it.each(schemes)('%s: the scrim darkens the surface behind it', (scheme) => {
    const palette = colors[scheme];
    const ratio = contrastRatio(palette.scrim, palette.surface);
    expect(ratio).toBeGreaterThan(1);
  });
});

describe('the ratio maths itself', () => {
  it('is 21:1 for black on white and 1:1 for a colour on itself', () => {
    expect(ratioOf('#000000', '#FFFFFF')).toBe(21);
    expect(ratioOf('#965D78', '#965D78')).toBe(1);
  });

  it('is symmetric', () => {
    expect(ratioOf('#4A4841', '#FBF9F3')).toBe(ratioOf('#FBF9F3', '#4A4841'));
  });

  it('agrees with the figures quoted in design-system.md §5.1', () => {
    // Spot-checks against the published table, so a nudge to a token that silently changed
    // its documented ratio shows up here as well as in the gate above.
    expect(ratioOf(colors.light.textDisplay, colors.light.surface)).toBeCloseTo(14.6, 0);
    expect(ratioOf(colors.light.textSecondary, colors.light.surface)).toBeCloseTo(4.9, 0);
    expect(ratioOf(colors.light.accent, colors.light.surface)).toBeCloseTo(4.8, 0);
  });

  it('rejects a colour it cannot parse rather than scoring it', () => {
    expect(() => parseColor('rebeccapurple')).toThrow(/Cannot parse colour/);
  });
});
