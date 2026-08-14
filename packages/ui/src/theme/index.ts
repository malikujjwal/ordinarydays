/**
 * The theme's public surface.
 *
 * The colour **ramps** are deliberately absent: `colors.ts` exports only the semantic tokens,
 * so a component cannot reach a raw hex through this barrel. That is the first of the four
 * enforcement mechanisms in `design-system.md` §10.
 */
export {
  type ActivityTypeName,
  avatarTint,
  type ColorScheme,
  colors,
  type SemanticColors,
  type TypeAccent,
  typeAccents,
} from './colors';
export {
  type ElevationToken,
  eFloatingAction,
  elevation,
  upNextShadow,
} from './elevation';
export { useKeyboardInset } from './keyboard';
export { useScrollToFocusedInput } from './scrollToFocused';
export {
  type Theme,
  ThemeProvider,
  type ThemeProviderProps,
  useBreakpoint,
  useMotion,
  useTheme,
} from './ThemeProvider';
export {
  type Breakpoint,
  breakpoints,
  type DurationToken,
  layout,
  motion,
  type RadiusToken,
  radius,
  type SpaceToken,
  space,
  type TypeVariant,
  type,
} from './tokens';
