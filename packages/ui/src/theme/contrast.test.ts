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
 * Both palettes are now founder-approved and reviewed (P2-40), so this is no longer checking a
 * derived dark set against a designed light one — it is checking that two supplied palettes
 * are used in roles they can actually carry. Where a supplied value cannot carry text, the
 * assertion says so explicitly rather than being dropped.
 */

const schemes: ColorScheme[] = ['light', 'dark'];

/**
 * The two surfaces §5.1's promise names: *"every `text*` token except `textDisabled` meets
 * AA at 4.5:1 against both `surface` and `surfaceRaised` in both schemes"*.
 */
const textSurfaces = ['surface', 'surfaceRaised'] as const;

/**
 * Every token that carries readable text.
 *
 * **`accent` is deliberately absent, and that is not a relaxation.** Under the founder-approved
 * P2-40 palettes `accent` is a fill, icon, progress and decoration colour in both schemes and
 * §5.1 states it is "never body text on `surface`". It measures 4.30:1 light and 4.00:1 dark,
 * which is exactly why it holds that role and not this one. It is asserted below at the 3:1
 * graphics bar it does have to meet. Moving it back here would not make the palette safer; it
 * would make the gate fail for a token nothing renders text in.
 *
 * `accentDeep` is light-only for the same reason in reverse: dark `accentDeep` is 4.43:1 on
 * `surfaceRaised` and 4.06:1 on `surfaceOverlay`, which is why P2-43 gave the dark text action
 * its own lifted value rather than promoting `accentDeep` into a text role. In light it is the
 * readable accent-text token at 5.4:1 and is asserted as one.
 */
const bodyTextTokens = [
  'textDisplay',
  'textPrimary',
  'textSecondary',
  'textMuted',
  'textAction',
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
 * **`textAction` on every surface it can land on** — added 2026-08-16 (P2-43).
 *
 * The two-surface matrix above is §5.1's promise, and it is not enough for this token: a text
 * action is a ghost `Button`, and ghost buttons sit inside sheets (`surfaceOverlay`), on a
 * selected row (`accentSurface`) and beside inputs (`surfaceInput`) as well as on the page. The
 * dark value was chosen to clear the gate on all five, so all five are asserted — a later
 * "simplify it back to `accentDeep`" then fails here rather than shipping a 4.06:1 label.
 */
describe.each(schemes)('%s scheme — text actions are readable anywhere', (scheme) => {
  const palette = colors[scheme];

  it.each([
    'surface',
    'surfaceRaised',
    'surfaceOverlay',
    'surfaceInput',
    'accentSurface',
  ] as const)('textAction on %s', (surface) => {
    expect(
      contrastRatio(palette.textAction, palette[surface]),
      `${scheme}: textAction (${palette.textAction}) on ${surface} (${palette[surface]}) is ${ratioOf(palette.textAction, palette[surface])}:1`,
    ).toBeGreaterThanOrEqual(AA_BODY);
  });
});

/**
 * `surfaceSunken` is not in §5.1's promise, but **text renders on it**: the rail's active
 * navigation label (§8) and the inactive labels on a `SegmentedControl` track (§6). Only the
 * two neutral inks appear there — an accent or a success figure never does — so those are
 * what is asserted, rather than every token against a surface it will never touch.
 *
 * Under the founder-approved palettes this is the tightest readable pair in the light scheme —
 * `textSecondary` on `surfaceSunken` measures 4.53:1, clearing AA by 0.03. Worth knowing before
 * anyone adjusts either value.
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
 * `textInverse` is used on a *filled* surface — an accent, sage or danger fill — never on the
 * page background, so it is measured against the fills it actually sits on.
 *
 * The filled primary control is `accentControl`, not `accent`: dark `accent` carries a label at
 * only 4.00:1, which is the entire reason `accentControl` exists.
 */
describe.each(schemes)('%s scheme — inverse text on filled surfaces', (scheme) => {
  const palette = colors[scheme];

  it.each(['accentControl', 'success', 'danger'] as const)(
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
 * Light `accentDeep` is §5.1's readable accent-text token — the colour a light text action or
 * link uses. Dark has no such token by design, so this is asserted where it applies rather
 * than waived for both.
 */
describe('light scheme — accentDeep is the readable accent text', () => {
  it.each(textSurfaces)('accentDeep on %s', (surface) => {
    const palette = colors.light;
    expect(
      contrastRatio(palette.accentDeep, palette[surface]),
      `light: accentDeep on ${surface} is ${ratioOf(palette.accentDeep, palette[surface])}:1`,
    ).toBeGreaterThanOrEqual(AA_BODY);
  });
});

/**
 * Text on `accentSurface` — the UP NEXT card, a selected row tint, an accent chip.
 *
 * Light is `textPrimary` only, on the founder's 2026-08-12 decision: `textSecondary` measures
 * 4.45:1 there, so the supplied `accentSurface` is kept exactly and the role is narrowed
 * instead. Dark carries both comfortably.
 */
describe('text on the accent surface', () => {
  it('light uses textPrimary, which clears AA', () => {
    const palette = colors.light;
    expect(
      contrastRatio(palette.textPrimary, palette.accentSurface),
      `light: textPrimary on accentSurface is ${ratioOf(palette.textPrimary, palette.accentSurface)}:1`,
    ).toBeGreaterThanOrEqual(AA_BODY);
  });

  it.each(['textPrimary', 'textSecondary'] as const)(
    'dark %s on accentSurface',
    (token) => {
      const palette = colors.dark;
      expect(
        contrastRatio(palette[token], palette.accentSurface),
        `dark: ${token} on accentSurface is ${ratioOf(palette[token], palette.accentSurface)}:1`,
      ).toBeGreaterThanOrEqual(AA_BODY);
    },
  );
});

/**
 * `surfaceInput` carries the text a user has typed and the placeholder before it, so both inks
 * that appear there are asserted. `textMuted` is the placeholder token — readable tertiary
 * content, never `textDisabled`.
 */
describe.each(schemes)('%s scheme — input surfaces carry readable text', (scheme) => {
  const palette = colors[scheme];

  it.each(['textPrimary', 'textMuted'] as const)('%s on surfaceInput', (token) => {
    expect(
      contrastRatio(palette[token], palette.surfaceInput),
      `${scheme}: ${token} on surfaceInput is ${ratioOf(palette[token], palette.surfaceInput)}:1`,
    ).toBeGreaterThanOrEqual(AA_BODY);
  });
});

/**
 * Control boundaries and focus rings are graphics, not text: AA asks 3:1. `focusRing` is
 * checked against every surface it can appear over, because a ring that vanishes on one
 * surface is a keyboard user stranded on that screen.
 */
describe.each(schemes)('%s scheme — boundaries and focus meet 3:1', (scheme) => {
  const palette = colors[scheme];

  it.each(
    (['borderStrong', 'focusRing', 'accent'] as const).flatMap((token) =>
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
  const names: ActivityTypeName[] = ['task', 'meal', 'watch', 'event', 'custom'];

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
 * `borderSubtle` and `accentBorder` are **decorative** — a field outline, a chip edge, an
 * accent-surface rim. §5.1 states neither may be the sole control boundary or focus indicator,
 * and neither reaches 3:1 to back that up.
 *
 * Asserted as an exemption rather than left unstated, so that a later change which raises one
 * of them into a real boundary is a deliberate act. If one of these ever *does* clear 3:1, this
 * test fails and the change has to be argued for, which is the point.
 */
describe('decorative outlines are decorative, and provably so', () => {
  it.each(schemes)('%s: borderSubtle cannot stand in for borderStrong', (scheme) => {
    const palette = colors[scheme];
    expect(
      contrastRatio(palette.borderSubtle, palette.surfaceRaised),
      `${scheme}: borderSubtle on surfaceRaised is ${ratioOf(palette.borderSubtle, palette.surfaceRaised)}:1`,
    ).toBeLessThan(AA_LARGE);
  });

  it.each(schemes)(
    '%s: accentBorder cannot stand in for a control boundary',
    (scheme) => {
      const palette = colors[scheme];
      expect(
        contrastRatio(palette.accentBorder, palette.accentSurface),
        `${scheme}: accentBorder on accentSurface is ${ratioOf(palette.accentBorder, palette.accentSurface)}:1`,
      ).toBeLessThan(AA_LARGE);
    },
  );
});

/**
 * The exact founder-approved values, asserted literally. A palette that drifts one hex at a
 * time is how a design system stops matching its own documentation, and the ratios above would
 * not catch a swap between two values that both pass.
 */
describe('the founder-approved palettes are exactly these values', () => {
  it('light', () => {
    expect(colors.light).toMatchObject({
      surface: '#F1EDE5',
      surfaceRaised: '#F8F5EF',
      surfaceRaised2: '#FCFAF6',
      surfaceOverlay: '#FCFAF6',
      surfaceInput: '#F0EBE3',
      surfaceSunken: '#ECE7DE',
      textDisplay: '#292621',
      textPrimary: '#292621',
      textSecondary: '#6E675F',
      textMuted: '#6E675F',
      textDisabled: '#978F84',
      textInverse: '#FFFDF9',
      border: '#E1DAD0',
      borderSubtle: '#D3C9BC',
      borderStrong: '#6E675F',
      accent: '#8B6374',
      accentDeep: '#795565',
      accentSurface: '#EEE3E7',
      accentBorder: '#C7AAB6',
      accentControl: '#8B6374',
      // Darkened from the supplied `#667747` on the founder's 2026-08-12 decision; sage
      // carries a balance figure and measured 4.19:1 against the new background.
      success: '#616F45',
      focusRing: '#795565',
    });
  });

  it('dark', () => {
    expect(colors.dark).toMatchObject({
      surface: '#171613',
      surfaceRaised: '#211F1B',
      surfaceRaised2: '#292620',
      surfaceOverlay: '#292620',
      surfaceInput: '#1C1B18',
      surfaceSunken: '#1C1B18',
      textDisplay: '#F4F0E8',
      textPrimary: '#F4F0E8',
      textSecondary: '#D0C9BE',
      textMuted: '#9F988D',
      textInverse: '#171613',
      border: '#34312B',
      borderStrong: '#9F988D',
      accent: '#9F667F',
      accentDeep: '#AD748C',
      accentSurface: '#2D2026',
      accentBorder: '#5A3A49',
      accentControl: '#AD748C',
      success: '#A7B690',
      successSurface: '#252A20',
      warning: '#E3C07A',
      warningSurface: '#332B1C',
      focusRing: '#9F667F',
    });
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
    expect(ratioOf(colors.light.textDisplay, colors.light.surface)).toBeCloseTo(12.9, 0);
    expect(ratioOf(colors.light.textSecondary, colors.light.surface)).toBeCloseTo(4.8, 0);
    expect(ratioOf(colors.dark.textMuted, colors.dark.surface)).toBeCloseTo(6.3, 0);
    // Published as the reason `accent` is not a text token in either scheme.
    expect(ratioOf(colors.light.accent, colors.light.surface)).toBeCloseTo(4.3, 0);
    expect(ratioOf(colors.dark.accent, colors.dark.surface)).toBeCloseTo(4.0, 0);
  });

  it('rejects a colour it cannot parse rather than scoring it', () => {
    expect(() => parseColor('rebeccapurple')).toThrow(/Cannot parse colour/);
  });
});
