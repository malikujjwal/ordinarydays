import type { ViewStyle } from 'react-native';
import type { ColorScheme, SemanticColors } from './colors';

/**
 * Elevation (`design-system.md` §4.2).
 *
 * > **In dark mode, elevation is expressed as surface lightening plus a 1 px border, not as
 * > a shadow.** A shadow on a near-black background is invisible, so a dark UI that relies on
 * > shadows loses all depth cues entirely.
 *
 * `elevation()` returns the right style for the active scheme, so a component asks for `e2`
 * and **never branches on the scheme itself**. That is the point of the helper: there is no
 * `isDark` in any primitive.
 */

export type ElevationToken = 'e0' | 'e1' | 'e2' | 'e3' | 'e4';

/**
 * Light shadows, from the mock: soft, large-blur, negative-spread, in warm ink. Never harsh.
 *
 * Expressed as web `boxShadow` strings. React Native Web compiles `boxShadow` directly; on
 * iOS these become the `shadow*` props below, because RN's shadow model cannot express a
 * negative spread and the closest equivalent is what iOS gets.
 */
const webShadow: Record<ElevationToken, string> = {
  e0: 'none',
  e1: '0 1px 2px rgba(38,42,40,0.05)',
  e2: '0 1px 2px rgba(38,42,40,0.05), 0 10px 24px -16px rgba(38,42,40,0.28)',
  e3: '0 10px 30px -12px rgba(38,42,40,0.35)',
  e4: '0 12px 30px -14px rgba(38,42,40,0.45)',
};

/**
 * The UP NEXT card's mulberry-tinted `e3`. Defined separately because it is the one surface
 * in the product that gets a coloured shadow.
 */
export const upNextShadow =
  '0 1px 2px rgba(38,42,40,0.04), 0 12px 24px -20px rgba(90,50,72,0.55)';

/**
 * The filled `primary` Button's accent glow. Defined once and **used nowhere else** — it is
 * what makes the one primary action on a screen feel like the one primary action.
 *
 * Tracks the founder-approved light `accent` `#8B6374` (P2-40). A shadow is not a semantic
 * token and stays one value across schemes; it reads as a soft mulberry lift under either
 * `accentControl` fill.
 */
export const accentGlow = '0 8px 18px -8px rgba(139,99,116,0.85)';

/** iOS shadow equivalents, approximating the same soft falloff. */
const nativeShadow: Record<ElevationToken, ViewStyle> = {
  e0: {},
  e1: {
    shadowColor: '#262A28',
    shadowOpacity: 0.05,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
  },
  e2: {
    shadowColor: '#262A28',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  e3: {
    shadowColor: '#262A28',
    shadowOpacity: 0.18,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
  },
  e4: {
    shadowColor: '#262A28',
    shadowOpacity: 0.22,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
  },
};

/**
 * In dark mode each level maps to a lighter surface plus a hairline, per the decision above.
 * The surface is returned as `backgroundColor` so a `Card` gets its depth for free.
 */
function darkElevation(token: ElevationToken, palette: SemanticColors): ViewStyle {
  switch (token) {
    case 'e0':
      return {};
    case 'e1':
      return { backgroundColor: palette.surfaceRaised };
    case 'e2':
      return {
        backgroundColor: palette.surfaceRaised2,
        borderWidth: 1,
        borderColor: palette.border,
      };
    case 'e3':
    case 'e4':
      return {
        backgroundColor: palette.surfaceOverlay,
        borderWidth: 1,
        borderColor: palette.border,
      };
  }
}

/**
 * The style for an elevation level in the active scheme.
 *
 * @param token the level a component asked for
 * @param scheme the active scheme
 * @param palette that scheme's semantic colours
 */
export function elevation(
  token: ElevationToken,
  scheme: ColorScheme,
  palette: SemanticColors,
): ViewStyle {
  if (scheme === 'dark') return darkElevation(token, palette);
  if (token === 'e0') return {};

  // `boxShadow` is a valid RNW style and is typed on `ViewStyle` in recent RN; the cast
  // keeps it honest on the native typings, where the `shadow*` props below are what apply.
  return {
    ...nativeShadow[token],
    ...({ boxShadow: webShadow[token] } as ViewStyle),
  };
}
