/**
 * WCAG 2.1 relative luminance and contrast ratio.
 *
 * Lives in `src/` rather than in the test file because the contrast gate is a **product
 * requirement**, not a testing convenience: `design-system.md` §5.1 promises that every text
 * token meets AA against both surfaces in both schemes and that a token change breaking it
 * fails CI. A helper that only existed inside a test could not also be used by the token
 * gallery, which shows the measured ratio beside every swatch so a human reviewing the
 * derived dark values sees the number rather than trusting the table.
 */

/** WCAG AA for body text. */
export const AA_BODY = 4.5;

/** WCAG AA for large text (≥ 18.66 pt bold or ≥ 24 pt) and for graphics and UI boundaries. */
export const AA_LARGE = 3;

interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Parses `#RRGGBB` and `rgba(r,g,b,a)` — the two forms the palette uses.
 *
 * Throws rather than returning a default: a token this cannot read is a token the gate would
 * silently stop checking, which is worse than a failing build.
 */
export function parseColor(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex?.[1] !== undefined) {
    const int = Number.parseInt(hex[1], 16);
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255, a: 1 };
  }

  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    value.trim(),
  );
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }

  throw new Error(`Cannot parse colour "${value}". Expected #RRGGBB or rgba(...).`);
}

/** Composites a possibly-translucent colour over an opaque one. */
export function flatten(foreground: string, background: string): Rgb {
  const fg = parseColor(foreground);
  if (fg.a === 1) return fg;

  const bg = parseColor(background);
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

/** WCAG relative luminance. */
function luminance({ r, g, b }: Rgb): number {
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/**
 * The contrast ratio between two colours, 1–21.
 *
 * A translucent foreground is composited over the background first, which matters for
 * `scrim` and is the difference between a number that is true and one that is optimistic.
 */
export function contrastRatio(foreground: string, background: string): number {
  const fg = luminance(flatten(foreground, background));
  const bg = luminance(parseColor(background));
  const [lighter, darker] = fg > bg ? [fg, bg] : [bg, fg];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Rounded to one decimal, the way the design system's table quotes it. */
export const ratioOf = (foreground: string, background: string): number =>
  Math.round(contrastRatio(foreground, background) * 10) / 10;
