import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {
  AccessibilityInfo,
  Platform,
  useColorScheme as useSystemColorScheme,
  useWindowDimensions,
} from 'react-native';
import {
  type ActivityTypeName,
  type CollectionSurfaceTone,
  type ColorScheme,
  collectionSurfaces,
  colors,
  type SemanticColors,
  type TypeAccent,
  typeAccents,
} from './colors';
import { type ElevationToken, elevation } from './elevation';
import {
  type Breakpoint,
  breakpoints,
  type DurationToken,
  layout,
  motion,
  radius,
  space,
  type TypeVariant,
  type,
} from './tokens';

/**
 * The theme, and the four hooks every primitive is built on
 * (`design-system.md` §3, §4.2, §4.3, §8, §9).
 *
 * `packages/ui` is a **leaf**: it imports no workspace package and, deliberately, nothing
 * from Expo. Font *loading* is the app's job — `apps/mobile` loads Newsreader and passes the
 * resolved family name in. Until it does, `serifFamily` falls back to the platform serif, so
 * **text never blocks on a font** and a cold start renders immediately in Georgia rather than
 * showing nothing.
 */

/** The platform's own serif, used until (and if) the app supplies Newsreader. */
const PLATFORM_SERIF = Platform.select({
  web: "Georgia, 'Times New Roman', serif",
  default: 'Georgia',
}) as string;

/** The system sans stack. The mock uses Geist; the system stack is metrically close. */
const PLATFORM_SANS = Platform.select({
  web: '-apple-system, "Segoe UI", Roboto, sans-serif',
  default: 'System',
}) as string;

export interface Theme {
  scheme: ColorScheme;
  colors: SemanticColors;
  space: typeof space;
  radius: typeof radius;
  layout: typeof layout;
  type: typeof type;
  /** Resolves a type variant to a real style, with the font family already chosen. */
  font: (variant: TypeVariant) => {
    fontFamily: string;
    fontSize: number;
    lineHeight: number;
    fontWeight: '400' | '500' | '600';
    letterSpacing: number;
  };
  /** The elevation style for the active scheme. Components never branch on the scheme. */
  elevation: (token: ElevationToken) => ReturnType<typeof elevation>;
  /** One accent per stored activity type. */
  typeAccent: (name: ActivityTypeName) => TypeAccent;
  /** Resolves §5.2a's presentation-only List-card fill. */
  collectionSurface: (tone: CollectionSurfaceTone) => string;
}

const ThemeContext = createContext<Theme | undefined>(undefined);

const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export interface ThemeProviderProps {
  children: ReactNode;
  /** Overrides the system scheme. The gallery renders both side by side with this. */
  scheme?: ColorScheme;
  /**
   * The loaded serif family — `Newsreader_500Medium` once `apps/mobile` has it. Absent means
   * the platform serif, which is what renders while the font loads.
   */
  serifFamily?: string;
}

export function ThemeProvider({ children, scheme, serifFamily }: ThemeProviderProps) {
  const system = useSystemColorScheme();
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    clientSnapshot,
    serverSnapshot,
  );
  const systemScheme: ColorScheme =
    Platform.OS === 'web' && !hydrated ? 'light' : system === 'dark' ? 'dark' : 'light';
  const active: ColorScheme = scheme ?? systemScheme;

  const value = useMemo<Theme>(() => {
    const palette = colors[active];
    const serif = serifFamily ?? PLATFORM_SERIF;

    return {
      scheme: active,
      colors: palette,
      space,
      radius,
      layout,
      type,
      font: (variant) => {
        const style = type[variant];
        return {
          fontFamily: style.family === 'serif' ? serif : PLATFORM_SANS,
          fontSize: style.size,
          lineHeight: style.lineHeight,
          fontWeight: style.weight,
          letterSpacing: style.letterSpacing,
        };
      },
      elevation: (token) => elevation(token, active, palette),
      typeAccent: (name) => typeAccents[active][name],
      collectionSurface: (tone) =>
        tone === 'neutral' ? palette.surfaceRaised : collectionSurfaces[active][tone],
    };
  }, [active, serifFamily]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * The active theme.
 *
 * Throws when there is no provider rather than falling back to a default. A silent default
 * would mean a screen rendering in light mode inside a dark app and nobody noticing until a
 * screenshot.
 */
export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (theme === undefined) {
    throw new Error('useTheme must be used inside a <ThemeProvider>.');
  }
  return theme;
}

/**
 * Which layout applies at the current width (`design-system.md` §8).
 *
 * Backed by `useWindowDimensions()`, never `Dimensions.get()` at module scope — that is
 * wrong after a rotation and wrong on a browser resize, and being wrong silently is what
 * makes it worth a rule.
 */
export function useBreakpoint(): Breakpoint {
  const { width } = useWindowDimensions();
  if (width >= breakpoints.expanded) return 'expanded';
  if (width >= breakpoints.medium) return 'medium';
  return 'compact';
}

/**
 * Motion durations, gated by the system's Reduce Motion setting.
 *
 * **Returns `0` for every duration when the setting is on**, so a component cannot animate
 * around it — there is no "should I animate" question to get wrong, only a duration that
 * happens to be zero. Swipe tracking is unaffected: direct manipulation is not decorative
 * motion and does not read this hook.
 */
export interface MotionTokens {
  /**
   * Widened from the `as const` literals on purpose: under Reduce Motion every value is
   * `0`, and a type that insisted `fast` is `120` could not express that.
   */
  duration: Record<DurationToken, number>;
  easing: typeof motion.easing;
  spring: typeof motion.spring;
  reduced: boolean;
}

const reducedMotionListeners = new Set<() => void>();
let reducedMotion = false;
let reducedMotionStarted = false;
let reducedMotionGeneration = 0;
let reducedMotionSubscription:
  | ReturnType<typeof AccessibilityInfo.addEventListener>
  | undefined;

function publishReducedMotion(enabled: boolean): void {
  if (reducedMotion === enabled) return;
  reducedMotion = enabled;
  for (const listener of reducedMotionListeners) listener();
}

function startReducedMotion(): void {
  if (reducedMotionStarted) return;
  reducedMotionStarted = true;
  const generation = ++reducedMotionGeneration;
  void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
    if (reducedMotionStarted && reducedMotionGeneration === generation) {
      publishReducedMotion(enabled);
    }
  });
  reducedMotionSubscription = AccessibilityInfo.addEventListener(
    'reduceMotionChanged',
    (enabled) => {
      if (reducedMotionStarted && reducedMotionGeneration === generation) {
        publishReducedMotion(enabled);
      }
    },
  );
}

function subscribeToReducedMotion(listener: () => void): () => void {
  reducedMotionListeners.add(listener);
  startReducedMotion();
  return () => {
    reducedMotionListeners.delete(listener);
    if (reducedMotionListeners.size > 0) return;
    reducedMotionStarted = false;
    reducedMotionGeneration += 1;
    reducedMotionSubscription?.remove?.();
    reducedMotionSubscription = undefined;
    reducedMotion = false;
  };
}

const reducedMotionSnapshot = () => reducedMotion;
const reducedMotionServerSnapshot = () => false;

export function useMotion(): MotionTokens {
  const reduced = useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    reducedMotionServerSnapshot,
  );

  return useMemo(
    () => ({
      duration: reduced
        ? { instant: 0, fast: 0, base: 0, switch: 0, slow: 0, max: 0 }
        : motion.duration,
      easing: motion.easing,
      spring: motion.spring,
      reduced,
    }),
    [reduced],
  );
}
